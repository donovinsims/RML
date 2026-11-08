#!/usr/bin/env node
import { join } from "node:path";
import { absolute, parseArgs, requireOption } from "../lib/core.mjs";
import { discoverSite } from "../lib/discovery.mjs";
import { loadConfig, ConfigError } from "../lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const json = Boolean(args.json || args["json-logs"]);

function list(value) {
  if (!value || value === true) return [];
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function integer(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be an integer.`);
  return parsed;
}

async function main() {
  const url = requireOption(args, "url");
  const out = absolute(args.out || ".clone");
  const overrides = { discovery: {} };
  const mapping = {
    "max-pages": "maxPages",
    "max-depth": "maxDepth",
    concurrency: "concurrency",
    "request-delay-ms": "requestDelayMs",
    "timeout-ms": "timeoutMs",
    retries: "retries",
    "max-sitemaps": "maxSitemaps",
    "max-duration-ms": "maxDurationMs",
    "max-navigation-interactions": "maxNavigationInteractions",
  };
  for (const [flag, key] of Object.entries(mapping)) {
    const value = integer(args[flag], flag);
    if (value !== undefined) overrides.discovery[key] = value;
  }
  if (args.include) overrides.discovery.include = list(args.include);
  if (args.exclude) overrides.discovery.exclude = list(args.exclude);
  if (args.render === false || args["no-render"]) overrides.discovery.render = false;
  if (args["no-reveal-nav"]) overrides.discovery.revealNavigation = false;
  if (args["no-robots"]) overrides.discovery.respectRobots = false;

  const config = await loadConfig({ configPath: args.config ? absolute(args.config) : undefined, overrides });
  const manifest = await discoverSite({ url, out, config, logger: json ? { info() {}, warn() {}, error() {} } : undefined });
  const summary = {
    ...manifest.summary,
    routesFile: join(out, "evidence", "routes.json"),
    graphFile: join(out, "evidence", "site-graph.json"),
    reportFile: join(out, "evidence", "discovery-report.md"),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ summary, routes: manifest.routes.map((route) => ({ localRoute: route.localRoute, title: route.title, type: route.routeType, status: route.discoveryStatus })), excluded: manifest.excluded, redirects: manifest.redirects }, null, 2)}\n`);
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (manifest.excluded.length) console.log(`Excluded ${manifest.excluded.length} route(s); see the discovery report for reasons.`);
  if (manifest.redirects.length) console.log(`Recorded ${manifest.redirects.length} redirect/canonical alias(es).`);
  console.log(`Route manifest: ${join(out, "evidence", "routes.json")}`);
}

main().catch((error) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(error.message);
  process.exitCode = 1;
});
