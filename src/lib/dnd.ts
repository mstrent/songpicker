// Small drag-and-drop helpers shared across PlanDetail's drop zones.

/**
 * Whether a `dragleave` means the cursor actually left `currentTarget`,
 * versus just crossing onto one of its descendants. `dragleave` bubbles
 * up from child elements, so a drop zone with children fires it
 * constantly during movement; clearing the hover highlight on every
 * such event makes it flicker. Both the service-order slots and the
 * candidates panel gate their highlight-clear on this.
 */
export function dragLeftElement(
  currentTarget: { contains(other: Node | null): boolean },
  relatedTarget: Node | null,
): boolean {
  return !(relatedTarget && currentTarget.contains(relatedTarget))
}
