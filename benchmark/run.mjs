#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrowser } from "./workflow/lib/core.mjs";
import { loadConfig } from "./workflow/lib/config.mjs";
import { discoverSite } from "./workflow/lib/discovery.mjs";
import { captureSite } from "./workflow/lib/capture.mjs";
import { verifySite } from "./workflow/lib/verify-site.mjs";
import { startSite } from "./fixtures/site-server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const silent = { info() {}, warn() {}, error() {} };
const onlyCases = new Set(process.argv.slice(2).filter((value) => !value.startsWith("-")));
const outRoot = join(root, ".benchmark");
const docsResultsPath = join(root, "docs", "benchmark-results.json");
const browser = await loadBrowser();

const fixtureConfig = await loadConfig({
  overrides: {
    discovery: {
      maxPages: 30,
      maxDepth: 3,
      concurrency: 3,
      requestDelayMs: 0,
      timeoutMs: 20_000,
      maxDurationMs: 120_000,
    },
    capture: {
      viewports: {
        desktop: { width: 1440, height: 1000 },
        tablet: { width: 768, height: 1000 },
        mobile: { width: 390, height: 844 },
      },
      breakpoints: { enabled: true, timeoutMs: 20_000 },
      interactionStates: "pseudo",
      maxStates: 12,
    },
  },
});

const externalConfig = await loadConfig({
  overrides: {
    discovery: { maxPages: 20, maxDurationMs: 180_000 },
  },
});

function selectedRoutesFor(manifest, patterns) {
  return manifest.routes
    .filter((route) => route.discoveryStatus === "discovered")
    .filter((route) => patterns.some((pattern) => (pattern.endsWith("*") ? route.localRoute.startsWith(pattern.slice(0, -1)) : route.localRoute === pattern)))
    .map((route) => route.localRoute);
}

function summarizeCapture(results) {
  return results.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    summary.viewports += Number(result.viewports) || 0;
    summary.warnings += result.warnings?.length || 0;
    return summary;
  }, { captured: 0, partial: 0, failed: 0, skipped: 0, viewports: 0, warnings: 0 });
}

function routeRows(manifest, report) {
  const statuses = new Map(report.routes.map((route) => [route.route, route.status]));
  return manifest.routes.map((route) => ({
    route: route.localRoute,
    type: route.routeType,
    sources: route.discoverySources,
    discovery: route.discoveryStatus,
    capture: route.captureStatus,
    verification: statuses.get(route.localRoute) || route.verificationStatus,
    httpStatus: route.httpStatus,
  }));
}

async function runCase({ name, sourceUrl, cloneUrl, out, config, patterns }) {
  await rm(out, { recursive: true, force: true });
  const startedAt = Date.now();
  const discovered = await discoverSite({ url: sourceUrl, out, config, browser, logger: silent });
  const discoveredAt = Date.now();
  const manifestBeforeCapture = JSON.parse(await readFile(join(out, "evidence", "routes.json"), "utf8"));
  const selected = patterns ? selectedRoutesFor(manifestBeforeCapture, patterns) : manifestBeforeCapture.routes.filter((route) => route.discoveryStatus === "discovered").map((route) => route.localRoute);
  if (!selected.length) throw new Error(`${name}: no selected routes matched ${patterns?.join(", ") || "the discovered inventory"}.`);
  const captured = await captureSite({ manifest: manifestBeforeCapture, out, config, browser, only: selected, force: true, logger: silent });
  const capturedAt = Date.now();
  const manifest = JSON.parse(await readFile(join(out, "evidence", "routes.json"), "utf8"));
  const verification = await verifySite({
    manifest,
    out,
    cloneUrl,
    config,
    browser,
    only: selected,
    scenarios: [],
    logger: silent,
  });
  const verifiedAt = Date.now();
  return {
    name,
    sourceUrl,
    cloneUrl,
    out: out.replace(`${root}/`, ""),
    selected,
    timingsMs: {
      discovery: discoveredAt - startedAt,
      capture: capturedAt - discoveredAt,
      verification: verifiedAt - capturedAt,
      total: verifiedAt - startedAt,
    },
    discovery: {
      ...discovered.summary,
      routeTypes: Object.entries(manifestBeforeCapture.routes.reduce((counts, route) => {
        counts[route.routeType] = (counts[route.routeType] || 0) + 1;
        return counts;
      }, {})).map(([type, count]) => ({ type, count })),
    },
    capture: summarizeCapture(captured.results),
    verification: {
      routeGate: verification.report.routeGate,
      scenarioGate: verification.report.scenarioGate,
      overallStatus: verification.report.overallStatus,
      coverage: verification.report.coverage,
      routes: routeRows(manifest, verification.report),
    },
  };
}

const cases = [];
async function record(definition) {
  if (onlyCases.size && !onlyCases.has(definition.name)) return;
  process.stderr.write(`[benchmark] ${definition.name}\n`);
  try {
    cases.push(await definition.run());
  } catch (error) {
    cases.push({ name: definition.name, error: error.stack || error.message });
    process.exitCode = 1;
  }
  await mkdir(dirname(docsResultsPath), { recursive: true });
  await writeFile(docsResultsPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), browser: "Chromium via Playwright 1.61.1", cases }, null, 2)}\n`);
}

let sourceSite;
let cloneSite;
let cloneServer;

try {
  sourceSite = await startSite();
  cloneSite = await startSite();
  await record({
    name: "static-multipage",
    run: () => runCase({
      name: "static-multipage",
      sourceUrl: sourceSite.url,
      cloneUrl: cloneSite.url,
      out: join(outRoot, "static-multipage"),
      config: fixtureConfig,
      patterns: ["/", "/about", "/services"],
    }),
  });
  await sourceSite.close();
  await cloneSite.close();
  sourceSite = null;
  cloneSite = null;

  sourceSite = await startSite();
  cloneSite = await startSite();
  await record({
    name: "spa",
    run: () => runCase({
      name: "spa",
      sourceUrl: sourceSite.url,
      cloneUrl: cloneSite.url,
      out: join(outRoot, "spa"),
      config: fixtureConfig,
      patterns: ["/app*"],
    }),
  });
  await sourceSite.close();
  await cloneSite.close();
  sourceSite = null;
  cloneSite = null;

  const port = Number(process.env.BENCHMARK_CLONE_PORT || 4336);
  cloneServer = spawn(process.execPath, ["serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const cloneUrl = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(cloneUrl);
      if (response.ok) break;
    } catch {
      // Keep polling while the local clone starts.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  await record({
    name: "large-responsive",
    run: () => runCase({
      name: "large-responsive",
      sourceUrl: "https://revenuemedialab.com/",
      cloneUrl,
      out: join(outRoot, "large-responsive"),
      config: externalConfig,
    }),
  });
} finally {
  await browser.close().catch(() => {});
  await sourceSite?.close().catch(() => {});
  await cloneSite?.close().catch(() => {});
  if (cloneServer) {
    cloneServer.kill("SIGTERM");
    await new Promise((done) => {
      cloneServer.once("exit", done);
      setTimeout(done, 2_000);
    });
  }
}

console.log(JSON.stringify({ results: cases.map((entry) => ({
  name: entry.name,
  error: entry.error || null,
  discovery: entry.discovery || null,
  capture: entry.capture || null,
  verification: entry.verification ? {
    routeGate: entry.verification.routeGate,
    scenarioGate: entry.verification.scenarioGate,
    overallStatus: entry.verification.overallStatus,
    coverage: entry.verification.coverage,
  } : null,
  timingsMs: entry.timingsMs || null,
})) }, null, 2));
