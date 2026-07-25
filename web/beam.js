/** Convert an engine beam into SVG points that reach the board edge on exit. */
export function beamPoints(beam, sourceIndex) {
  const points = [[sourceIndex === 0 ? 0 : 900, 450]];
  points.push(...beam.path.map(([row, col]) => [col * 100 + 50, row * 100 + 50]));
  if (beam.exited && beam.path.length) {
    const [row, col, direction] = beam.path.at(-1);
    const edge = {
      N: [col * 100 + 50, 0],
      E: [900, row * 100 + 50],
      S: [col * 100 + 50, 900],
      W: [0, row * 100 + 50],
    };
    points.push(edge[direction]);
  }
  return points;
}
