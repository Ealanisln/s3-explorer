import { describe, it, expect } from 'vitest';
import { clampMenuPosition } from '../../../public/src/util/context-menu';

// Viewport used across the cases: 1280x800, default margin 8.
const VW = 1280;
const VH = 800;

describe('clampMenuPosition', () => {
  it('keeps the cursor position when the menu fits', () => {
    expect(clampMenuPosition(100, 200, 180, 240, VW, VH)).toEqual({ left: 100, top: 200 });
  });

  it('fits exactly at the margin boundary without moving', () => {
    // left + width + margin === vw → not past the edge, stays put.
    expect(clampMenuPosition(VW - 180 - 8, 100, 180, 240, VW, VH)).toEqual({
      left: VW - 180 - 8,
      top: 100,
    });
  });

  it('pulls the menu back from the right edge', () => {
    const pos = clampMenuPosition(VW - 50, 200, 180, 240, VW, VH);
    expect(pos).toEqual({ left: VW - 180 - 8, top: 200 });
  });

  it('pulls the menu up from the bottom edge', () => {
    const pos = clampMenuPosition(100, VH - 50, 180, 240, VW, VH);
    expect(pos).toEqual({ left: 100, top: VH - 240 - 8 });
  });

  it('clamps both axes when the cursor is at the bottom-right corner', () => {
    const pos = clampMenuPosition(VW - 1, VH - 1, 180, 240, VW, VH);
    expect(pos).toEqual({ left: VW - 180 - 8, top: VH - 240 - 8 });
  });

  it('never goes past the top-left margin when the menu is taller than the viewport', () => {
    const pos = clampMenuPosition(100, 500, 180, 900, VW, VH);
    expect(pos.top).toBe(8);
    expect(pos.left).toBe(100);
  });

  it('never goes past the top-left margin when the menu is wider than the viewport', () => {
    const pos = clampMenuPosition(600, 100, 1500, 240, VW, VH);
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(100);
  });

  it('honors a custom margin', () => {
    const pos = clampMenuPosition(VW - 10, VH - 10, 100, 100, VW, VH, 20);
    expect(pos).toEqual({ left: VW - 100 - 20, top: VH - 100 - 20 });
  });

  it('leaves a zero-size menu untouched anywhere inside the viewport', () => {
    expect(clampMenuPosition(0, 0, 0, 0, VW, VH)).toEqual({ left: 0, top: 0 });
  });
});
