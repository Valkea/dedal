import { existsSync, readFileSync } from 'node:fs';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { diffGhosts, diffMarks, diffSchemas, migrationSql } from '../src/analysis/diff';
import { joinSql, shortestPath } from '../src/analysis/graph';
import { lintSchema } from '../src/analysis/lint';
import { CARD_W, cardHeight } from '../src/layout/geometry';
import { placeGhosts } from '../src/layout/ghosts';
import { generateSql } from '../src/sql/generator';
import { applyLayout } from '../src/sql/layoutMeta';
import { parseSql } from '../src/sql/parser';

// private reference schemas, not in the repo: SCHEMA_DIR=/path/to/dir with schema-v14.sql and schema-v15.sql
const DOCS = process.env.SCHEMA_DIR ?? '.missing';
const has = existsSync(`${DOCS}/schema-v15.sql`) && existsSync(`${DOCS}/schema-v14.sql`);
const load = (v: number) => parseSql(readFileSync(`${DOCS}/schema-v${v}.sql`, 'utf8')).schema;
const byRule = (s: ReturnType<typeof load>) => {
  const m: Record<string, number> = {};
  for (const i of lintSchema(s)) m[i.rule] = (m[i.rule] ?? 0) + 1;
  return m;
};

describe('lint', () => {
  it('flags type problems on a small schema', () => {
    const { schema } = parseSql(`
      CREATE TABLE a (id bigint PRIMARY KEY, path ltree);
      CREATE TABLE b (id serial PRIMARY KEY, a_id integer REFERENCES a, note text);
      CREATE TABLE c (x int);
    `);
    const rules = byRule(schema);
    expect(rules['missing-extension']).toBe(1);
    expect(rules['fk-type-mismatch']).toBe(1);
    expect(rules['fk-missing-index']).toBe(1);
    expect(rules['no-primary-key']).toBe(1);
    expect(rules['orphan-table']).toBe(1);
    const fixed = produce(schema, (d) => lintSchema(schema).forEach((i) => i.fix?.apply(d)));
    expect(fixed.extensions.map((e) => e.name)).toEqual(['ltree']);
    expect(fixed.tables[1].indexes.map((i) => i.columns)).toEqual([['a_id']]);
  });

  it.runIf(has)('finds the known issues in the reference schema and the quick fixes clear them', () => {
    const s = load(15);
    const rules = byRule(s);
    expect(rules['fk-missing-index']).toBe(22);
    expect(rules['redundant-index']).toBe(8);
    expect(rules['double-escaped-comment']).toBe(10);
    expect(rules['fk-type-mismatch']).toBeUndefined();
    const fixed = produce(s, (d) => lintSchema(s).filter((i) => i.rule !== 'mixed-case').forEach((i) => i.fix?.apply(d)));
    const after = byRule(fixed);
    expect(after['fk-missing-index']).toBeUndefined();
    expect(after['redundant-index']).toBeUndefined();
    expect(after['double-escaped-comment']).toBeUndefined();
  });
});

describe('diff marks', () => {
  const older = parseSql(`
    CREATE TABLE a (id int PRIMARY KEY, gone text, kept text);
    CREATE TABLE old_only (id int PRIMARY KEY, a_id int REFERENCES a);
  `).schema;
  const newer = parseSql(`
    CREATE TABLE a (id int PRIMARY KEY, kept varchar(9), fresh text, more text);
    CREATE TABLE new_only (id int PRIMARY KEY, a_id int REFERENCES a);
  `).schema;
  const d = diffSchemas(older, newer);
  const names = (s: typeof older, ids: Map<string, string>) => {
    const out: string[] = [];
    for (const [id, kind] of ids) {
      const t = s.tables.find((x) => x.id === id);
      const c = s.tables.flatMap((x) => x.columns.map((col) => [x, col] as const)).find(([, col]) => col.id === id);
      out.push(`${kind}:${t ? t.name : `${c![0].name}.${c![1].name}`}`);
    }
    return out.sort();
  };

  it('marks the newer side with what was added and changed', () => {
    const m = diffMarks(d, 'current');
    expect(names(newer, m.tables)).toEqual(['added:new_only', 'changed:a']);
    expect(names(newer, m.columns)).toEqual(['added:a.fresh', 'added:a.more', 'changed:a.kept']);
    expect([...m.relations.values()]).toEqual(['added']);
    expect(newer.relations.some((r) => m.relations.has(r.id))).toBe(true);
    expect(m.absentCols.get(newer.tables[0].id)).toEqual({ kind: 'removed', count: 1 });
  });

  it('marks the older side with what was removed and changed, when the drawing is the older one', () => {
    const m = diffMarks(d, 'base');
    expect(names(older, m.tables)).toEqual(['changed:a', 'removed:old_only']);
    expect(names(older, m.columns)).toEqual(['changed:a.kept', 'removed:a.gone']);
    expect([...m.relations.values()]).toEqual(['removed']);
    expect(older.relations.some((r) => m.relations.has(r.id))).toBe(true);
    expect(m.absentCols.get(older.tables[0].id)).toEqual({ kind: 'added', count: 2 });
  });

  it('gives the tables only the compared version has, with their foreign keys tied to the drawn tables', () => {
    // drawing = older, compared = newer: new_only is missing from the drawing
    const g = diffGhosts(d, older, newer, 'current');
    expect(g.kind).toBe('added');
    expect(g.tables.map((t) => t.name)).toEqual(['new_only']);
    expect(g.relations.map((r) => `${r.from.ghost ? 'ghost ' : ''}${r.from.table.name}.${r.from.column?.name} → ${r.to.ghost ? 'ghost ' : ''}${r.to.table.name}.${r.to.column?.name}`)).toEqual([
      'ghost new_only.a_id → a.id',
    ]);
    expect(g.relations[0].to.table).toBe(older.tables[0]);
    // drawing = newer, compared = older: old_only is missing from it
    const r = diffGhosts(d, newer, older, 'base');
    expect(r.kind).toBe('removed');
    expect(r.tables.map((t) => t.name)).toEqual(['old_only']);
    expect(r.relations[0].to.table).toBe(newer.tables[0]);
  });
});

describe('ghost placement', () => {
  // two groups side by side: a, b on the left; x, y on the right
  const older = parseSql(`
    CREATE TABLE a (id int PRIMARY KEY);
    CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a);
    CREATE TABLE x (id int PRIMARY KEY);
    CREATE TABLE y (id int PRIMARY KEY, x_id int REFERENCES x);
  `).schema;
  older.groups = [
    { id: 'g1', name: 'Left', color: '#f00' },
    { id: 'g2', name: 'Right', color: '#0f0' },
  ];
  const at = { a: [0, 0, 'g1'], b: [0, 300, 'g1'], x: [1200, 0, 'g2'], y: [1200, 300, 'g2'] } as const;
  for (const t of older.tables) [t.x, t.y, t.groupId] = at[t.name as keyof typeof at];
  const newer = parseSql(`
    CREATE TABLE a (id int PRIMARY KEY);
    CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a);
    CREATE TABLE x (id int PRIMARY KEY);
    CREATE TABLE y (id int PRIMARY KEY, x_id int REFERENCES x);
    CREATE TABLE b_notes (id int PRIMARY KEY, b_id int REFERENCES b);
    CREATE TABLE b_note_tags (id int PRIMARY KEY, note_id int REFERENCES b_notes);
    CREATE TABLE loose (id int PRIMARY KEY);
  `).schema;
  const g = diffGhosts(diffSchemas(older, newer), older, newer, 'current');
  const spots = placeGhosts(older, newer, g);
  const byName = (n: string) => spots.get(newer.tables.find((t) => t.name === n)!.id)!;

  it('puts a new table in the group of the tables it links to, and its own new links with it', () => {
    expect(byName('b_notes').groupId).toBe('g1');
    expect(byName('b_note_tags').groupId).toBe('g1');
    expect(byName('loose').groupId).toBeUndefined();
  });

  it('next to them, without covering any card', () => {
    const rects = [
      ...older.tables.map((t) => ({ x: t.x, y: t.y, h: cardHeight(t, older) })),
      ...g.tables.map((t) => ({ ...spots.get(t.id)!, h: cardHeight(t, newer) })),
    ];
    for (const [i, r] of rects.entries())
      for (const o of rects.slice(i + 1)) expect(r.x < o.x + CARD_W && o.x < r.x + CARD_W && r.y < o.y + o.h && o.y < r.y + r.h).toBe(false);
    // closer to its group than to the other one
    expect(byName('b_notes').x).toBeLessThan(600);
  });
});

describe.runIf(has)('diff + migration v14 → v15', () => {
  it('reports exactly what changed', () => {
    const v14 = load(14);
    const v15 = load(15);
    const d = diffSchemas(v14, v15);
    expect(d.tables.map((t) => `${t.kind}:${t.name}`)).toEqual(['added:model_licenses', 'changed:models']);
    expect(d.tables[1].columns.map((c) => `${c.kind}:${c.name}`)).toEqual(['added:weights_access', 'added:license_id']);
    expect(d.enums.map((e) => `${e.kind}:${e.name}`)).toEqual(['added:ENUM_WEIGHTS_ACCESS']);
    expect(d.relationsAdded.map((r) => r.sig)).toEqual(['models(license_id) → model_licenses(id)']);
    const sql = migrationSql(v14, v15, d);
    expect(sql).toContain('CREATE TYPE "ENUM_WEIGHTS_ACCESS"');
    expect(sql).toContain('CREATE TABLE model_licenses');
    expect(sql).toContain('ALTER TABLE models ADD COLUMN weights_access "ENUM_WEIGHTS_ACCESS";');
    expect(sql).toContain('ALTER TABLE models ADD FOREIGN KEY (license_id) REFERENCES model_licenses (id);');
    // applying the migration on top of v14 must give v15 back
    const migrated = parseSql(`${readFileSync(`${DOCS}/schema-v14.sql`, 'utf8')}\n${sql}`);
    expect(migrated.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    expect(diffSchemas(migrated.schema, v15).count).toBe(0);
  });

  it('is empty when nothing changed', () => {
    const v15 = load(15);
    expect(diffSchemas(v15, load(15)).count).toBe(0);
  });
});

describe.runIf(has)('graph', () => {
  it('builds the join between distant tables', () => {
    const s = load(15);
    const id = (n: string) => s.tables.find((t) => t.name === n)!.id;
    const path = shortestPath(s, id('output_judgements'), id('categories'))!;
    expect(path).toHaveLength(4);
    expect(joinSql(s, id('output_judgements'), path)).toContain('JOIN categories c ON c.id = s.category_id');
  });

  it('keeps layout through a SQL download / re-open', () => {
    const s = load(15);
    s.tables[0].x = 1234;
    s.tables[0].locked = true;
    s.groups = [{ id: 'g1', name: 'Core', color: '#7c9cff' }];
    s.tables[1].groupId = 'g1';
    s.notes = [{ id: 'n1', text: 'hello', x: 1, y: 2, w: 200, h: 100, color: '#fde68a', attachedTo: s.tables[1].id }];
    const back = parseSql(generateSql(s, { embedLayout: true }));
    expect(applyLayout(back.schema, back.layoutBlob!)).toBe(true);
    expect(back.schema.tables[0]).toMatchObject({ x: 1234, locked: true });
    expect(back.schema.tables[1].groupId).toBe('g1');
    expect(back.schema.notes[0].attachedTo).toBe(back.schema.tables[1].id);
  });
});
