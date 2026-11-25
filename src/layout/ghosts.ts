// Where to show the tables only the compared version has (see diffGhosts): in the group of the
// drawing they belong with, in a free spot next to the tables they link to, like a regular member.

import type { DiffGhosts } from '../analysis/diff';
import type { Schema, Table } from '../model/types';
import { CARD_W, cardHeight } from './geometry';
import { regionFrame } from './routing';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 48;

const overlaps = (a: Rect, b: Rect, margin: number) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

/** The most frequent defined value, if any. */
function vote(ids: (string | undefined)[]): string | undefined {
  const n = new Map<string, number>();
  for (const id of ids) if (id) n.set(id, (n.get(id) ?? 0) + 1);
  let best: string | undefined;
  for (const [id, c] of n) if (!best || c > n.get(best)!) best = id;
  return best;
}

/**
 * Group of each ghost table: the loaded file's own group when the drawing has a group of that name,
 * else the group most of the drawn tables it links to are in, else the one of the ghosts it links to.
 */
function ghostGroups(drawn: Schema, other: Schema, g: DiffGhosts): Map<string, string> {
  const byName = new Map(drawn.groups.map((x) => [x.name.toLowerCase(), x.id]));
  const otherName = new Map(other.groups.map((x) => [x.id, x.name.toLowerCase()]));
  const linked = new Map<string, Table[]>(); // ghost id → drawn tables it links to
  const ghostLinks = new Map<string, string[]>(); // ghost id → ghosts it links to
  for (const { from, to } of g.relations) {
    for (const [a, b] of [[from, to], [to, from]]) {
      if (!a.ghost) continue;
      if (b.ghost) ghostLinks.set(a.table.id, [...(ghostLinks.get(a.table.id) ?? []), b.table.id]);
      else linked.set(a.table.id, [...(linked.get(a.table.id) ?? []), b.table]);
    }
  }
  const out = new Map<string, string>();
  for (const t of g.tables) {
    const gid = (t.groupId && byName.get(otherName.get(t.groupId) ?? '')) || vote((linked.get(t.id) ?? []).map((x) => x.groupId));
    if (gid) out.set(t.id, gid);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const t of g.tables) {
      if (out.has(t.id)) continue;
      const gid = vote((ghostLinks.get(t.id) ?? []).map((id) => out.get(id)));
      if (gid) out.set(t.id, gid);
    }
  }
  return out;
}

/**
 * Position and group of each ghost table. A ghost goes in the free spot beside or under its group's
 * tables that is nearest the tables it links to, where the grown group frame keeps clear of the
 * other groups; without a group, or without room, it goes in a column right of the drawing.
 */
export function placeGhosts(drawn: Schema, other: Schema, g: DiffGhosts): Map<string, { x: number; y: number; groupId?: string }> {
  const groups = ghostGroups(drawn, other, g);
  const rects: Rect[] = drawn.tables.map((t) => ({ x: t.x, y: t.y, w: CARD_W, h: cardHeight(t, drawn) }));
  const frames = new Map<string, Rect>();
  for (const gr of drawn.groups) {
    const f = regionFrame(drawn, gr.id, 'full');
    if (f) frames.set(gr.id, f);
  }
  const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const linked = new Map<string, Rect[]>();
  for (const { from, to } of g.relations) {
    for (const [a, b] of [[from, to], [to, from]]) {
      if (a.ghost && !b.ghost) linked.set(a.table.id, [...(linked.get(a.table.id) ?? []), { x: b.table.x, y: b.table.y, w: CARD_W, h: cardHeight(b.table, drawn) }]);
    }
  }

  const out = new Map<string, { x: number; y: number; groupId?: string }>();
  const unplaced: Table[] = [];
  const memberRects = new Map<string, Rect[]>();
  for (const t of drawn.tables) if (t.groupId) memberRects.set(t.groupId, [...(memberRects.get(t.groupId) ?? []), { x: t.x, y: t.y, w: CARD_W, h: cardHeight(t, drawn) }]);

  for (const t of g.tables) {
    const h = cardHeight(t, other);
    const gid = groups.get(t.id);
    const members = (gid && memberRects.get(gid)) || [];
    let best: Rect | undefined;
    if (members.length) {
      const near = linked.get(t.id)?.filter((r) => members.some((m) => m.x === r.x && m.y === r.y)) ?? [];
      const aim = (near.length ? near : members).map(centre);
      const target = { x: aim.reduce((s, p) => s + p.x, 0) / aim.length, y: aim.reduce((s, p) => s + p.y, 0) / aim.length };
      const xs = new Set(members.flatMap((m) => [m.x, m.x + CARD_W + GAP, m.x - CARD_W - GAP]));
      const ys = new Set(members.flatMap((m) => [m.y, m.y + m.h + GAP, m.y - h - GAP]));
      let bestScore = Infinity;
      for (const x of xs) {
        for (const y of ys) {
          const r = { x, y, w: CARD_W, h };
          if (rects.some((o) => overlaps(r, o, GAP - 8))) continue;
          // the group's frame grows around the card: keep it off the other groups
          if ([...frames].some(([id, f]) => id !== gid && overlaps(r, f, 64))) continue;
          const c = centre(r);
          const score = Math.hypot(c.x - target.x, c.y - target.y);
          if (score < bestScore) {
            bestScore = score;
            best = r;
          }
        }
      }
    }
    if (!best || !gid) {
      unplaced.push(t);
      continue;
    }
    out.set(t.id, { x: best.x, y: best.y, groupId: gid });
    rects.push(best);
    memberRects.get(gid)!.push(best);
    const f = frames.get(gid);
    if (f) {
      const x0 = Math.min(f.x, best.x - 28), y0 = Math.min(f.y, best.y - 56);
      frames.set(gid, { x: x0, y: y0, w: Math.max(f.x + f.w, best.x + CARD_W + 28) - x0, h: Math.max(f.y + f.h, best.y + h + 28) - y0 });
    }
  }

  // the rest in a column right of everything
  const x = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) + 160 : 0;
  let y = rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
  for (const t of unplaced) {
    out.set(t.id, { x, y });
    y += cardHeight(t, other) + GAP;
  }
  return out;
}
