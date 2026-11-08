#!/usr/bin/env node
import { absolute, parseArgs, requireOption, readJson } from "../lib/core.mjs";
import { captureSite } from "../lib/capture.mjs";
import { loadConfig, ConfigError } from "../lib/config.mjs";

const args = parseArgs(process.argv.slice(2));

function list(value) {
  if (!value || value === true) return [];
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function main() {
  const manifestPath = absolute(args.manifest || ".clone/evidence/routes.json");
  const out = absolute(args.out || ".clone");
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    throw new Error(`Unable to read route manifest at ${manifestPath}. Run discover-site first. ${error.message}`);
  }
  if (manifest.kind !== "rml-route-manifest") {
    throw new Error(`${manifestPath} is not a rml route manifest. Run discover-site first.`);
  }
  const overrides = { capture: {} };
  if (args["max-routes"]) overrides.capture.maxRoutes = Number.parseInt(args["max-routes"], 10);
  if (args["max-states"]) overrides.capture.maxStates = Number.parseInt(args["max-states"], 10);
  if (args["no-breakpoints"]) overrides.capture.breakpoints = { enabled: false, candidates: manifest.config?.capture?.breakpoints?.candidates || [] };
  if (args["interaction-states"]) overrides.capture.interactionStates = String(args["interaction-states"]);
  const config = await loadConfig({ configPath: args.config ? absolute(args.config) : undefined, overrides: { ...manifest.config, ...overrides } });
  const only = list(args.only);
  const { results } = await captureSite({
    manifest,
    out,
    config,
    only,
    force: Boolean(args.force),
    logger: { info: (message) => process.stderr.write(`[capture] ${message}\n`), warn: (message) => process.stderr.write(`[capture] warning: ${message}\n`) },
  });
  const summary = {
    selected: results.length,
    captured: results.filter((result) => result.status === "captured").length,
    partial: results.filter((result) => result.status === "partial").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    report: "evidence/capture-report.md",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!results.length) console.log("No selected routes were captured. Check discoveryStatus and --only filters.");
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? error.message : error.message);
  process.exitCode = 1;
});
