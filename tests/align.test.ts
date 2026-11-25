import { describe, expect, it } from 'vitest';
import { alignBox } from '../src/layout/align';

const card = (id: string, x: number, y: number, h = 134) => ({ id, x, y, w: 288, h });

describe('alignBox', () => {
  it('lines a dragged card up with an off-grid neighbour instead of the grid', () => {
    const r = alignBox({ x: 840, y: 400, w: 288, h: 160 }, [card('a', 836, 81)], 8, 22);
    expect(r.x).toBe(836);
    // nothing in reach vertically: back to the grid
    expect(r.y).toBe(396);
    // both edges of equal-width cards line up, so two guides, no middle one
    expect(r.guides.map((g) => [g.axis, g.at])).toEqual([['x', 836], ['x', 836 + 288]]);
    expect(r.guides[0].from).toBe(81);
    expect(r.guides[0].to).toBe(396 + 160);
  });

  it('lines up bottoms and middles of cards of different heights', () => {
    const bottom = alignBox({ x: 0, y: 103, w: 288, h: 100 }, [card('a', 400, 0, 200)], 8, 0);
    expect(bottom.y).toBe(100);
    expect(bottom.guides).toEqual([{ axis: 'y', at: 200, from: 0, to: 688 }]);
    const middle = alignBox({ x: 0, y: 47, w: 288, h: 100 }, [card('a', 400, 0, 200)], 8, 0);
    expect(middle.y).toBe(50);
    expect(middle.guides.map((g) => g.at)).toEqual([100]);
  });

  it('takes the smallest move, and the nearest card when moves tie', () => {
    const r = alignBox({ x: 100, y: 0, w: 288, h: 100 }, [card('far', 106, 2000), card('near', 97, 300)], 8, 0);
    expect(r.x).toBe(97);
    const tie = alignBox({ x: 100, y: 0, w: 288, h: 100 }, [card('far', 104, 2000), card('near', 96, 300)], 8, 0);
    expect(tie.x).toBe(96);
  });

  it('leaves the grid alone when nothing is in reach', () => {
    const r = alignBox({ x: 50, y: 61, w: 288, h: 100 }, [card('a', 500, 500)], 8, 24);
    expect(r).toEqual({ x: 48, y: 72, guides: [] });
  });
});
