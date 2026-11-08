#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { absolute, loadBrowser, parseArgs } from "../lib/core.mjs";
import { computePipeGeometry } from "../pipe-geometry.js";

const args = parseArgs(process.argv.slice(2));
const sourceUrl = String(args.source || "https://revenuemedialab.com/");
const cloneUrl = String(args.clone || args["clone-url"] || "http://127.0.0.1:4310/");
const widths = String(args.widths || "390,500,640,768,900,1024,1100,1180,1440")
  .split(",")
  .map(Number)
  .filter((width) => Number.isInteger(width) && width > 0);
const out = absolute(args.out || ".audit/pipe-geometry");

function readSnapshot(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[data-liquid="main"]');
    const svg = main.ownerSVGElement;
    const parent = svg.parentElement;
    const bounds = parent.getBoundingClientRect();
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left - bounds.left,
        top: rect.top - bounds.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const centreOf = (element) => {
      const rect = rectOf(element);
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    };
    const start = parent.querySelector('[data-pipe="start"]');
    const turn = parent.querySelector('[data-pipe="turn"]');
    const rack = parent.querySelector('[data-pipe="rack"]');
    const valveElements = [...parent.querySelectorAll('[data-pipe="valve"]')];
    const dropElements = [...parent.querySelectorAll('[data-pipe="drop"]')];
    const rackRect = rectOf(rack);
    const taps = [...svg.querySelectorAll('[data-liquid="tap"]')].map((path) => path.getAttribute("d"));
    const tapStart = taps[0]?.match(/^M[-\d.]+ ([-\d.]+)/);
    return {
      parent: { width: bounds.width, height: bounds.height },
      start: centreOf(start),
      turn: centreOf(turn),
      rack: {
        x: Math.round(rackRect.left + rackRect.width / 2),
        top: Math.round(rackRect.top),
      },
      valves: valveElements.map(centreOf),
      drops: dropElements.map(centreOf),
      main: main.getAttribute("d"),
      taps,
      tapStartY: tapStart ? Number(tapStart[1]) : null,
      valveAttributes: [...svg.querySelectorAll("[data-valve] circle")].map((circle) => ({
        cx: Number(circle.getAttribute("cx")),
        cy: Number(circle.getAttribute("cy")),
        r: Number(circle.getAttribute("r")),
      })),
      svg: {
        width: Number(svg.getAttribute("width")),
        height: Number(svg.getAttribute("height")),
      },
      stops: [...svg.querySelectorAll("#pipe-liquid stop")].map((stop) => stop.getAttribute("stop-color")),
      stageColors: ["--raw", "--mid-1", "--mid-2", "--solution"].map((name) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim()),
    };
  });
}

function modelFor(snapshot) {
  return computePipeGeometry({
    width: snapshot.parent.width,
    height: snapshot.parent.height,
    start: snapshot.start,
    turn: snapshot.turn,
    rack: snapshot.rack,
    valves: snapshot.valves,
    drops: snapshot.drops,
    row: snapshot.parent.width >= 640,
    mobile: snapshot.parent.width < 768,
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formulaMatches(snapshot, model) {
  const expectedValves = model.valves.map((valve, index) => ({
    cx: valve.x,
    cy: valve.y,
    r: model.mobile ? 13 : 22,
  }));
  return Boolean(model)
    && snapshot.main === model.main
    && sameJson(snapshot.taps, model.taps.map((tap) => tap.d))
    && sameJson(snapshot.valveAttributes, expectedValves)
    && snapshot.svg.width === model.width
    && snapshot.svg.height === model.height;
}

function valveDelta(left, right) {
  let max = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || {};
    const b = right[index] || {};
    max = Math.max(max, Math.abs((a.cx ?? 0) - (b.cx ?? 0)), Math.abs((a.cy ?? 0) - (b.cy ?? 0)), Math.abs((a.r ?? 0) - (b.r ?? 0)));
  }
  return max;
}

const browser = await loadBrowser();
const report = {
  kind: "pipe-geometry-source-comparison",
  source: sourceUrl,
  clone: cloneUrl,
  generatedAt: new Date().toISOString(),
  widths,
  rows: [],
};

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const captures = {};
  for (const [origin, url] of Object.entries({ source: sourceUrl, clone: cloneUrl })) {
    const context = await browser.newContext({
      viewport: { width: widths[0], height: widths[0] < 768 ? 844 : 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    captures[origin] = {};
    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-liquid="main"]') && document.querySelectorAll('[data-pipe="valve"]').length === 4,
          undefined,
          { timeout: 20_000 },
        );
        await page.evaluate(async () => {
          if (document.fonts?.ready) await document.fonts.ready;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
        await page.waitForTimeout(250);
        captures[origin][width] = await readSnapshot(page);
      }
    } finally {
      await context.close();
    }
    report.rows.push(...errors.map((error) => ({ origin, error })));
  }

  const rows = [];
  for (const width of widths) {
    const source = captures.source[width];
    const clone = captures.clone[width];
    const sourceModel = modelFor(source);
    const cloneModel = modelFor(clone);
    const sourceMode = source.taps.length ? "row" : "centred";
    const cloneMode = clone.taps.length ? "row" : "centred";
    const sourceManifold = source.tapStartY ?? sourceModel.manifoldY;
    const cloneManifold = clone.tapStartY ?? cloneModel.manifoldY;
    const sourceOffset = source.rack.top - sourceManifold;
    const cloneOffset = clone.rack.top - cloneManifold;
    const expectedOffset = sourceModel.mobile ? 36 : 44;
    const sourceFormula = formulaMatches(source, sourceModel);
    const cloneFormula = formulaMatches(clone, cloneModel);
    const pathsExact = source.main === clone.main && sameJson(source.taps, clone.taps);
    const colorsExact = sameJson(source.stageColors, clone.stageColors) && sameJson(source.stops, clone.stops);
    const valves = valveDelta(source.valveAttributes, clone.valveAttributes);
    const rail = { source: sourceModel.railX, clone: cloneModel.railX };
    const manifold = { source: sourceManifold, clone: cloneManifold };
    const pass = sourceFormula && cloneFormula && pathsExact && colorsExact
      && valves === 0
      && rail.source === rail.clone
      && manifold.source === manifold.clone
      && sourceMode === cloneMode
      && sourceOffset === expectedOffset
      && cloneOffset === expectedOffset;
    rows.push({
      width,
      mode: { source: sourceMode, clone: cloneMode },
      rail,
      manifold,
      offset: { source: sourceOffset, clone: cloneOffset, expected: expectedOffset },
      valveDelta: valves,
      pathsExact,
      colorsExact,
      formula: { source: sourceFormula, clone: cloneFormula },
      stageColors: source.stageColors,
      stops: source.stops,
      sourceHeight: source.svg.height,
      cloneHeight: clone.svg.height,
      pass,
    });
  }
  report.rows = rows;

  const header = [
    "# Pipe geometry source comparison",
    "",
    `- Source: ${sourceUrl}`,
    `- Clone: ${cloneUrl}`,
    `- Generated: ${report.generatedAt}`,
    `- Widths: ${widths.join(", ")}`,
    "",
    "| Width | Mode (src → clone) | Rail x | Manifold y | Offset | Valve Δ | Main/taps | Stage colors | Formula | Pass |",
    "| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |",
  ];
  const body = rows.map((row) => `| ${row.width} | ${row.mode.source} → ${row.mode.clone} | ${row.rail.source} → ${row.rail.clone} | ${row.manifold.source} → ${row.manifold.clone} | ${row.offset.source}/${row.offset.clone} (${row.offset.expected}) | ${row.valveDelta} | ${row.pathsExact ? "exact" : "mismatch"} | ${row.colorsExact ? "exact" : "mismatch"} | ${row.formula.source && row.formula.clone ? "both" : row.formula.source ? "source only" : row.formula.clone ? "clone only" : "neither"} | ${row.pass ? "pass" : "FAIL"} |`);
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "report.md"), `${[...header, ...body, "", "Evidence: `.audit/pipe-geometry/report.json`.", ""].join("\n")}\n`);
  console.log(JSON.stringify({
    out,
    pass: rows.every((row) => row.pass),
    widths: rows.map((row) => ({
      width: row.width,
      mode: row.mode.source,
      rail: row.rail.source,
      manifold: row.manifold.source,
      offset: row.offset.source,
      valveDelta: row.valveDelta,
      pathsExact: row.pathsExact,
      colorsExact: row.colorsExact,
      pass: row.pass,
    })),
  }, null, 2));
  if (!rows.every((row) => row.pass)) process.exitCode = 1;
} finally {
  await browser.close();
}
