#!/usr/bin/env node
import { join, dirname } from "node:path";
import { absolute, parseArgs, readJson, requireOption } from "../lib/core.mjs";
import { loadConfig } from "../lib/config.mjs";
import { loadScenarioSuite } from "../lib/scenario.mjs";
import { verifySite } from "../lib/verify-site.mjs";

const args = parseArgs(process.argv.slice(2));
const source = absolute(requireOption(args, "source"));
const cloneUrl = requireOption(args, "clone-url");
const manifestPath = args.manifest ? absolute(args.manifest) : join(source, "evidence", "routes.json");
const config = await loadConfig({ configPath: args.config ? absolute(args.config) : undefined });
const manifest = await readJson(manifestPath);
manifest.mode = args.mode === "reference-inspired" ? "reference-inspired" : args.mode === "exact-reconstruction" ? "exact-reconstruction" : manifest.mode || "exact-reconstruction";
const only = args.only ? String(args.only).split(",").map((route) => route.trim()).filter(Boolean) : [];
const scenarios = args.scenarios
  ? await loadScenarioSuite(absolute(args.scenarios), { viewports: config.capture.viewports })
  : [];

const logger = {
  info(message) {
    process.stderr.write(`[verify] ${message}\n`);
  },
  warn(message) {
    process.stderr.write(`[verify] warning: ${message}\n`);
  },
};

const { report } = await verifySite({
  manifest,
  out: source,
  cloneUrl,
  config,
  only,
  scenarios,
  logger,
});
console.log(JSON.stringify({
  routeGate: report.routeGate,
  scenarioGate: report.scenarioGate,
  overallStatus: report.overallStatus,
  coverage: report.coverage,
  report: join(source, "verification", "site-report.json"),
}, null, 2));
process.exitCode = report.routeGate === "failed" || report.scenarioGate === "failed" ? 1 : 0;
