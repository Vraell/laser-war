export const RED_SIDE = "bottom";
export const BLUE_SIDE = "top";

/** Map one displayed board square to its immutable engine coordinates. */
export function logicalSquare(displayRow, displayCol, humanSide, boardSize = 9) {
  return humanSide === BLUE_SIDE
    ? [boardSize - 1 - displayRow, boardSize - 1 - displayCol]
    : [displayRow, displayCol];
}

/** Rotate one SVG board point into the selected player's fixed perspective. */
export function displayPoint([x, y], humanSide, boardExtent = 900) {
  return humanSide === BLUE_SIDE ? [boardExtent - x, boardExtent - y] : [x, y];
}

/** Return board labels in the order seen from the selected side. */
export function perspectiveLabels(humanSide, boardSize = 9) {
  const labels = Array.from({ length: boardSize }, (_, index) => index + 1);
  return humanSide === BLUE_SIDE ? labels.reverse() : labels;
}

/** Return the side controlled by the computer in a single-player match. */
export function opposingSide(side) {
  return side === BLUE_SIDE ? RED_SIDE : BLUE_SIDE;
}
