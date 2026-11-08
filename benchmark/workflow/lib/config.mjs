import { readFile } from "node:fs/promises";

export const DEFAULT_CONFIG = {
  discovery: {
    maxPages: 50,
    maxDepth: 3,
    concurrency: 3,
    requestDelayMs: 150,
    timeoutMs: 30_000,
    retries: 1,
    include: [],
    exclude: [],
    sameOrigin: true,
    render: true,
    revealNavigation: true,
    maxNavigationInteractions: 8,
    maxLinksPerPage: 300,
    maxQueryVariants: 12,
    maxSitemaps: 10,
    maxDurationMs: 180_000,
    userAgent: "RMLBenchmark/1.0",
    respectRobots: true,
    pagination: { maxPages: 5 },
  },
  capture: {
    viewports: {
      desktop: { width: 1440, height: 1000 },
      tablet: { width: 768, height: 1000 },
      mobile: { width: 390, height: 844 },
    },
    breakpoints: {
      enabled: true,
      candidates: [320, 360, 390, 414, 480, 600, 640, 768, 820, 900, 1024, 1180, 1280, 1440],
      timeoutMs: 60_000,
    },
    interactionStates: "pseudo",
    maxStates: 80,
    timeoutMs: 30_000,
    maxRoutes: 50,
    scrollForLazy: true,
  },
  verification: {
    thresholds: { pass: 0.005, review: 0.02 },
    geometry: { control: 1, section: 2 },
    maxImageBytes: 512 * 1024 * 1024,
    maxImageTile: 64,
  },
  rebuild: {
    maxRounds: 5,
    maxStallRounds: 2,
    adapter: null,
    project: null,
  },
};

export class ConfigError extends Error {
  constructor(issues) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultConfig() {
  return cloneConfig(DEFAULT_CONFIG);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep merge; arrays replace rather than concatenate so scope stays predictable. */
export function mergeConfig(...layers) {
  const result = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      result[key] = isPlainObject(value)
        ? mergeConfig(isPlainObject(result[key]) ? result[key] : {}, value)
        : Array.isArray(value)
          ? [...value]
          : value;
    }
  }
  return result;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function validateConfig(config) {
  const issues = [];
  const discovery = config.discovery || {};
  const capture = config.capture || {};
  const verification = config.verification || {};
  const rebuild = config.rebuild || {};

  for (const key of ["maxPages", "maxDepth", "concurrency", "maxLinksPerPage", "maxQueryVariants", "maxSitemaps", "maxNavigationInteractions"]) {
    if (!isPositiveInteger(discovery[key])) issues.push(`discovery.${key} must be a positive integer.`);
  }
  if (discovery.maxDepth > 20) issues.push("discovery.maxDepth must be 20 or less.");
  if (discovery.concurrency > 10) issues.push("discovery.concurrency must be 10 or less.");
  for (const key of ["requestDelayMs", "timeoutMs", "maxDurationMs"]) {
    if (!Number.isFinite(discovery[key]) || discovery[key] < 0) issues.push(`discovery.${key} must be a non-negative number.`);
  }
  if (!Number.isInteger(discovery.retries) || discovery.retries < 0 || discovery.retries > 5) {
    issues.push("discovery.retries must be an integer between 0 and 5.");
  }
  if (!Array.isArray(discovery.include) || !Array.isArray(discovery.exclude)) {
    issues.push("discovery.include and discovery.exclude must be arrays of glob strings.");
  }
  if (!isPositiveInteger(discovery.pagination?.maxPages)) {
    issues.push("discovery.pagination.maxPages must be a positive integer.");
  }
  if (typeof discovery.userAgent !== "string" || !discovery.userAgent.trim()) {
    issues.push("discovery.userAgent must be a non-empty string.");
  }

  if (!isPlainObject(capture.viewports)) issues.push("capture.viewports must be an object.");
  for (const [name, viewport] of Object.entries(capture.viewports || {})) {
    if (!isPositiveInteger(viewport?.width) || !isPositiveInteger(viewport?.height)) {
      issues.push(`capture.viewports.${name} needs positive integer width and height.`);
    }
  }
  if (!["pseudo", "none", "scenario"].includes(capture.interactionStates)) {
    issues.push("capture.interactionStates must be one of pseudo, none, scenario.");
  }
  for (const key of ["maxStates", "timeoutMs", "maxRoutes"]) {
    if (!isPositiveInteger(capture[key])) issues.push(`capture.${key} must be a positive integer.`);
  }
  if (!isPositiveInteger(capture.breakpoints?.timeoutMs)) {
    issues.push("capture.breakpoints.timeoutMs must be a positive integer.");
  }

  const thresholds = verification.thresholds || {};
  if (!(thresholds.pass > 0 && thresholds.pass < 1)) issues.push("verification.thresholds.pass must be between 0 and 1.");
  if (!(thresholds.review >= thresholds.pass && thresholds.review < 1)) {
    issues.push("verification.thresholds.review must be at least pass and below 1.");
  }
  for (const key of ["control", "section"]) {
    if (!Number.isFinite(verification.geometry?.[key]) || verification.geometry[key] < 0) {
      issues.push(`verification.geometry.${key} must be a non-negative number.`);
    }
  }
  if (!isPositiveInteger(verification.maxImageBytes)) issues.push("verification.maxImageBytes must be a positive integer.");

  if (!isPositiveInteger(rebuild.maxRounds) || rebuild.maxRounds > 20) issues.push("rebuild.maxRounds must be between 1 and 20.");
  if (!isPositiveInteger(rebuild.maxStallRounds) || rebuild.maxStallRounds > rebuild.maxRounds) {
    issues.push("rebuild.maxStallRounds must be a positive integer no larger than rebuild.maxRounds.");
  }
  if (rebuild.adapter && typeof rebuild.adapter !== "object") issues.push("rebuild.adapter must be null or an object.");

  if (issues.length) throw new ConfigError(issues);
  return config;
}

export async function loadConfig({ configPath, overrides = {} } = {}) {
  let fileConfig = {};
  if (configPath) {
    let text;
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      throw new ConfigError([`Unable to read ${configPath}: ${error.message}`]);
    }
    try {
      fileConfig = JSON.parse(text);
    } catch (error) {
      throw new ConfigError([`${configPath} is not valid JSON: ${error.message}`]);
    }
  }
  const merged = mergeConfig(defaultConfig(), fileConfig, overrides);
  // A viewport map is a complete selection, not a set of defaults to extend.
  // Deep merge would otherwise make it impossible to drop a default viewport.
  for (const layer of [fileConfig, overrides]) {
    if (isPlainObject(layer?.capture?.viewports)) {
      merged.capture.viewports = cloneConfig(layer.capture.viewports);
    }
  }
  return validateConfig(merged);
}
