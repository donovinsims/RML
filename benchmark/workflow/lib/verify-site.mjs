import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadBrowser, readJson, stablePage, stabilize, writeJson } from "./core.mjs";
import { compareScreenshots } from "./diff.mjs";
import { classifyGeometry, matchSections, sectionFingerprint, textSimilarity } from "./match.mjs";
import { observePage } from "./capture.mjs";
import { classifyPageLinks, pageLinkSnapshot } from "./links.mjs";
import { localRouteFor, routeSlug } from "./url.mjs";
import { compareScenarioEvidence, runScenarioSuite, scenarioReportMarkdown } from "./scenario.mjs";

const PASS = "verified";
const REVIEW = "review";
const FAIL = "failed";
const BLOCKED = "blocked";

function localOf(value) {
  try {
    return localRouteFor(value);
  } catch {
    return null;
  }
}

/** Client-side routers update history after the click event, so poll briefly. */
async function waitForLocalRoute(page, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let current = localOf(page.url());
  while (Date.now() < deadline) {
    current = localOf(page.url());
    if (current === expected) return current;
    await page.waitForTimeout(50);
  }
  return current;
}

function sourceEvidencePath(out, route) {
  if (route.evidenceFile) return join(out, route.evidenceFile);
  return join(out, "evidence", "routes", `${routeSlug(route.canonicalUrl || route.sourceUrl || route.localRoute)}.json`);
}

async function readEvidence(out, route) {
  try {
    const evidence = await readJson(sourceEvidencePath(out, route));
    return evidence?.kind === "rml-route-evidence" ? evidence : null;
  } catch {
    return null;
  }
}

async function openClone(browser, viewport, url, timeoutMs, scroll = false) {
  const { context, page } = await stablePage(browser, viewport);
  let response = null;
  page.on("response", (candidate) => {
    if (!response && candidate.request().isNavigationRequest() && candidate.frame() === page.mainFrame()) response = candidate;
  });
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  const stabilization = await stabilize(page, url, { timeoutMs, scroll });
  if (scroll) {
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
  }
  return { context, page, response, stabilization };
}

async function visualFor({ out, routeDir, route, viewportResult, page }) {
  const clonePath = join(routeDir, `${viewportResult.name}.png`);
  await mkdir(routeDir, { recursive: true });
  await page.screenshot({ path: clonePath, fullPage: true, animations: "disabled" });
  let sourceBuffer;
  try {
    sourceBuffer = await readFile(join(out, viewportResult.screenshot));
  } catch (error) {
    return { status: FAIL, error: error.code || "MISSING_SOURCE_SCREENSHOT", cloneScreenshot: relative(out, clonePath) };
  }
  let cloneBuffer;
  try {
    cloneBuffer = await readFile(clonePath);
  } catch (error) {
    return { status: FAIL, error: error.code || "MISSING_CLONE_SCREENSHOT", cloneScreenshot: relative(out, clonePath) };
  }
  try {
    const comparison = await compareScreenshots(sourceBuffer, cloneBuffer, { threshold: 0.1 });
    const { diffPng, ...rest } = comparison;
    if (diffPng) await writeFile(join(routeDir, `${viewportResult.name}-diff.png`), diffPng);
    const status = comparison.dimensionMismatch || comparison.changeRatio > 0.02
      ? FAIL
      : comparison.changeRatio > 0.005 ? REVIEW : "pass";
    return { ...rest, status, cloneScreenshot: relative(out, clonePath) };
  } catch (error) {
    return { status: FAIL, error: error.code || "IMAGE_COMPARE_FAILED", message: error.message.split("\n")[0], cloneScreenshot: relative(out, clonePath) };
  }
}

function titleCheck(sourceObservation, cloneObservation, route, homeTitle) {
  const sourceTitle = sourceObservation?.title || route.title || "";
  const cloneTitle = cloneObservation?.title || "";
  if (!cloneTitle) return { status: FAIL, message: "Clone page has no title." };
  if (cloneTitle === sourceTitle) return { status: "measured", source: sourceTitle, clone: cloneTitle };
  if (route.localRoute !== "/" && homeTitle && cloneTitle === homeTitle && sourceTitle !== homeTitle) {
    return { status: FAIL, message: "Nested route is serving the homepage title; this is a silent homepage fallback.", source: sourceTitle, clone: cloneTitle };
  }
  return { status: REVIEW, message: "Page title differs from the source observation.", source: sourceTitle, clone: cloneTitle };
}

function headingCheck(sourceObservation, cloneObservation) {
  const sourceHeading = sourceObservation?.headings?.[0] || "";
  const cloneHeading = cloneObservation?.headings?.[0] || "";
  if (!sourceHeading) return { status: "not-observed", message: "Source evidence contains no heading." };
  if (!cloneHeading) return { status: FAIL, message: "Clone page contains no heading." };
  if (sourceHeading === cloneHeading) return { status: "measured", source: sourceHeading, clone: cloneHeading };
  const similarity = textSimilarity(sourceHeading, cloneHeading);
  return {
    status: similarity >= 0.8 ? REVIEW : FAIL,
    similarity: Number(similarity.toFixed(3)),
    message: similarity >= 0.8 ? "Primary heading differs; review copy and layout." : "Primary heading differs materially.",
    source: sourceHeading,
    clone: cloneHeading,
  };
}

function fontCheck(sourceObservation, cloneObservation) {
  const sourceFonts = new Set((sourceObservation?.fonts || []).map((font) => `${font.family}|${font.weight}|${font.style}`));
  const cloneFonts = new Set((cloneObservation?.fonts || []).map((font) => `${font.family}|${font.weight}|${font.style}`));
  if (!sourceFonts.size) return { status: "not-observed", message: "No loaded font metadata in source evidence." };
  const missing = [...sourceFonts].filter((font) => !cloneFonts.has(font));
  return missing.length
    ? { status: REVIEW, missing: missing.slice(0, 20), message: `${missing.length} source font face(s) not observed in the clone.` }
    : { status: "measured", message: "Loaded font families, weights, and styles match." };
}

function geometryCheck(sourceObservation, cloneObservation, config) {
  const sourceSections = (sourceObservation?.sections || []).map((section) => ({ ...section, fingerprint: section.fingerprint || sectionFingerprint(section) }));
  const cloneSections = (cloneObservation?.sections || []).map((section) => ({ ...section, fingerprint: sectionFingerprint(section) }));
  const comparisons = matchSections(sourceSections, cloneSections).map((comparison) => ({
    ...comparison,
    geometryStatus: comparison.status === "fail"
      ? FAIL
      : classifyGeometry(comparison.deltas, {
          controlTolerance: config.verification.geometry.control,
          sectionTolerance: config.verification.geometry.section,
        }),
  }));
  const failed = comparisons.filter((comparison) => comparison.status === "fail" || comparison.geometryStatus === "fail");
  const review = comparisons.filter((comparison) => comparison.status === "review" || comparison.geometryStatus === "review" || (comparison.styleMatches && Object.values(comparison.styleMatches).some((value) => !value)));
  const status = failed.length ? FAIL : review.length || !comparisons.length ? REVIEW : "pass";
  return { status, comparisons, failed: failed.length, review: review.length, sourceSections: sourceSections.length, cloneSections: cloneSections.length };
}

async function directAndViewports({ browser, out, route, cloneUrl, evidence, config, homeTitle, routeDir }) {
  const results = [];
  for (const viewportResult of evidence.viewports || []) {
    let sourceObservation;
    try {
      sourceObservation = await readJson(join(out, viewportResult.observation));
    } catch (error) {
      results.push({ name: viewportResult.name, status: BLOCKED, error: `Missing source observation: ${error.message.split("\n")[0]}` });
      continue;
    }
    const target = new URL(route.localRoute, cloneUrl).href;
    const { context, page, response, stabilization } = await openClone(browser, {
      width: viewportResult.width,
      height: viewportResult.height,
    }, target, config.capture.timeoutMs, true);
    try {
      const cloneObservation = await page.evaluate(observePage);
      cloneObservation.sections = (cloneObservation.sections || []).map((section) => ({ ...section, fingerprint: sectionFingerprint(section) }));
      const finalRoute = localOf(page.url());
      const status = response?.status() ?? (stabilization.navigationError ? null : 200);
      const direct = {
        status: stabilization.navigationError || !status || status >= 400 || finalRoute !== route.localRoute ? FAIL : "pass",
        httpStatus: status,
        finalUrl: page.url(),
        expectedRoute: route.localRoute,
        error: stabilization.navigationError || null,
      };
      const visual = await visualFor({ out, routeDir, route, viewportResult, page });
      const title = titleCheck(sourceObservation, cloneObservation, route, homeTitle);
      const heading = headingCheck(sourceObservation, cloneObservation);
      const fonts = fontCheck(sourceObservation, cloneObservation);
      const geometry = geometryCheck(sourceObservation, cloneObservation, config);
      const statuses = [direct.status, visual.status, title.status, heading.status, fonts.status, geometry.status];
      const viewportStatus = statuses.includes(FAIL)
        ? FAIL
        : statuses.includes(REVIEW) ? REVIEW : "pass";
      results.push({
        name: viewportResult.name,
        status: viewportStatus,
        direct,
        visual,
        title,
        heading,
        fonts,
        geometry,
        sourceObservation: viewportResult.observation,
        cloneScreenshot: visual.cloneScreenshot,
      });
    } finally {
      await context.close().catch(() => {});
    }
  }
  return results;
}

async function inspectLinks(page, { manifest, cloneUrl, sourceOrigin, route }) {
  const links = await page.evaluate(pageLinkSnapshot);
  const classified = classifyPageLinks({ links, manifest, cloneUrl, sourceOrigin });
  const visibleInternal = classified.links.filter((link) => link.kind === "internal" && link.visible !== false);
  return { ...classified, visibleInternal, route: route.localRoute };
}

async function historyCheck({ browser, cloneUrl, route, config, manifest, sourceOrigin }) {
  const target = new URL(route.localRoute, cloneUrl).href;
  const { context, page } = await openClone(browser, config.capture.viewports.desktop || { width: 1440, height: 1000 }, target, config.capture.timeoutMs);
  try {
    const links = await page.evaluate(pageLinkSnapshot);
    const classified = classifyPageLinks({ links, manifest, cloneUrl, sourceOrigin });
    const candidate = classified.links.find((link) => link.kind === "internal" && link.visible !== false && link.localRoute !== route.localRoute);
    if (!candidate) {
      return { status: "not-tested", message: "No different internal link is available for a back/forward exercise." };
    }
    const locator = page.locator("a[href]").nth(candidate.index);
    await locator.click({ timeout: 5_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    const destination = await waitForLocalRoute(page, candidate.localRoute);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
    const backRoute = await waitForLocalRoute(page, route.localRoute);
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
    const forwardRoute = await waitForLocalRoute(page, candidate.localRoute);
    const pass = destination !== null && backRoute === route.localRoute && forwardRoute === destination;
    return {
      status: pass ? "pass" : FAIL,
      candidate: candidate.localRoute,
      destination,
      backRoute,
      forwardRoute,
      message: pass ? "Back and forward return to the expected local routes." : "Browser history did not return to the expected local routes.",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function mobileCheck({ browser, cloneUrl, route, config, manifest, sourceOrigin }) {
  const viewport = config.capture.viewports.mobile || { width: 390, height: 844 };
  const target = new URL(route.localRoute, cloneUrl).href;
  const { context, page } = await openClone(browser, viewport, target, config.capture.timeoutMs);
  try {
    const toggles = page.locator("button[aria-controls]:visible");
    if (!(await toggles.count())) return { status: "not-applicable", message: "No visible control with aria-controls at the mobile viewport." };
    const toggle = toggles.first();
    const controls = await toggle.getAttribute("aria-controls");
    await toggle.click({ timeout: 5_000 });
    const panel = page.locator(`[id="${String(controls).replace(/"/g, '\\"')}"]`).first();
    if (!(await panel.isVisible().catch(() => false))) return { status: FAIL, message: `Mobile control did not reveal #${controls}.` };
    const links = await page.evaluate(pageLinkSnapshot);
    const classified = classifyPageLinks({ links, manifest, cloneUrl, sourceOrigin });
    const internal = classified.links.filter((link) => link.kind === "internal" && link.visible !== false);
    if (!internal.length) return { status: FAIL, message: "Mobile navigation revealed no internal clone destination.", summary: classified.summary };
    const candidate = internal.find((link) => link.localRoute !== route.localRoute);
    if (!candidate) return { status: "not-applicable", message: "Mobile navigation exposes no different internal route.", summary: classified.summary };
    await page.locator("a[href]").nth(candidate.index).click({ timeout: 5_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    const destination = await waitForLocalRoute(page, candidate.localRoute);
    const pass = destination !== null && destination === candidate.localRoute;
    return {
      status: pass ? "pass" : FAIL,
      toggle: controls,
      destination,
      expected: candidate.localRoute,
      summary: classified.summary,
      message: pass ? "Mobile navigation reached its local destination." : "Mobile navigation did not reach its local destination.",
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function verifyOneRoute({ browser, manifest, route, out, cloneUrl, config, sourceOrigin, homeTitle, mode = "exact-reconstruction" }) {
  const referenceInspired = mode === "reference-inspired";
  const evidence = await readEvidence(out, route);
  const routeDir = join(out, "verification", "routes", routeSlug(route.canonicalUrl || route.sourceUrl || route.localRoute));
  await mkdir(routeDir, { recursive: true });
  const blockers = [];
  const reviews = [];
  const notes = [];
  if (!evidence) {
    blockers.push({ category: "evidence", message: "No captured route evidence; implementation cannot be verified." });
    return {
      route: route.localRoute,
      status: BLOCKED,
      implementationStatus: "unverified",
      direct: [],
      links: { status: BLOCKED },
      mobileNavigation: { status: BLOCKED },
      history: { status: BLOCKED },
      viewports: [],
      blockers,
      reviews,
      notes,
    };
  }
  if (evidence.captureStatus !== "captured") {
    blockers.push({ category: "capture", message: `Source capture status is ${evidence.captureStatus}.` });
  }
  const viewports = await directAndViewports({ browser, out, route, cloneUrl, evidence, config, homeTitle, routeDir });
  for (const viewport of viewports) {
    if (viewport.error) blockers.push({ category: "evidence", viewport: viewport.name, message: viewport.error });
    if (viewport.direct?.status === FAIL) blockers.push({ category: "deep-link", viewport: viewport.name, message: viewport.direct.error || `Direct load ended at ${viewport.direct.finalUrl}, expected ${route.localRoute}.` });
    if (viewport.visual?.status === FAIL) {
      if (referenceInspired) reviews.push({ category: "design-deviation", viewport: viewport.name, message: "Visual difference is treated as an intentional reference-inspired deviation, not an exact-clone defect." });
      else blockers.push({ category: "visual", viewport: viewport.name, message: viewport.visual.error || "Screenshot difference exceeds the fail threshold." });
    } else if (viewport.visual?.status === REVIEW) reviews.push({ category: referenceInspired ? "design-deviation" : "visual", viewport: viewport.name, message: "Screenshot difference requires review." });
    if (viewport.title?.status === FAIL) {
      if (referenceInspired) notes.push({ category: "content-deviation", viewport: viewport.name, message: viewport.title.message });
      else blockers.push({ category: "content", viewport: viewport.name, message: viewport.title.message });
    } else if (viewport.title?.status === REVIEW) {
      (referenceInspired ? notes : reviews).push({ category: referenceInspired ? "content-deviation" : "content", viewport: viewport.name, message: viewport.title.message });
    }
    if (viewport.heading?.status === FAIL) {
      if (referenceInspired) notes.push({ category: "content-deviation", viewport: viewport.name, message: viewport.heading.message });
      else blockers.push({ category: "content", viewport: viewport.name, message: viewport.heading.message });
    } else if (viewport.heading?.status === REVIEW) {
      (referenceInspired ? notes : reviews).push({ category: referenceInspired ? "content-deviation" : "content", viewport: viewport.name, message: viewport.heading.message });
    }
    if (viewport.fonts?.status === REVIEW || viewport.fonts?.status === FAIL) reviews.push({ category: referenceInspired ? "design-deviation" : "fonts", viewport: viewport.name, message: viewport.fonts.message });
    if (viewport.geometry?.status === FAIL) {
      if (referenceInspired) reviews.push({ category: "design-deviation", viewport: viewport.name, message: `Geometry has ${viewport.geometry.failed} intentional-layout candidate(s); review in reference-inspired mode.` });
      else blockers.push({ category: "geometry", viewport: viewport.name, message: `Geometry matching failed for ${viewport.geometry.failed} section(s).` });
    } else if (viewport.geometry?.status === REVIEW) reviews.push({ category: referenceInspired ? "design-deviation" : "geometry", viewport: viewport.name, message: `Geometry has ${viewport.geometry.review} review section(s).` });
  }

  const desktop = { width: 1440, height: 1000, ...(config.capture.viewports.desktop || {}) };
  const desktopPage = await openClone(browser, desktop, new URL(route.localRoute, cloneUrl).href, config.capture.timeoutMs);
  let links = { status: BLOCKED, summary: {}, links: [], notes: [] };
  let history = { status: BLOCKED, message: "History check did not complete." };
  try {
    links = await inspectLinks(desktopPage.page, { manifest, cloneUrl, sourceOrigin, route });
    if (links.status === "fail") blockers.push({ category: "links", message: `${links.summary.broken} broken internal link(s), ${links.summary.escaped} source-origin escape(s).` });
    notes.push(...(links.notes || []));
    history = await historyCheck({ browser, cloneUrl, route, config, manifest, sourceOrigin });
    if (history.status === FAIL) blockers.push({ category: "history", message: history.message });
    else if (history.status === "not-tested") reviews.push({ category: "history", message: history.message });
  } catch (error) {
    blockers.push({ category: "links", message: error.message.split("\n")[0] });
  } finally {
    await desktopPage.context.close().catch(() => {});
  }

  const mobile = await mobileCheck({ browser, cloneUrl, route, config, manifest, sourceOrigin });
  if (mobile.status === FAIL) blockers.push({ category: "mobile-navigation", message: mobile.message });
  else if (mobile.status === "not-applicable") notes.push({ category: "mobile-navigation", message: mobile.message });

  const status = blockers.length ? FAIL : reviews.length ? REVIEW : PASS;
  return {
    route: route.localRoute,
    status,
    implementationStatus: viewports.length && viewports.every((viewport) => viewport.direct?.status === "pass") ? "implemented" : "missing",
    sourceCaptureStatus: evidence.captureStatus,
    direct: viewports.map((viewport) => ({ name: viewport.name, ...viewport.direct })),
    visual: viewports.map((viewport) => ({ name: viewport.name, ...viewport.visual })),
    geometry: viewports.map((viewport) => ({ name: viewport.name, ...viewport.geometry })),
    fonts: viewports.map((viewport) => ({ name: viewport.name, ...viewport.fonts })),
    title: viewports.map((viewport) => ({ name: viewport.name, ...viewport.title })),
    heading: viewports.map((viewport) => ({ name: viewport.name, ...viewport.heading })),
    links: {
      status: links.status,
      summary: links.summary,
      broken: links.links.filter((link) => link.kind === "broken" || link.kind === "escaped").map((link) => ({ kind: link.kind, href: link.href || link.rawHref, localRoute: link.localRoute })),
      notes: links.notes,
    },
    mobileNavigation: mobile,
    history,
    viewports,
    evidenceFile: relative(out, sourceEvidencePath(out, route)),
    blockers,
    reviews,
    notes,
  };
}

function routeGateFor(routes) {
  if (!routes.length) return { status: FAIL, message: "No selected routes were verified." };
  if (routes.some((route) => route.status === FAIL || route.status === BLOCKED)) return { status: FAIL, message: "At least one selected route failed or is blocked." };
  if (routes.some((route) => route.status === REVIEW)) return { status: REVIEW, message: "At least one selected route requires review." };
  return { status: PASS, message: "Every selected route passed the implemented machine gates." };
}

function markdownReport(report) {
  const rows = report.routes.map((route) =>
    `| ${route.route} | ${route.status} | ${Array.isArray(route.direct) ? route.direct.map((entry) => entry.status).join("/") : route.direct?.status || "-"} | ${route.links?.status || "-"} | ${route.mobileNavigation?.status || "-"} | ${route.history?.status || "-"} | ${Array.isArray(route.visual) ? route.visual.map((entry) => entry.status).join("/") : "-"} | ${Array.isArray(route.geometry) ? route.geometry.map((entry) => entry.status).join("/") : "-"} |`,
  );
  return `# Site verification report

- Source: ${report.sourceUrl}
- Clone: ${report.cloneUrl}
- Generated: ${report.generatedAt}
- Route gate: **${report.routeGate}**
- Scenario gate: **${report.scenarioGate}**
- Overall status: **${report.overallStatus}**
- Route coverage: **${report.coverage.verified}/${report.coverage.selected} selected routes verified**

| Route | Status | Direct | Links | Mobile nav | History | Visual | Geometry |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n") || "| - | - | - | - | - | - | - | - |"}

## Route coverage

- Discovered: ${report.coverage.discovered}
- Selected: ${report.coverage.selected}
- Captured: ${report.coverage.captured}
- Implemented: ${report.coverage.implemented}
- Verified: ${report.coverage.verified}
- Review: ${report.coverage.review}
- Failed: ${report.coverage.failed}
- Blocked: ${report.coverage.blocked}
- Excluded: ${report.coverage.excluded}
- Unresolved: ${report.coverage.unresolved}

## Highest-impact issues

${report.routes.flatMap((route) => route.blockers.map((blocker) => `- ${route.route} [${blocker.category}]: ${blocker.message}`)).join("\n") || "None observed in the machine gates."}

## Known issues and unresolved routes

${report.manifestNotes.map((note) => `- ${note}`).join("\n") || "None recorded."}

## Verification boundaries

- Only selected, authorized routes are in the completeness denominator.
- Failed or excluded source routes remain explicit; they are not silently redirected to the homepage.
- Screenshot similarity is triage evidence, not proof of functional equivalence.
- Authored interaction scenarios are required before claiming interaction verification.
`;
}

export async function verifySite({
  manifest,
  out,
  cloneUrl,
  config,
  browser = null,
  only = [],
  scenarios = [],
  logger = { info() {}, warn() {} },
}) {
  const settings = config;
  const allSelected = (manifest.routes || [])
    .filter((route) => route.discoveryStatus === "discovered")
    .filter((route) => !only.length || only.includes(route.localRoute));
  if (only.length) {
    const known = new Set((manifest.routes || []).map((route) => route.localRoute));
    const missing = only.filter((route) => !known.has(route));
    if (missing.length) throw new Error(`Unknown route(s) for verification: ${missing.join(", ")}.`);
  }
  if (!allSelected.length) throw new Error("The manifest has no selected routes to verify.");
  const ownBrowser = !browser;
  const activeBrowser = browser || (await loadBrowser());
  const sourceOrigin = manifest.site?.origin || new URL(manifest.site?.sourceUrl || cloneUrl).origin;
  const homeTitle = (manifest.routes || []).find((route) => route.localRoute === "/")?.title || null;
  const routeResults = [];
  try {
    for (const route of allSelected) {
      logger.info?.(`verifying ${route.localRoute}`);
      const result = await verifyOneRoute({
        browser: activeBrowser,
        manifest,
        route,
        out,
        cloneUrl,
        config: settings,
        sourceOrigin,
        homeTitle,
        mode: manifest.mode || "exact-reconstruction",
      });
      routeResults.push(result);
      route.verificationStatus = result.status;
      route.verificationCheckedAt = new Date().toISOString();
      route.implementationStatus = result.implementationStatus;
      route.verificationEvidence = {
        status: result.status,
        evidenceFile: result.evidenceFile,
        direct: result.direct,
        links: result.links,
        mobileNavigation: result.mobileNavigation,
        history: result.history,
        blockers: result.blockers,
        reviews: result.reviews,
        notes: result.notes,
      };
    }

    let scenarioGate = "not-run";
    const scenarioComparisons = [];
    if (scenarios.length) {
      logger.info?.(`running ${scenarios.length} interaction scenario(s)`);
      const sourceEvidence = await runScenarioSuite({ browser: activeBrowser, scenarios, baseUrl: manifest.site.sourceUrl, out, role: "source", logger });
      const cloneEvidence = await runScenarioSuite({ browser: activeBrowser, scenarios, baseUrl: cloneUrl, out, role: "clone", logger });
      const scenarioDir = join(out, "verification", "scenarios");
      await mkdir(scenarioDir, { recursive: true });
      for (const scenario of scenarios) {
        const source = sourceEvidence.find((entry) => entry.scenario?.id === scenario.id);
        const clone = cloneEvidence.find((entry) => entry.scenario?.id === scenario.id);
        const comparison = await compareScenarioEvidence({
          source,
          clone,
          sourceDir: out,
          cloneDir: out,
          outDir: scenarioDir,
          thresholds: settings.verification.thresholds,
        });
        scenarioComparisons.push(comparison);
        await writeJson(join(scenarioDir, `${scenario.id}.json`), comparison);
        await writeFile(join(scenarioDir, `${scenario.id}.md`), scenarioReportMarkdown(comparison));
      }
      scenarioGate = scenarioComparisons.some((comparison) => comparison.status === "fail")
        ? FAIL
        : scenarioComparisons.some((comparison) => comparison.status !== "verified")
          ? REVIEW
          : PASS;
    }

    const routeGate = routeGateFor(routeResults);
    const overallStatus = routeGate.status === FAIL || scenarioGate === FAIL
      ? FAIL
      : routeGate.status === REVIEW || scenarioGate === REVIEW || scenarioGate === "not-run"
        ? REVIEW
        : PASS;
    const coverage = {
      discovered: (manifest.routes || []).length,
      selected: allSelected.length,
      captured: allSelected.filter((route) => route.captureStatus === "captured").length,
      implemented: routeResults.filter((route) => route.implementationStatus === "implemented").length,
      verified: routeResults.filter((route) => route.status === PASS).length,
      review: routeResults.filter((route) => route.status === REVIEW).length,
      failed: routeResults.filter((route) => route.status === FAIL).length,
      blocked: routeResults.filter((route) => route.status === BLOCKED).length,
      excluded: (manifest.excluded || []).length,
      unresolved: (manifest.unresolved || []).length,
    };
    const manifestNotes = [
      ...(manifest.excluded || []).map((entry) => `Excluded ${entry.localRoute}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`),
      ...(manifest.unresolved || []).map((entry) => `Unresolved ${entry.localRoute || entry.url}: ${entry.reason}`),
      ...(manifest.routes || []).filter((route) => route.discoveryStatus === "failed").map((route) => `Source route failed: ${route.localRoute} (HTTP ${route.httpStatus ?? "unknown"}).`),
    ];
    const report = {
      version: 1,
      kind: "rml-site-verification",
      sourceUrl: manifest.site?.sourceUrl,
      cloneUrl,
      mode: manifest.mode || "exact-reconstruction",
      generatedAt: new Date().toISOString(),
      routeGate: routeGate.status,
      routeGateMessage: routeGate.message,
      scenarioGate,
      overallStatus,
      verified: overallStatus === PASS && coverage.selected > 0 && coverage.verified === coverage.selected,
      coverage,
      routes: routeResults,
      scenarios: scenarioComparisons,
      manualGates: [
        "fresh independent visual review",
        "content and rights review",
        "authored interaction scenarios for all critical flows",
        "post-correction regression rerun",
      ],
      manifestNotes,
      thresholds: settings.verification.thresholds,
    };
    manifest.summary = {
      ...manifest.summary,
      selected: coverage.selected,
      captured: coverage.captured,
      implemented: coverage.implemented,
      verified: coverage.verified,
      verificationReview: coverage.review,
      verificationFailed: coverage.failed,
      verificationBlocked: coverage.blocked,
      verificationComplete: coverage.verified === coverage.selected && coverage.selected > 0,
    };
    await writeJson(join(out, "evidence", "routes.json"), manifest);
    await writeJson(join(out, "verification", "site-report.json"), report);
    await writeFile(join(out, "verification", "site-report.md"), markdownReport(report));
    logger.info?.(`verification complete: ${coverage.verified}/${coverage.selected} selected routes verified, gate ${routeGate.status}`);
    return { manifest, report };
  } finally {
    if (ownBrowser) await activeBrowser.close().catch(() => {});
  }
}
