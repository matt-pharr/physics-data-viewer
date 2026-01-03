export class VirtualScroller {
  viewportSize: number;
  overscan: number;

  constructor(viewportSize: number, overscan: number = 10) {
    if (viewportSize <= 0) {
      throw new Error(`viewportSize must be positive, got: ${viewportSize}`);
    }
    if (overscan < 0) {
      throw new Error(`overscan cannot be negative, got: ${overscan}`);
    }
    this.viewportSize = viewportSize;
    this.overscan = overscan;
  }

  visibleRange(totalItems: number, startIndex: number = 0): [number, number] {
    if (totalItems < 0) {
      throw new Error(`totalItems cannot be negative, got: ${totalItems}`);
    }
    const clampedStart = Math.max(0, startIndex);
    const start = Math.max(0, clampedStart - this.overscan);
    const end = Math.min(totalItems, clampedStart + this.viewportSize + this.overscan);
    return [start, end];
  }

  window<T>(items: T[], startIndex: number = 0): T[] {
    const [start, end] = this.visibleRange(items.length, startIndex);
    return items.slice(start, end);
  }
}
