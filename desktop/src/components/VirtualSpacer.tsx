// Stands in for the rows that are not rendered so the scrollable height, and
// with it every scroll position, is unchanged. `gridColumn` makes it span a whole
// grid row; it has no effect in block or flex lists.
export function VirtualSpacer({
  position,
  height,
}: {
  position: "top" | "bottom";
  height: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-virtual-spacer={position}
      style={{ height, gridColumn: "1 / -1", flex: "none", pointerEvents: "none" }}
    />
  );
}
