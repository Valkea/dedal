// Memoised views over the store that several components share.

import { useMemo } from 'react';
import { diffGhosts, diffMarks, diffSchemas } from '../analysis/diff';
import { hopDistances, shortestPath } from '../analysis/graph';
import { lintSchema } from '../analysis/lint';
import { CARD_W, cardHeight } from '../layout/geometry';
import { portalHubs, useStore, type Hub } from './store';

export function useIssues() {
  const schema = useStore((s) => s.schema);
  return useMemo(() => lintSchema(schema), [schema]);
}

/** The comparison from the older schema to the newer: the loaded one is the older unless swapped. */
export function useDiff() {
  const schema = useStore((s) => s.schema);
  const base = useStore((s) => s.diffBase);
  return useMemo(() => (base ? (base.newer ? diffSchemas(schema, base.schema) : diffSchemas(base.schema, schema)) : null), [schema, base]);
}

/** The comparison's changes keyed by ids of the schema on the canvas, whichever side of it that is. */
export function useDiffMarks() {
  const diff = useDiff();
  const newer = useStore((s) => !!s.diffBase?.newer);
  return useMemo(() => (diff ? diffMarks(diff, newer ? 'base' : 'current') : null), [diff, newer]);
}

/**
 * Tables of the loaded version that the drawing lacks (new ones, or removed ones when the drawing
 * is the newer), shown as ghost cards outside any group: in a column right of the drawing, or where dragged.
 */
export function useDiffGhosts() {
  const diff = useDiff();
  const schema = useStore((s) => s.schema);
  const base = useStore((s) => s.diffBase);
  const moved = useStore((s) => s.ghostPos);
  const auto = useMemo(() => {
    if (!diff || !base) return null;
    const g = diffGhosts(diff, schema, base.schema, base.newer ? 'current' : 'base');
    if (!g.tables.length) return null;
    const spots = new Map<string, { x: number; y: number }>();
    const x = schema.tables.length ? Math.max(...schema.tables.map((t) => t.x)) + CARD_W + 160 : 0;
    let y = schema.tables.length ? Math.min(...schema.tables.map((t) => t.y)) : 0;
    for (const t of g.tables) {
      spots.set(t.id, { x, y });
      y += cardHeight(t, base.schema) + 48;
    }
    return { g, spots };
  }, [diff, base, schema]);
  return useMemo(() => {
    if (!auto || !base) return null;
    const { g, spots } = auto;
    const placed = new Map<string, (typeof g.tables)[number]>();
    for (const t of g.tables) placed.set(t.id, { ...t, ...spots.get(t.id)!, ...moved[t.id], groupId: undefined });
    const at = (e: (typeof g.relations)[number]['from']) => (e.ghost ? { ...e, table: placed.get(e.table.id)! } : e);
    return {
      ...g,
      schema: base.schema,
      tables: [...placed.values()],
      relations: g.relations.map((r) => ({ ...r, from: at(r.from), to: at(r.to) })),
    };
  }, [auto, base, moved]);
}

/** Portal hubs of the Atlas view (none elsewhere), keyed by table id. */
export function useHubs() {
  const schema = useStore((s) => s.schema);
  const portals = useStore((s) => s.portals);
  const threshold = useStore((s) => s.hubThreshold);
  const view = schema.view ?? 'atlas';
  return useMemo(() => (view === 'atlas' ? portalHubs(schema, portals, threshold) : new Map<string, Hub>()), [schema, portals, threshold, view]);
}

/** Relations drawn as portals rather than lines. */
export function useHidden() {
  const schema = useStore((s) => s.schema);
  const hubs = useHubs();
  return useMemo(() => new Set(schema.relations.filter((r) => hubs.has(r.to.table)).map((r) => r.id)), [schema, hubs]);
}

export function usePath() {
  const schema = useStore((s) => s.schema);
  const { a, b } = useStore((s) => s.path);
  return useMemo(() => {
    if (!a || !b) return null;
    const rels = shortestPath(schema, a, b);
    if (!rels) return { rels: null, tables: new Set<string>(), relIds: new Set<string>() };
    const tables = new Set<string>([a, b]);
    for (const r of rels) {
      tables.add(r.from.table);
      tables.add(r.to.table);
    }
    return { rels, tables, relIds: new Set(rels.map((r) => r.id)) };
  }, [schema, a, b]);
}

/** The constellation always looks through the lens: its rings already show distance, so only the reach is a choice there. */
export const lensEnabled = (s: { focus: { enabled: boolean }; schema: { view?: string } }) => s.focus.enabled || s.schema.view === 'constellation';

/** Tables visible under the focus lens and their hop distance, centred on the selected table or, with none, the hovered one (null = lens off). */
export function useLens(hover: string | null) {
  const schema = useStore((s) => s.schema);
  const hops = useStore((s) => s.focus.hops);
  const enabled = useStore(lensEnabled);
  const sel = useStore((s) => s.selection);
  const center = sel?.kind === 'table' ? sel.id : hover;
  return useMemo(() => {
    if (!enabled || !center) return null;
    const dist = hopDistances(schema, center);
    return new Map([...dist].filter(([, d]) => d <= hops));
  }, [schema, enabled, hops, center]);
}
