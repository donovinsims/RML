import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readJson, writeJson } from "./core.mjs";

export const CORRECTION_PRIORITIES = [
  { priority: 1, category: "fonts", action: "Fix font loading and metrics before any layout correction; rebaseline all affected line wrapping." },
  { priority: 2, category: "tokens", action: "Correct root design tokens and shared container widths." },
  { priority: 3, category: "geometry", action: "Correct section dimensions, alignment, padding, and gaps against the captured geometry." },
  { priority: 4, category: "responsive", action: "Correct responsive layout and mobile navigation behavior; verify direct and in-menu destinations." },
  { priority: 5, category: "content", action: "Correct missing or mismatched page content, headings, and deep-link fallbacks." },
  { priority: 6, category: "images", action: "Correct image crops, intrinsic sizing, and missing media." },
  { priority: 7, category: "visual", action: "Correct background layers, effects, colors, and visual composition." },
  { priority: 8, category: "components", action: "Correct shared component geometry and computed style." },
  { priority: 9, category: "interactions", action: "Correct authored interaction states, links, history, and route transitions." },
  { priority: 10, category: "micro", action: "Correct remaining micro-spacing and optical details after structural gates pass." },
];

const CATEGORY_PRIORITY = {
  fonts: 1,
  tokens: 2,
  geometry: 3,
  "mobile-navigation": 4,
  "deep-link": 4,
  content: 5,
  images: 6,
  visual: 7,
  links: 9,
  history: 9,
  capture: 0,
  evidence: 0,
};

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function selectedRoutes(manifest) {
  return (manifest.routes || []).filter((route) => route.discoveryStatus === "discovered");
}

function evidencePath(out, route) {
  return route.evidenceFile
    ? join(out, route.evidenceFile)
    : join(out, "evidence", "routes", `${route.localRoute === "/" ? "index" : route.localRoute.replace(/^\//, "").replace(/\//g, "-")}.json`);
}

async function optionalJson(path) {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

/**
 * Build one evidence-grounded brief from the canonical manifest. It is a
 * planning artifact for an agent, not a substitute for the source evidence.
 */
export async function buildBuildBrief({ manifest, out }) {
  const routes = selectedRoutes(manifest);
  const contracts = [];
  const fonts = new Set();
  const variables = new Map();
  const variableConflicts = [];
  const breakpoints = new Set();
  const routeSummaries = [];
  const missingEvidence = [];

  for (const route of routes) {
    const evidence = await optionalJson(evidencePath(out, route));
    if (!evidence) {
      missingEvidence.push({ route: route.localRoute, expected: evidencePath(out, route), reason: "No captured evidence." });
      routeSummaries.push({ localRoute: route.localRoute, title: route.title, captureStatus: route.captureStatus, evidence: null });
      continue;
    }
    const routeContracts = [];
    const observations = [];
    for (const viewport of evidence.viewports || []) {
      let observation;
      try {
        observation = await readJson(join(out, viewport.observation));
      } catch {
        continue;
      }
      observations.push({ viewport: viewport.name, observation });
      for (const font of observation.fonts || []) fonts.add(`${font.family}|${font.weight}|${font.style}`);
      for (const [name, value] of Object.entries(observation.cssVariables || {})) {
        if (variables.has(name) && variables.get(name) !== value) variableConflicts.push({ name, values: [...new Set([variables.get(name), value])] });
        else variables.set(name, value);
      }
      for (const section of observation.sections || []) {
        routeContracts.push({
          sourceRoute: route.localRoute,
          viewport: viewport.name,
          selector: section.selector,
          tag: section.tag,
          heading: section.heading,
          text: section.text,
          geometry: section.rect,
          typography: {
            fontFamily: section.style?.fontFamily,
            fontSize: section.style?.fontSize,
            fontWeight: section.style?.fontWeight,
            lineHeight: section.style?.lineHeight,
            letterSpacing: section.style?.letterSpacing,
          },
          color: section.style?.color,
          background: {
            backgroundColor: section.style?.backgroundColor,
            backgroundImage: section.style?.backgroundImage,
            backgroundSize: section.style?.backgroundSize,
          },
          layers: { before: section.before, after: section.after },
          evidenceFile: viewport.observation,
          unresolved: [
            section.before?.backgroundImage === "none" ? null : "Verify pseudo-element compositing against the screenshot.",
            viewport.stabilization?.timedOut?.length ? `Stabilization timed out: ${viewport.stabilization.timedOut.join(", ")}` : null,
          ].filter(Boolean),
        });
      }
    }
    for (const transition of evidence.breakpoints?.transitions || []) breakpoints.add(transition.breakpoint);
    contracts.push(...routeContracts);
    routeSummaries.push({
      localRoute: route.localRoute,
      title: route.title,
      routeType: route.routeType,
      sourceUrl: route.sourceUrl,
      captureStatus: route.captureStatus,
      evidenceFile: route.evidenceFile,
      viewports: (evidence.viewports || []).map((viewport) => ({ name: viewport.name, width: viewport.width, height: viewport.height })),
      warnings: evidence.warnings || [],
      contracts: routeContracts.length,
      unresolved: evidence.failures || [],
    });
  }

  const shared = new Map();
  for (const contract of contracts) {
    const key = `${contract.tag}|${contract.heading || ""}|${contract.selector}`;
    const entry = shared.get(key) || { key, selector: contract.selector, tag: contract.tag, heading: contract.heading, routes: new Set(), viewports: new Set() };
    entry.routes.add(contract.sourceRoute);
    entry.viewports.add(contract.viewport);
    shared.set(key, entry);
  }
  const sharedComponents = [...shared.values()]
    .filter((entry) => entry.routes.size > 1)
    .map((entry) => ({ selector: entry.selector, tag: entry.tag, heading: entry.heading, routes: [...entry.routes], viewports: [...entry.viewports] }))
    .slice(0, 80);

  const graph = await optionalJson(join(out, "evidence", "site-graph.json"));
  return {
    version: 1,
    kind: "rml-build-brief",
    generatedAt: new Date().toISOString(),
    mode: manifest.mode || "exact-reconstruction",
    site: manifest.site,
    sourceOfTruth: "evidence/routes.json",
    routeManifest: "evidence/routes.json",
    routes: routeSummaries,
    foundations: {
      fonts: [...fonts].sort(),
      cssVariables: Object.fromEntries([...variables.entries()].sort(([left], [right]) => left.localeCompare(right))),
      variableConflicts,
      observedBreakpoints: [...breakpoints].sort((left, right) => left - right),
      sharedComponents,
      graph: graph ? { globalNavigation: graph.globalNavigation, dropdownNavigation: graph.dropdownNavigation, breadcrumbs: graph.breadcrumbs, orphans: graph.orphans } : null,
    },
    componentContracts: contracts.slice(0, 240),
    unresolved: {
      missingEvidence,
      failedRoutes: (manifest.routes || []).filter((route) => route.discoveryStatus === "failed").map((route) => ({ localRoute: route.localRoute, httpStatus: route.httpStatus })),
      excludedRoutes: manifest.excluded || [],
      redirects: manifest.redirects || [],
    },
    acceptance: [
      "Every selected route has a local implementation and loads directly on refresh.",
      "Internal links and mobile navigation stay on the local clone inventory.",
      "Fonts, root tokens, containers, and responsive breakpoints precede page-local work.",
      "Every route passes visual, geometry, link, history, and authored-scenario gates or is explicitly review/blocked.",
      "Intentional substitutions and unresolved source routes are recorded, never hidden as passes.",
    ],
  };
}

export async function writeBuildBrief({ manifest, out }) {
  const brief = await buildBuildBrief({ manifest, out });
  const directory = join(out, "rebuild");
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "build-brief.json"), brief);
  const md = [
    "# Build brief",
    "",
    `- Source: ${brief.site?.sourceUrl || "unknown"}`,
    `- Mode: ${brief.mode}`,
    `- Routes: ${brief.routes.length}`,
    "",
    "## Foundations",
    "",
    `- Fonts: ${brief.foundations.fonts.join(", ") || "none observed"}`,
    `- CSS variables: ${Object.keys(brief.foundations.cssVariables).length}`,
    `- Shared components: ${brief.foundations.sharedComponents.length}`,
    `- Observed breakpoints: ${brief.foundations.observedBreakpoints.join(", ") || "none"}`,
    "",
    "## Routes",
    "",
    "| Route | Title | Capture | Contracts |",
    "| --- | --- | --- | ---: |",
    ...brief.routes.map((route) => `| ${route.localRoute} | ${route.title || "-"} | ${route.captureStatus || "-"} | ${route.contracts || 0} |`),
    "",
    "## Acceptance",
    "",
    ...brief.acceptance.map((item) => `- ${item}`),
    "",
    "## Unresolved",
    "",
    `- Missing evidence: ${brief.unresolved.missingEvidence.length}`,
    `- Failed source routes: ${brief.unresolved.failedRoutes.length}`,
    `- Excluded source routes: ${brief.unresolved.excludedRoutes.length}`,
    "",
  ].join("\n");
  await writeFile(join(directory, "build-brief.md"), md);
  return { brief, json: join(directory, "build-brief.json"), markdown: join(directory, "build-brief.md") };
}

function actionFor(category, message) {
  if (category === "links") return `Map internal navigation to local manifest routes and remove source-origin escapes. Evidence: ${message}`;
  if (category === "history") return `Restore browser back/forward behavior for the affected route. Evidence: ${message}`;
  if (category === "mobile-navigation") return `Repair responsive navigation so its destinations are local and reachable. Evidence: ${message}`;
  if (category === "deep-link") return `Implement the direct nested route and refresh behavior. Evidence: ${message}`;
  if (category === "content") return `Reconcile page content, headings, and homepage fallback with the captured observation. Evidence: ${message}`;
  if (category === "geometry") return `Correct section geometry and shared container metrics. Evidence: ${message}`;
  if (category === "visual") return `Correct compositing, background layers, assets, and visual properties. Evidence: ${message}`;
  if (category === "fonts") return `Fix fonts and font metrics, then recheck wrapping. Evidence: ${message}`;
  return `${category}: ${message}`;
}

/**
 * Convert route failures into a causal correction plan. Verified routes are
 * kept out of the edit set and recorded for regression protection.
 */
export function deriveCorrectionPlan(report) {
  const corrections = [];
  const unresolved = [];
  const seen = new Set();
  for (const route of report.routes || []) {
    for (const issue of [...(route.blockers || []), ...(route.reviews || [])]) {
      const category = issue.category || "visual";
      if (category === "evidence" || category === "capture") {
        unresolved.push({ route: route.route, category, message: issue.message });
        continue;
      }
      const priority = CATEGORY_PRIORITY[category] ?? 8;
      const key = `${route.route}|${category}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      corrections.push({
        priority,
        route: route.route,
        category,
        action: actionFor(category, issue.message),
        evidence: issue.message,
        severity: route.status === "failed" ? "fail" : "review",
      });
    }
  }
  corrections.sort((left, right) => left.priority - right.priority || left.route.localeCompare(right.route));
  const verified = (report.routes || []).filter((route) => route.status === "verified").map((route) => route.route);
  return {
    generatedAt: new Date().toISOString(),
    hierarchy: CORRECTION_PRIORITIES.map((entry) => `${entry.priority}. ${entry.category}: ${entry.action}`),
    corrections,
    keep: verified,
    recheck: (report.routes || []).map((route) => route.route),
    unresolved,
    verdict: report.routeGate || "unknown",
  };
}

export function correctionPlanMarkdown(plan) {
  return [
    "# Correction plan",
    "",
    `- Verdict: **${plan.verdict}**`,
    `- Corrections: ${plan.corrections.length}`,
    `- Keep (verified): ${plan.keep.join(", ") || "none"}`,
    `- Recheck: ${plan.recheck.join(", ") || "none"}`,
    "",
    "## Ordered corrections",
    "",
    "| Priority | Route | Category | Action |",
    "| ---: | --- | --- | --- |",
    ...plan.corrections.map((item) => `| ${item.priority} | ${item.route} | ${item.category} | ${item.action.replace(/\|/g, "\\|")} |`),
    "",
    "## Unresolved evidence",
    "",
    ...(plan.unresolved.length ? plan.unresolved.map((item) => `- ${item.route} [${item.category}]: ${item.message}`) : ["None."]),
    "",
    "## Causal hierarchy",
    "",
    ...plan.hierarchy.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function normalizeAdapter(adapter) {
  if (!adapter) return null;
  if (typeof adapter === "string") return { command: [adapter] };
  if (Array.isArray(adapter)) return { command: adapter };
  if (typeof adapter === "object" && adapter.command) return adapter;
  throw new Error("Agent adapter must provide a command array or object with command.");
}

/** Run a coding agent as a child process with explicit brief/correction paths. */
export async function runCommandAdapter({ adapter, briefPath, correctionPath, project, round, out, timeoutMs = 300_000 }) {
  const normalized = normalizeAdapter(adapter);
  if (!normalized) throw new Error("No agent adapter configured.");
  const command = Array.isArray(normalized.command) ? normalized.command[0] : normalized.command;
  const baseArgs = Array.isArray(normalized.command) ? normalized.command.slice(1) : [];
  const args = [...baseArgs, ...(normalized.args || [])];
  if (!command) throw new Error("Agent adapter command is empty.");
  const cwd = normalized.cwd ? resolve(normalized.cwd) : project ? resolve(project) : process.cwd();
  const logPath = join(out, "rebuild", `round-${round}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...(normalized.env || {}),
      PIXEL_PERFECT_BRIEF: briefPath,
      PIXEL_PERFECT_CORRECTIONS: correctionPath,
      PIXEL_PERFECT_PROJECT: project || "",
      PIXEL_PERFECT_ROUND: String(round),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, Math.max(1_000, Math.min(timeoutMs, 600_000)));
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  }).finally(() => clearTimeout(timer));
  await writeFile(logPath, `Command: ${[command, ...args].join(" ")}\n\nSTDOUT\n${stdout}\n\nSTDERR\n${stderr}\n`);
  if (timedOut) throw new Error(`Agent adapter exceeded ${timeoutMs}ms. See ${logPath}.`);
  if (exitCode !== 0) throw new Error(`Agent adapter exited ${exitCode}. See ${logPath}.`);
  return { exitCode, stdout, stderr, logPath, command: [command, ...args] };
}

function scoreReport(report) {
  const routes = report.routes || [];
  return {
    verified: routes.filter((route) => route.status === "verified").length,
    review: routes.filter((route) => route.status === "review").length,
    failed: routes.filter((route) => route.status === "failed").length,
    blocked: routes.filter((route) => route.status === "blocked").length,
    score: routes.filter((route) => route.status === "verified").length * 4
      + routes.filter((route) => route.status === "review").length * 2,
  };
}

function markdownLoop(report) {
  return [
    "# Rebuild correction report",
    "",
    `- Stop reason: **${report.stopReason}**`,
    `- Final route gate: **${report.finalReport?.routeGate || "unknown"}**`,
    `- Rounds: ${report.rounds.length}`,
    `- Adapter calls: ${report.adapterCalls}`,
    `- Regression detected: ${report.regression ? "yes" : "no"}`,
    "",
    "| Round | Route gate | Verified | Review | Failed | Blocked | Corrections |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.rounds.map((round) => `| ${round.round} | ${round.routeGate || "-"} | ${round.verified} | ${round.review} | ${round.failed} | ${round.blocked} | ${round.corrections} |`),
    "",
    "## Keep / recheck",
    "",
    ...(report.plan ? [`- Keep: ${report.plan.keep.join(", ") || "none"}`, `- Recheck: ${report.plan.recheck.join(", ") || "none"}`] : ["No correction plan."]),
    "",
    "## Unresolved",
    "",
    ...(report.unresolved?.length ? report.unresolved.map((item) => `- ${item.route || "site"} [${item.category}]: ${item.message}`) : ["None."]),
    "",
  ].join("\n");
}

/**
 * Bounded correction loop. Verification is injected so the loop can be tested
 * without a browser and so callers can reuse a site report implementation.
 */
export async function runCorrectionLoop({
  manifest,
  out,
  project = null,
  adapter = null,
  verify,
  maxRounds = 3,
  maxStallRounds = 2,
  logger = { info() {}, warn() {} },
}) {
  if (typeof verify !== "function") throw new Error("runCorrectionLoop requires a verify callback.");
  const brief = await writeBuildBrief({ manifest, out });
  const directory = join(out, "rebuild");
  let plan = null;
  let current;
  try {
    current = await verify({ round: 0, brief: brief.brief });
  } catch (error) {
    const failure = {
      stopReason: "verification-failed",
      finalReport: null,
      rounds: [],
      adapterCalls: 0,
      regression: false,
      plan: null,
      unresolved: [{ category: "verification", message: error.message.split("\n")[0] }],
      brief: brief.json,
    };
    await writeJson(join(directory, "correction-report.json"), failure);
    await writeFile(join(directory, "correction-report.md"), markdownLoop(failure));
    return failure;
  }
  const history = [];
  let adapterCalls = 0;
  let stallCount = 0;
  let regression = false;
  let stopReason = null;
  let finalReport = current;

  if (current.routeGate === "verified") {
    stopReason = "route-gate-verified";
  } else if (!adapter) {
    stopReason = "adapter-unavailable";
  }

  for (let round = 1; !stopReason && round <= maxRounds; round += 1) {
    plan = deriveCorrectionPlan(current);
    await writeJson(join(directory, `corrections-${round}.json`), plan);
    await writeFile(join(directory, `corrections-${round}.md`), correctionPlanMarkdown(plan));
    if (!plan.corrections.length) {
      stopReason = "no-actionable-corrections";
      break;
    }
    const before = scoreReport(current);
    logger.info?.(`[rebuild] round ${round}: ${plan.corrections.length} correction(s), ${before.verified} verified route(s)`);
    try {
      adapterCalls += 1;
      await runCommandAdapter({
        adapter,
        briefPath: brief.json,
        correctionPath: join(directory, `corrections-${round}.json`),
        project,
        round,
        out,
        timeoutMs: adapter.timeoutMs || 300_000,
      });
    } catch (error) {
      stopReason = "adapter-failed";
      finalReport = current;
      history.push({ round, routeGate: current.routeGate, ...before, corrections: plan.corrections.length, error: error.message.split("\n")[0] });
      break;
    }

    let next;
    try {
      next = await verify({ round, corrections: plan, brief: brief.brief });
    } catch (error) {
      stopReason = "verification-failed";
      history.push({ round, routeGate: current.routeGate, ...before, corrections: plan.corrections.length, error: error.message.split("\n")[0] });
      break;
    }
    const after = scoreReport(next);
    const previousVerified = new Set((current.routes || []).filter((route) => route.status === "verified").map((route) => route.route));
    const regressed = (next.routes || []).filter((route) => previousVerified.has(route.route) && route.status !== "verified");
    if (regressed.length) {
      regression = true;
      stopReason = "regression";
      history.push({ round, routeGate: next.routeGate, ...after, corrections: plan.corrections.length, regressed: regressed.map((route) => route.route) });
      finalReport = next;
      break;
    }
    history.push({ round, routeGate: next.routeGate, ...after, corrections: plan.corrections.length });
    finalReport = next;
    if (next.routeGate === "verified") {
      stopReason = "route-gate-verified";
      break;
    }
    if (after.score <= before.score) stallCount += 1;
    else stallCount = 0;
    if (stallCount >= maxStallRounds) {
      stopReason = "stalled";
      break;
    }
    current = next;
  }

  if (!stopReason) stopReason = "max-rounds";
  const result = {
    version: 1,
    kind: "rml-rebuild-report",
    generatedAt: new Date().toISOString(),
    stopReason,
    finalReport,
    rounds: history,
    adapterCalls,
    regression,
    plan,
    brief: brief.json,
    unresolved: (finalReport?.routes || []).flatMap((route) => (route.blockers || []).filter((issue) => issue.category === "evidence" || issue.category === "capture").map((issue) => ({ route: route.route, ...issue }))),
  };
  await writeJson(join(directory, "correction-report.json"), result);
  await writeFile(join(directory, "correction-report.md"), markdownLoop(result));
  return result;
}
