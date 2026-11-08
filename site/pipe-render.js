import { STAGE_COLORS, computePipeGeometry } from "./pipe-geometry.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function centreOf(element, origin) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2 - origin.left),
    y: Math.round(rect.top + rect.height / 2 - origin.top),
  };
}

function geometryFor(svg) {
  const parent = svg.parentElement;
  if (!parent) return null;
  const start = parent.querySelector('[data-pipe="start"]');
  const turn = parent.querySelector('[data-pipe="turn"]');
  const rack = parent.querySelector('[data-pipe="rack"]');
  const valves = [...parent.querySelectorAll('[data-pipe="valve"]')];
  const drops = [...parent.querySelectorAll('[data-pipe="drop"]')];
  if (!start || !turn || !rack || valves.length !== 4 || !drops.length) return null;

  const bounds = parent.getBoundingClientRect();
  const rackBounds = rack.getBoundingClientRect();
  return computePipeGeometry({
    width: bounds.width,
    height: bounds.height,
    start: centreOf(start, bounds),
    turn: centreOf(turn, bounds),
    rack: {
      x: Math.round(rackBounds.left + rackBounds.width / 2 - bounds.left),
      top: Math.round(rackBounds.top - bounds.top),
    },
    valves: valves.map((valve) => centreOf(valve, bounds)),
    drops: drops.map((drop) => centreOf(drop, bounds)),
    row: window.matchMedia("(min-width: 640px)").matches,
    mobile: bounds.width < 768,
  });
}

function svgElement(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) element.setAttribute(name, String(value));
  }
  return element;
}

function addPath(svg, d, attributes) {
  svg.append(svgElement("path", { d, fill: "none", "stroke-linejoin": "round", ...attributes }));
}

export function renderPipe(svg) {
  const geometry = geometryFor(svg);
  if (!geometry) return null;

  const mobile = geometry.mobile;
  const outlineWidth = mobile ? 24 : 28;
  const innerWidth = mobile ? 18 : 22;
  const liquidWidth = mobile ? 12 : 14;
  const couplingWidth = mobile ? 34 : 38;
  const valveRadius = mobile ? 13 : 22;
  const connectors = [...geometry.taps.map((tap) => tap.d), geometry.main];
  const firstValve = geometry.valves[0];
  const lastValve = geometry.valves[geometry.valves.length - 1];

  const gradient = svgElement("linearGradient", {
    id: "pipe-liquid",
    gradientUnits: "userSpaceOnUse",
    x1: 0,
    y1: firstValve.y,
    x2: 0,
    y2: lastValve.y,
  });
  const stops = [
    ["0", "var(--raw)"],
    ["0.3333333333333333", "var(--mid-1)"],
    ["0.6666666666666666", "var(--mid-2)"],
    ["1", "var(--solution)"],
  ];
  for (const [offset, color] of stops) gradient.append(svgElement("stop", { offset, "stop-color": color }));

  const defs = svgElement("defs", {});
  defs.append(gradient);
  svg.replaceChildren(defs);

  for (const d of connectors) addPath(svg, d, { stroke: "var(--ink)", "stroke-width": outlineWidth });
  for (const d of connectors) addPath(svg, d, { stroke: "#FFFFFF", "stroke-width": innerWidth });

  for (const tap of geometry.taps) {
    addPath(svg, tap.d, {
      "data-liquid": "tap",
      stroke: "var(--solution)",
      "stroke-width": liquidWidth,
    });
  }
  addPath(svg, geometry.main, {
    "data-liquid": "main",
    stroke: "url(#pipe-liquid)",
    "stroke-width": liquidWidth,
  });

  for (const coupling of geometry.couplings) {
    svg.append(svgElement("rect", {
      x: coupling.x - couplingWidth / 2,
      y: coupling.y - 6,
      width: couplingWidth,
      height: 12,
      rx: 3,
      fill: "var(--ink)",
      stroke: "var(--bench-dark-ink)",
      "stroke-width": 2,
    }));
  }

  geometry.valves.forEach((valve, index) => {
    const group = svgElement("g", { "data-valve": index });
    group.append(svgElement("circle", {
      cx: valve.x,
      cy: valve.y,
      r: valveRadius,
      fill: STAGE_COLORS[index],
      stroke: "var(--ink)",
      "stroke-width": 3,
    }));
    svg.append(group);
  });

  svg.setAttribute("width", geometry.width);
  svg.setAttribute("height", geometry.height);
  svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
  svg.parentElement?.setAttribute("data-pipe-ready", "");
  return geometry;
}
