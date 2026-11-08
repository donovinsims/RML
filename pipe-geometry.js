/**
 * Pure geometry for the Revenue Media Lab pipe.
 *
 * The original site measures four anchors inside the pipe's positioned parent
 * and rebuilds the SVG after layout changes. Keeping the math here makes the
 * browser renderer and the golden tests use exactly the same coordinates.
 */

export const STAGE_COLORS = ["var(--raw)", "var(--mid-1)", "var(--mid-2)", "var(--solution)"];

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Build a polyline with rounded interior corners. Points that repeat within
 * half a pixel are collapsed before drawing.
 */
export function roundedPath(points, radius) {
  const input = points.filter((point, index) => index === 0 || distance(point, points[index - 1]) > 0.5);
  if (!input.length) return "";
  let path = `M${input[0].x} ${input[0].y}`;
  for (let index = 1; index < input.length - 1; index += 1) {
    const previous = input[index - 1];
    const current = input[index];
    const next = input[index + 1];
    const incoming = distance(previous, current);
    const outgoing = distance(current, next);
    const bend = Math.min(radius, incoming / 2, outgoing / 2);
    const before = {
      x: current.x + ((previous.x - current.x) / incoming) * bend,
      y: current.y + ((previous.y - current.y) / incoming) * bend,
    };
    const after = {
      x: current.x + ((next.x - current.x) / outgoing) * bend,
      y: current.y + ((next.y - current.y) / outgoing) * bend,
    };
    path += ` L${before.x} ${before.y} Q${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = input[input.length - 1];
  return `${path} L${last.x} ${last.y}`;
}

/**
 * Reproduce the source pipe's anchor-derived model.
 *
 * `start`, `turn`, `valves`, and `drops` are centres relative to the SVG
 * parent. `rack` is the rack's centre plus its top edge in the same coordinate
 * space. The source switches to mobile geometry below 768px and to the
 * three-drop manifold at 640px and above.
 */
export function computePipeGeometry({ width, height, start, turn, rack, valves, drops, row = width >= 640, mobile = width < 768 }) {
  if (![width, height, start?.x, start?.y, turn?.y, rack?.x, rack?.top].every(Number.isFinite)) return null;
  if (!Array.isArray(valves) || valves.length !== 4 || !valves.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return null;
  if (!Array.isArray(drops) || !drops.length) return null;

  const railX = valves[0].x;
  const manifoldY = Math.round(rack.top - (mobile ? 36 : 44));
  const radius = mobile ? 18 : 28;
  const stem = [
    start,
    { x: start.x, y: turn.y },
    { x: railX, y: turn.y },
    { x: railX, y: manifoldY },
  ];

  if (row) {
    const lastDrop = drops[drops.length - 1];
    return {
      width: Math.round(width),
      height: Math.round(height),
      row: true,
      mobile,
      radius,
      manifoldY,
      railX,
      valves,
      main: roundedPath([...stem, { x: lastDrop.x, y: manifoldY }, { x: lastDrop.x, y: lastDrop.y + 14 }], radius),
      taps: drops.slice(0, -1).map((drop) => ({
        x: drop.x,
        d: `M${drop.x} ${manifoldY} L${drop.x} ${drop.y + 14}`,
      })),
      couplings: drops.map((drop) => ({ x: drop.x, y: rack.top })),
    };
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
    row: false,
    mobile,
    radius,
    manifoldY,
    railX,
    valves,
    main: roundedPath([...stem, { x: rack.x, y: manifoldY }, { x: rack.x, y: rack.top + 4 }], radius),
    taps: [],
    couplings: [{ x: rack.x, y: rack.top }],
  };
}
