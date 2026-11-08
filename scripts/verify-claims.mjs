#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

async function read(path) {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    failures.push(`Missing measured artifact: ${path}. Run npm test first (it writes the test log), then npm run audit.`);
    return null;
  }
}

function parseJson(raw, path) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    failures.push(`${path} is not valid JSON: ${error.message}`);
    return null;
  }
}

function readClaim(pattern, label) {
  const match = readme.match(pattern);
  if (!match) failures.push(`README is missing its ${label} claim.`);
  return match;
}

function expectNumber(actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: README says ${actual}, measured ${expected}.`);
}

function expectText(actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: README says ${actual}, measured ${expected}.`);
}

const [readmeRaw, testLog, auditRaw, pipeRaw, buildRaw] = await Promise.all([
  read("README.md"),
  read(".audit/alignment/test.log"),
  read(".audit/responsive/report.json"),
  read(".audit/pipe-geometry/report.json"),
  read("build-report.json"),
]);

if (!readmeRaw || !testLog || !auditRaw || !pipeRaw || !buildRaw) {
  console.error("Cannot verify README claims:\n- " + failures.join("\n- "));
  process.exit(1);
}

const readme = readmeRaw;
const audit = parseJson(auditRaw, ".audit/responsive/report.json");
const pipe = parseJson(pipeRaw, ".audit/pipe-geometry/report.json");
const build = parseJson(buildRaw, "build-report.json");
const testSummary = Object.fromEntries(
  [...testLog.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]),
);

if (!Number.isInteger(testSummary.tests) || !Number.isInteger(testSummary.pass) || !Number.isInteger(testSummary.fail)) {
  failures.push(".audit/alignment/test.log is missing the node:test summary counts.");
}

const testClaim = readClaim(/\*\*(\d+)\/(\d+)\*\* local regression tests passing/, "local test count");
if (testClaim) {
  expectNumber(Number(testClaim[1]), testSummary.pass, "Local test pass count");
  expectNumber(Number(testClaim[2]), testSummary.tests, "Local test total");
  expectNumber(testSummary.fail, 0, "Local test failures");
}

const results = Array.isArray(audit?.results) ? audit.results : [];
const checks = audit?.summary?.checks ?? results.length;
const auditPass = audit?.summary?.pass ?? results.filter((result) => result.status === "pass").length;
const primary = results.filter((result) => result.primary);
const exactPrimary = primary.filter((result) => result.visual?.changeRatio === 0).length;
const nonexactPrimary = primary.filter((result) => !result.visual || result.visual.changeRatio > 0);
const maxHeightDelta = Math.max(0, ...results.map((result) => result.checks?.heightDelta ?? 0));
const maxOverflow = Math.max(0, ...results.map((result) => result.checks?.cloneHorizontalOverflow ?? 0));

if (!checks || results.length !== checks) {
  failures.push(`Responsive audit has ${results.length} results for ${checks} advertised checks.`);
}
if (auditPass !== checks) {
  failures.push(`Responsive audit is not all-pass: ${auditPass}/${checks}.`);
}

const auditClaim = readClaim(/\*\*(\d+)\/(\d+)\*\* responsive checks passing/, "responsive audit count");
if (auditClaim) {
  expectNumber(Number(auditClaim[1]), auditPass, "Responsive audit pass count");
  expectNumber(Number(auditClaim[2]), checks, "Responsive audit total");
}

const primaryClaim = readClaim(/\*\*(\d+)\/(\d+)\*\* primary screenshots are exact/, "primary screenshot count");
if (primaryClaim) {
  expectNumber(Number(primaryClaim[1]), exactPrimary, "Exact primary screenshot count");
  expectNumber(Number(primaryClaim[2]), primary.length, "Primary screenshot total");
}

const home640 = nonexactPrimary.filter((result) => result.route === "/" && result.width === 640);
if (nonexactPrimary.length !== 1 || home640.length !== 1) {
  failures.push(
    `README says home@640 is the only non-exact primary, but measured non-exact primaries: ${nonexactPrimary
      .map((result) => `${result.route}@${result.width}`)
      .join(", ") || "none"}.`,
  );
} else {
  const measuredPixels = home640[0].visual.changedPixels;
  const measuredRatio = (home640[0].visual.changeRatio * 100).toFixed(4);
  const homeClaim = readClaim(/home page at 640 px \(\*\*([\d.]+)%\*\*, ([\d,]+) pixels/, "home@640 delta");
  if (homeClaim) {
    expectNumber(Number(homeClaim[1]), Number(measuredRatio), "Home@640 delta percentage");
    expectNumber(Number(homeClaim[2].replaceAll(",", "")), measuredPixels, "Home@640 changed pixels");
  }
}

const maxHeightClaim = readClaim(/maximum page-height delta (?:across the full sweep )?is (\d+) px/, "maximum page-height delta");
if (maxHeightClaim) {
  expectNumber(Number(maxHeightClaim[1]), maxHeightDelta, "Maximum page-height delta");
}
if (maxOverflow !== 0 || !/horizontal overflow is zero/.test(readme)) {
  failures.push(`Horizontal overflow: README claims zero, measured ${maxOverflow}px.`);
}
const primaryHeightDeltas = primary.filter((result) => (result.checks?.heightDelta ?? 0) !== 0);
if (primaryHeightDeltas.length > 0) {
  failures.push(
    `README claims all primary page-height deltas are zero, but measured: ${primaryHeightDeltas
      .map((result) => `${result.route}@${result.width}=${result.checks.heightDelta}px`)
      .join(", ")}.`,
  );
}

const pipeRows = Array.isArray(pipe?.rows) ? pipe.rows : [];
const pipePass = pipeRows.filter((row) => row.pass).length;
const pipeClaim = readClaim(/\*\*(\d+)\/(\d+)\*\* live pipe-geometry checks/, "pipe-geometry count");
if (pipeClaim) {
  expectNumber(Number(pipeClaim[1]), pipePass, "Pipe-geometry pass count");
  expectNumber(Number(pipeClaim[2]), pipeRows.length, "Pipe-geometry total");
}
if (pipePass !== pipeRows.length) {
  failures.push(`Pipe geometry is not all-pass: ${pipePass}/${pipeRows.length}.`);
}

const buildClaim = readClaim(
  /\*\*(\d+)\*\* routes, \*\*([\d,]+)\*\* localized assets, \*\*([\d,]+)\*\* asset bytes, and \*\*(\d+)\*\* build failures/,
  "build count",
);
if (buildClaim) {
  expectNumber(Number(buildClaim[1]), build?.pages?.length ?? 0, "Build page count");
  expectNumber(Number(buildClaim[2].replaceAll(",", "")), build?.assets ?? 0, "Build asset count");
  expectNumber(Number(buildClaim[3].replaceAll(",", "")), build?.assetBytes ?? 0, "Build asset bytes");
  expectNumber(Number(buildClaim[4]), build?.failures?.length ?? 0, "Build failure count");
}

if (failures.length > 0) {
  console.error("README verification claims do not match the measured artifacts:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `README claims verified: ${testSummary.pass}/${testSummary.tests} tests, ` +
    `${auditPass}/${checks} responsive checks, ${exactPrimary}/${primary.length} exact primary captures, ` +
    `${pipePass}/${pipeRows.length} pipe checks, max page-height delta ${maxHeightDelta}px.`,
);
