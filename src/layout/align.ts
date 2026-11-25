// Magnetic alignment while dragging a card: an edge or the middle of the dragged
// card lines up with the same edge or middle of another card when it comes within
// reach; on an axis where nothing is in reach, the card falls back to the grid.

import type { Rect } from './geometry';

export type Box = Rect & { id: string };

/** A guide line to draw: x = at for a vertical one (spanning y from..to), y = at for a horizontal one. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

// start, middle and end of a box along an axis; only like lines attract (left to left, middle to middle…)
const lines = (b: Rect, axis: 'x' | 'y') => (axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]);

/** How far a box sits from another across an axis (0 when they overlap on it). */
const across = (a: Rect, b: Rect, axis: 'x' | 'y') =>
  axis === 'x' ? Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)) : Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));

function snapAxis(box: Rect, others: Box[], axis: 'x' | 'y', reach: number) {
  const own = lines(box, axis);
  let best: { shift: number; gap: number } | null = null;
  for (const o of others) {
    const theirs = lines(o, axis);
    const gap = across(box, o, axis);
    for (let k = 0; k < 3; k++) {
      const shift = theirs[k] - own[k];
      if (Math.abs(shift) > reach) continue;
      // the smallest move wins; between equal moves, the nearest card
      if (!best || Math.abs(shift) < Math.abs(best.shift) - 0.01 || (Math.abs(shift) - Math.abs(best.shift) < 0.01 && gap < best.gap)) best = { shift, gap };
    }
  }
  return best?.shift;
}

/**
 * Where to put a dragged box: `reach` is the attraction distance and `grid` the
 * fallback grid step (0 for none), both in canvas units. Returns the new top-left
 * corner and the guides to draw for the alignments it found.
 */
export function alignBox(box: Rect, others: Box[], reach: number, grid: number): { x: number; y: number; guides: Guide[] } {
  const toGrid = (v: number) => (grid ? Math.round(v / grid) * grid : Math.round(v));
  const dx = snapAxis(box, others, 'x', reach);
  const dy = snapAxis(box, others, 'y', reach);
  const x = dx === undefined ? toGrid(box.x) : Math.round(box.x + dx);
  const y = dy === undefined ? toGrid(box.y) : Math.round(box.y + dy);
  const placed = { x, y, w: box.w, h: box.h };
  const guides: Guide[] = [];
  for (const axis of ['x', 'y'] as const) {
    if ((axis === 'x' ? dx : dy) === undefined) continue;
    // one guide per lined-up edge, running from the dragged card across every card on it;
    // the middle line only when no edge lines up (equal-width cards would otherwise get three)
    const own = lines(placed, axis);
    const found: Guide[] = [];
    for (const k of [0, 2, 1]) {
      if (k === 1 && found.length) break;
      const on = others.filter((o) => Math.abs(lines(o, axis)[k] - own[k]) < 1);
      if (!on.length) continue;
      const span = [placed, ...on].flatMap((b) => (axis === 'x' ? [b.y, b.y + b.h] : [b.x, b.x + b.w]));
      found.push({ axis, at: own[k], from: Math.min(...span), to: Math.max(...span) });
    }
    guides.push(...found);
  }
  return { x, y, guides };
}
