// Pure velocity math for drag edge auto-scroll. While a drag is in
// progress, PlanDetail drives a rAF loop that reads the pointer's Y and
// scrolls whichever pane it's over when the pointer nears that pane's
// top or bottom edge — so a drop target scrolled out of view comes into
// reach without releasing the drag. This function is the pure part: how
// many pixels to scroll this frame (negative = up, positive = down).

export interface EdgeScrollOpts {
  /** Distance from an edge, in px, where auto-scroll begins. */
  edge: number
  /** Scroll step (px/frame) at the very edge, easing to 0 at `edge`. */
  maxSpeed: number
}

/**
 * Desired scroll delta for a pane this frame given the pointer's Y and
 * the pane's top/bottom (viewport coords). Speed ramps linearly from
 * `maxSpeed` at the edge to 0 at `edge` px in. Returns 0 when the
 * pointer is outside the pane vertically or in the dead zone between the
 * two edge bands. Caller clamps to the pane's actual scroll range.
 */
export function edgeScrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  { edge, maxSpeed }: EdgeScrollOpts,
): number {
  if (pointerY < top || pointerY > bottom) return 0
  const topDist = pointerY - top
  const botDist = bottom - pointerY
  if (topDist < edge && topDist <= botDist) {
    return -Math.ceil(maxSpeed * (1 - topDist / edge))
  }
  if (botDist < edge) {
    return Math.ceil(maxSpeed * (1 - botDist / edge))
  }
  return 0
}
