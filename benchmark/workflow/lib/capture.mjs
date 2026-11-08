import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stablePage, stabilize, writeJson, loadBrowser } from "./core.mjs";
import { routeSlug } from "./url.mjs";

const STYLE_PROPERTIES = [
  "display", "position", "top", "right", "bottom", "left", "width", "height", "minWidth", "maxWidth",
  "minHeight", "maxHeight", "margin", "padding", "gap", "rowGap", "columnGap", "gridTemplateColumns",
  "gridTemplateRows", "flexDirection", "justifyContent", "alignItems", "fontFamily", "fontSize",
  "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform", "color",
  "opacity", "background", "backgroundColor", "backgroundImage", "backgroundPosition", "backgroundSize",
  "border", "borderRadius", "boxShadow", "filter", "backdropFilter", "transform", "transformOrigin",
  "overflow", "objectFit", "objectPosition", "zIndex", "transition", "animation",
];

const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role="button"],[role="tab"],summary';

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

/** Runs inside the page. Returns only rendering facts, never script sources or secrets. */
export function observePage() {
  const styleOf = (element, pseudo = null) => {
    const computed = getComputedStyle(element, pseudo);
    return Object.fromEntries(
      [
        "display", "position", "top", "right", "bottom", "left", "width", "height", "minWidth", "maxWidth",
        "minHeight", "maxHeight", "margin", "padding", "gap", "rowGap", "columnGap", "gridTemplateColumns",
        "gridTemplateRows", "flexDirection", "justifyContent", "alignItems", "fontFamily", "fontSize",
        "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform", "color",
        "opacity", "background", "backgroundColor", "backgroundImage", "backgroundPosition", "backgroundSize",
        "border", "borderRadius", "boxShadow", "filter", "backdropFilter", "transform", "transformOrigin",
        "overflow", "objectFit", "objectPosition", "zIndex", "transition", "animation",
      ].map((property) => [property, computed[property]]),
    );
  };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const describe = (element, index) => {
    const rect = element.getBoundingClientRect();
    const heading = element.querySelector("h1,h2,h3,h4");
    return {
      index,
      selector: element.id
        ? `#${CSS.escape(element.id)}`
        : `${element.tagName.toLowerCase()}${element.classList.length ? `.${[...element.classList].slice(0, 3).map(CSS.escape).join(".")}` : ""}`,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      classes: [...element.classList].slice(0, 12),
      text: clean(element.innerText || element.textContent).slice(0, 220),
      heading: clean(heading?.textContent).slice(0, 160) || null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      style: styleOf(element),
      before: styleOf(element, "::before"),
      after: styleOf(element, "::after"),
    };
  };
  const roots = [...document.querySelectorAll("body > header, main > *, body > footer")].filter((element) => element.getBoundingClientRect().height > 4);
  const sections = roots.length
    ? roots
    : [...document.querySelectorAll("main, [role=main], section")].filter((element) => element.getBoundingClientRect().height > 4);
  const interactive = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="tab"],summary')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height;
    })
    .slice(0, 150);
  const media = [...document.querySelectorAll("img,source,video,svg,link[rel*=icon]")]
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      src: element.currentSrc || element.src || element.href || element.getAttribute("src") || null,
      alt: element.alt || null,
      width: element.naturalWidth || element.width?.baseVal?.value || element.width || null,
      height: element.naturalHeight || element.height?.baseVal?.value || element.height || null,
    }))
    .filter((entry) => entry.src);
  const variables = {};
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) {
        if (rule.selectorText === ":root") {
          for (const name of rule.style) if (name.startsWith("--")) variables[name] = rule.style.getPropertyValue(name).trim();
        }
      }
    } catch {
      // Cross-origin stylesheets are not readable; record only local declarations.
    }
  }
  const sticky = [...document.querySelectorAll("*")]
    .filter((element) => {
      const position = getComputedStyle(element).position;
      return position === "fixed" || position === "sticky";
    })
    .slice(0, 40)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      selector: element.id ? `#${CSS.escape(element.id)}` : element.className ? `.${String(element.className).split(/\s+/).slice(0, 2).map(CSS.escape).join(".")}` : element.tagName.toLowerCase(),
      position: getComputedStyle(element).position,
    }));
  const animated = [...document.querySelectorAll("*")]
    .filter((element) => {
      const computed = getComputedStyle(element);
      return (computed.transition && computed.transition !== "all 0s ease 0s") || (computed.animationName && computed.animationName !== "none");
    })
    .slice(0, 40)
    .map((element) => {
      const computed = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), transition: computed.transition, animation: computed.animation, name: computed.animationName };
    });
  const accessibleInteractive = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], summary')]
    .map((element) => clean(element.getAttribute("aria-label") || element.innerText || element.getAttribute("title") || element.getAttribute("value") || ""))
    .filter(Boolean);
  return {
    title: clean(document.title),
    route: `${location.pathname}${location.search}`,
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    lang: document.documentElement.lang || null,
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      background: getComputedStyle(document.body).background,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    },
    fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status, weight: font.weight, style: font.style })),
    cssVariables: variables,
    sections: sections.map(describe),
    interactive: interactive.map(describe),
    media,
    headings: [...document.querySelectorAll("h1,h2,h3")].map((element) => clean(element.textContent)).filter(Boolean),
    sticky,
    animated,
    accessibility: {
      landmarks: [...document.querySelectorAll('header, footer, main, nav, aside, [role="banner"], [role="main"], [role="contentinfo"], [role="navigation"], [role="complementary"]')]
        .map((element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: element.getAttribute("aria-label") }))
        .slice(0, 40),
      headingLevels: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((element) => Number(element.tagName[1])).slice(0, 100),
      interactiveNames: accessibleInteractive.slice(0, 100),
      formCount: document.querySelectorAll("form").length,
    },
  };
}

/** Bounded viewport probing with structural transitions and CSS media evidence. */
export async function probeBreakpoints(page, { candidates = [], timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now();
  const original = page.viewportSize();
  if (!original) return { candidates, cssMediaBreakpoints: [], method: "structural-signature+css-media", measurements: [], transitions: [], restored: true, complete: false, notes: ["no viewport"] };
  const measurements = new Map();
  const warnings = [];
  let cssMediaBreakpoints = [];
  try {
    cssMediaBreakpoints = await page.evaluate(() => {
      const widths = new Set();
      const visit = (rule) => {
        try {
          if (rule.media?.mediaText) {
            for (const match of rule.media.mediaText.matchAll(/(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
              widths.add(Math.round(Number(match[1])));
            }
          }
          if (rule.cssRules) for (const child of rule.cssRules) visit(child);
        } catch {
          // Cross-origin or opaque rules cannot be inspected.
        }
      };
      for (const sheet of [...document.styleSheets]) {
        try {
          for (const rule of sheet.cssRules) visit(rule);
        } catch {
          // Ignore stylesheets the browser refuses to expose.
        }
      }
      return [...widths].filter((width) => width >= 240 && width <= 3840).sort((left, right) => left - right);
    });
  } catch {
    warnings.push("unable to inspect CSS media query breakpoints");
  }
  const measure = async (width) => {
    if (measurements.has(width)) return measurements.get(width);
    if (Date.now() - startedAt > timeoutMs) {
      warnings.push(`breakpoint probing exceeded ${timeoutMs}ms at ${width}px`);
      return null;
    }
    try {
      await page.setViewportSize({ width, height: original.height });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const signature = await page.evaluate(() => {
        // Ignore fluid pixel dimensions; they vary at every width and produce
        // false breakpoints. Normalized structural properties reveal actual
        // layout transitions, while CSS media rules provide exact boundaries.
        const normalize = (value) => String(value || "").replace(/-?\d+(?:\.\d+)?px/g, "N").replace(/\s+/g, " ");
        const describe = (element) => {
          const computed = getComputedStyle(element);
          return [
            element.tagName.toLowerCase(),
            computed.display,
            computed.position,
            computed.flexDirection,
            normalize(computed.gridTemplateColumns),
            computed.visibility,
            computed.overflowX,
          ].join(":");
        };
        const elements = [...document.querySelectorAll("body > header, main > *, body > footer")]
          .filter((element) => element.getBoundingClientRect().height > 4)
          .slice(0, 40);
        const controls = [...document.querySelectorAll('header nav, header [role="navigation"], header button[aria-controls]')].slice(0, 8);
        return [...elements, ...controls].map(describe).join("|");
      });
      const entry = { width, signature: sha(signature), signatureLength: signature.length };
      measurements.set(width, entry);
      return entry;
    } catch (error) {
      warnings.push(`unable to measure ${width}px: ${error.message.split("\n")[0]}`);
      return null;
    }
  };

  const widths = [...new Set(candidates.filter((width) => Number.isInteger(width) && width >= 240).sort((left, right) => left - right))];
  for (const width of widths) await measure(width);

  const transitions = [];
  for (let index = 1; index < widths.length; index += 1) {
    const low = widths[index - 1];
    const high = widths[index];
    const lowEntry = measurements.get(low);
    const highEntry = measurements.get(high);
    if (!lowEntry || !highEntry || lowEntry.signature === highEntry.signature) continue;
    let lowProbe = low;
    let highProbe = high;
    for (let step = 0; step < 8 && highProbe - lowProbe > 1; step += 1) {
      const middle = Math.floor((lowProbe + highProbe) / 2);
      const middleEntry = await measure(middle);
      if (!middleEntry) break;
      if (middleEntry.signature === measurements.get(lowProbe)?.signature) lowProbe = middle;
      else highProbe = middle;
    }
    transitions.push({
      between: [low, high],
      breakpoint: highProbe,
      tested: [Math.max(240, highProbe - 1), highProbe],
      signatureAbove: measurements.get(lowProbe)?.signature,
      signatureBelow: measurements.get(highProbe)?.signature,
    });
  }

  try {
    await page.setViewportSize(original);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  } catch {
    warnings.push("unable to restore viewport after probing");
  }

  return {
    original,
    candidates: widths,
    cssMediaBreakpoints,
    method: "structural-signature+css-media",
    measurements: [...measurements.values()].sort((left, right) => left.width - right.width),
    transitions,
    restored: page.viewportSize()?.width === original.width,
    warnings,
    complete: warnings.length === 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Force focus/hover/active with CDP instead of physically pressing source
 * controls. No click, navigation, download, or form submission occurs.
 */
export async function captureInteractionStates(page, { maxStates = 80, screenshotsDir = null, maxScreenshots = 12 } = {}) {
  const handles = await page.$$(INTERACTIVE_SELECTOR);
  const properties = ["color", "background", "backgroundImage", "border", "borderRadius", "boxShadow", "opacity", "transform", "transition", "outline", "filter", "cursor"];
  const session = await page.context().newCDPSession(page);
  const results = [];
  let screenshots = 0;
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1 });
    for (let index = 0; index < handles.length && results.length < maxStates; index += 1) {
      const handle = handles[index];
      let info;
      try {
        info = await handle.evaluate((element, id) => {
          const rect = element.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
          if (visible) element.setAttribute("data-pp-state-id", String(id));
          return {
            tag: element.tagName.toLowerCase(),
            text: String(element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 120),
            visible,
          };
        }, index);
      } catch {
        continue;
      }
      if (!info.visible) continue;
      let nodeId = 0;
      try {
        const response = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-pp-state-id="${index}"]` });
        nodeId = response.nodeId;
      } catch {
        nodeId = 0;
      }
      if (!nodeId) {
        await handle.evaluate((element) => element.removeAttribute("data-pp-state-id")).catch(() => {});
        continue;
      }
      const read = () => handle.evaluate((element, names) => {
        const computed = getComputedStyle(element);
        return Object.fromEntries(names.map((name) => [name, computed[name]]));
      }, properties);
      try {
        const base = await read();
        const states = {};
        for (const state of ["focus", "hover", "active"]) {
          await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
          states[state] = await read();
          await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        }
        const changed = Object.fromEntries(
          ["focus", "hover", "active"].map((state) => [state, Object.keys(base).some((name) => base[name] !== states[state]?.[name])]),
        );
        if (screenshotsDir && screenshots < maxScreenshots && Object.values(changed).some(Boolean)) {
          await mkdir(screenshotsDir, { recursive: true });
          for (const state of ["focus", "hover", "active"]) {
            if (!changed[state] || screenshots >= maxScreenshots) continue;
            await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] });
            try {
              await handle.screenshot({ path: join(screenshotsDir, `${index}-${state}.png`), animations: "disabled" });
              screenshots += 1;
            } catch {
              // Element screenshots can fail for clipped or offscreen controls.
            }
            await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
          }
        }
        results.push({ index, tag: info.tag, text: info.text, base, focus: states.focus, hover: states.hover, active: states.active, changed, method: "cdp-forced-pseudo-state" });
      } catch (error) {
        results.push({ index, tag: info.tag, text: info.text, unsupported: true, error: error.message.split("\n")[0] });
      } finally {
        await handle.evaluate((element) => element.removeAttribute("data-pp-state-id")).catch(() => {});
      }
    }
  } finally {
    await session.detach().catch(() => {});
  }
  return results;
}

function assetKind(contentType) {
  if (/font/i.test(contentType)) return "font";
  if (/image\/svg/i.test(contentType)) return "svg";
  if (/image/i.test(contentType)) return "image";
  if (/css/i.test(contentType)) return "css";
  if (/video/i.test(contentType)) return "video";
  return null;
}

/**
 * Capture one route at every configured viewport. Each artifact records its own
 * provenance and unresolved conditions; partial captures are never marked done.
 */
export async function captureRoute({ browser, route, out, config, viewportNames = null, persistRoute = null }) {
  const settings = config.capture;
  const slug = routeSlug(route.canonicalUrl || route.sourceUrl);
  const sourceDir = join(out, "source", slug);
  const evidenceDir = join(out, "evidence", "routes");
  const evidenceFile = join(evidenceDir, `${slug}.json`);
  await mkdir(join(sourceDir, "screenshots"), { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  const viewports = [];
  const warnings = [];
  const failures = [];
  const evidenceBoundaries = [];
  const assets = new Map();
  let interactionStates = [];
  let breakpoints = null;
  let renderedHtml = null;
  let browserVersion = null;

  for (const [name, viewport] of Object.entries(settings.viewports)) {
    if (viewportNames && !viewportNames.includes(name)) continue;
    const startedAt = Date.now();
    const { context, page } = await stablePage(browser, viewport);
    try {
      page.on("response", (response) => {
        const contentType = response.headers()["content-type"] || "";
        const kind = assetKind(contentType);
        if (!kind) return;
        assets.set(response.url(), { url: response.url(), status: response.status(), contentType, kind });
      });
      let mainResponse = null;
      page.on("response", (response) => {
        if (!mainResponse && response.request().isNavigationRequest() && response.frame() === page.mainFrame()) mainResponse = response;
      });
      page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
      const stabilization = await stabilize(page, route.canonicalUrl || route.sourceUrl, {
        timeoutMs: settings.timeoutMs,
        scroll: settings.scrollForLazy,
      });
      const status = mainResponse?.status() ?? (stabilization.navigationError ? null : 200);
      const finalUrl = page.url();
      if (stabilization.navigationError) warnings.push(`${name}: ${stabilization.navigationError}`);
      if (stabilization.timedOut.length) warnings.push(`${name}: bounded wait timed out (${stabilization.timedOut.join(", ")})`);
      if (stabilization.pendingImages > 0) {
        const examples = (stabilization.pendingImageUrls || []).slice(0, 3).join(", ");
        warnings.push(`${name}: ${stabilization.pendingImages} image(s) still pending at capture${examples ? ` (${examples})` : ""}`);
      }
      if (stabilization.pendingImages !== 0) {
        evidenceBoundaries.push({ viewport: name, category: "images", count: stabilization.pendingImages, urls: stabilization.pendingImageUrls || [] });
      }
      if (stabilization.brokenImageUrls?.length) {
        warnings.push(`${name}: ${stabilization.brokenImageUrls.length} source image(s) have zero intrinsic size`);
      }
      if (status && status >= 400) failures.push({ viewport: name, stage: "navigation", status });

      const viewportScreenshot = join(sourceDir, "screenshots", `${name}-viewport.png`);
      const fullScreenshot = join(sourceDir, "screenshots", `${name}.png`);
      await page.screenshot({ path: viewportScreenshot, fullPage: false, animations: "disabled" });
      await page.screenshot({ path: fullScreenshot, fullPage: true, animations: "disabled" });

      const observation = await page.evaluate(observePage);
      observation.viewport = { name, ...viewport };
      observation.provenance = {
        method: "playwright-rendered",
        capturedAt: new Date().toISOString(),
        sourceStatus: status,
        finalUrl,
        selectors: "rendered DOM",
      };
      observation.sections = observation.sections.map((section) => ({
        ...section,
        fingerprint: sha([section.tag, section.selector, section.heading, section.text].join("|")),
      }));
      const observationFile = join(sourceDir, `observation-${name}.json`);
      await writeJson(observationFile, observation);
      browserVersion ||= browser.version();

      if (name === "desktop") {
        renderedHtml = join(sourceDir, "rendered.html");
        await writeFile(renderedHtml, await page.content());
        if (settings.breakpoints?.enabled) {
          breakpoints = await probeBreakpoints(page, {
            candidates: settings.breakpoints.candidates,
            timeoutMs: settings.breakpoints.timeoutMs ?? 60_000,
          });
          if (breakpoints.warnings.length) warnings.push(...breakpoints.warnings.map((warning) => `breakpoints: ${warning}`));
          if (breakpoints.complete === false) {
            evidenceBoundaries.push({ viewport: name, category: "breakpoints", warnings: breakpoints.warnings });
          }
        }
        if (settings.interactionStates === "pseudo") {
          try {
            interactionStates = await captureInteractionStates(page, {
              maxStates: settings.maxStates,
              screenshotsDir: join(sourceDir, "states"),
              maxScreenshots: 12,
            });
            const unsupported = interactionStates.filter((state) => state.unsupported).length;
            if (unsupported) warnings.push(`${unsupported} interaction state(s) could not be forced with CDP`);
          } catch (error) {
            warnings.push(`interaction state capture failed: ${error.message.split("\n")[0]}`);
          }
        }
      }

      viewports.push({
        name,
        width: viewport.width,
        height: viewport.height,
        status,
        finalUrl,
        screenshot: relative(out, fullScreenshot),
        viewportScreenshot: relative(out, viewportScreenshot),
        observation: relative(out, observationFile),
        stabilization,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      failures.push({ viewport: name, stage: "capture", error: error.message.split("\n")[0] });
      warnings.push(`${name}: ${error.message.split("\n")[0]}`);
    } finally {
      await context.close().catch(() => {});
    }
  }

  const captureStatus = viewports.length === 0
    ? "failed"
    : failures.length || evidenceBoundaries.length ? "partial" : "captured";
  const evidence = {
    version: 3,
    kind: "rml-route-evidence",
    route: {
      sourceUrl: route.sourceUrl,
      canonicalUrl: route.canonicalUrl,
      localRoute: route.localRoute,
      title: route.title,
      routeType: route.routeType,
      contentFingerprint: route.contentFingerprint,
    },
    capturedAt: new Date().toISOString(),
    browserVersion,
    captureStatus,
    viewports,
    breakpoints,
    interactionStates,
    assets: [...assets.values()].sort((left, right) => left.url.localeCompare(right.url)),
    sourceHtml: renderedHtml ? relative(out, renderedHtml) : null,
    warnings,
    failures,
    evidenceBoundaries,
    provenance: {
      method: "playwright-rendered facts; no copied scripts, credentials, cookies, headers, or response bodies",
      capturedFrom: route.canonicalUrl || route.sourceUrl,
      viewportsRequested: viewportNames || Object.keys(settings.viewports),
      interactionMethod: settings.interactionStates,
    },
  };
  await writeJson(evidenceFile, evidence);

  const update = {
    captureStatus,
    capturedAt: evidence.capturedAt,
    capturedFingerprint: route.contentFingerprint || null,
    evidenceDir: relative(out, sourceDir),
    evidenceFile: relative(out, evidenceFile),
    captureWarnings: warnings,
    breakpointsObserved: breakpoints?.transitions?.map((transition) => transition.breakpoint) || [],
    interactiveStateCount: interactionStates.length,
  };
  if (persistRoute) await persistRoute(update);
  return { evidence, evidenceFile, sourceDir, status: captureStatus, warnings, failures };
}

function renderCaptureReport(manifest, results) {
  const rows = results.map((result) =>
    `| ${result.localRoute} | ${result.status} | ${result.viewports ?? "-"} | ${result.warnings?.length ?? 0} |`,
  );
  return `# Capture report

- Source: ${manifest.site?.sourceUrl}
- Routes selected: **${results.length}**
- Captured: **${results.filter((result) => result.status === "captured").length}**
- Partial: **${results.filter((result) => result.status === "partial").length}**
- Failed: **${results.filter((result) => result.status === "failed").length}**
- Skipped (already captured): **${results.filter((result) => result.status === "skipped").length}**

| Route | Capture | Viewports | Warnings |
| --- | --- | ---: | ---: |
${rows.join("\n") || "| - | - | - | - |"}

Warnings are evidence, not passes. Review \`evidence/routes/<route>.json\` for stabilization timeouts, missing images, and unsupported pseudo-states.
`;
}

/** Capture all selected routes in a stable order, resuming already captured ones. */
export async function captureSite({ manifest, out, config, browser = null, only = [], force = false, logger = { info() {}, warn() {} } }) {
  const settings = config.capture;
  const selected = (manifest.routes || [])
    .filter((route) => route.discoveryStatus === "discovered")
    .filter((route) => !only.length || only.includes(route.localRoute))
    .sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0) || (left.localRoute === "/" ? -1 : right.localRoute === "/" ? 1 : left.localRoute.localeCompare(right.localRoute)))
    .slice(0, settings.maxRoutes);

  if (only.length) {
    const known = new Set((manifest.routes || []).map((route) => route.localRoute));
    const missing = only.filter((route) => !known.has(route));
    if (missing.length) throw new Error(`Unknown route(s) for capture: ${missing.join(", ")}. Run discover-site first.`);
  }

  const ownBrowser = !browser;
  const activeBrowser = browser || (await loadBrowser());
  const results = [];
  const evidencePath = join(out, "evidence", "routes.json");
  const persist = async () => {
    await writeJson(evidencePath, manifest);
  };
  try {
    for (const route of selected) {
      if (!force && route.captureStatus === "captured" && route.capturedFingerprint && route.capturedFingerprint === route.contentFingerprint) {
        results.push({ localRoute: route.localRoute, status: "skipped", viewports: route.viewports?.length ?? null, warnings: [] });
        logger.info(`skipped already captured ${route.localRoute}`);
        continue;
      }
      logger.info(`capturing ${route.localRoute}`);
      const result = await captureRoute({
        browser: activeBrowser,
        route,
        out,
        config,
        persistRoute: async (update) => {
          Object.assign(route, update);
          await persist();
        },
      });
      route.viewports = result.evidence.viewports.map((viewport) => viewport.name);
      results.push({
        localRoute: route.localRoute,
        status: result.status,
        viewports: result.evidence.viewports.length,
        warnings: result.warnings,
        evidenceFile: relative(out, result.evidenceFile),
      });
      await persist();
    }
  } finally {
    if (ownBrowser) await activeBrowser.close().catch(() => {});
  }

  manifest.summary = {
    ...manifest.summary,
    captured: (manifest.routes || []).filter((route) => route.captureStatus === "captured").length,
    partial: (manifest.routes || []).filter((route) => route.captureStatus === "partial").length,
    captureFailed: (manifest.routes || []).filter((route) => route.captureStatus === "failed").length,
  };
  await persist();
  await writeFile(join(out, "evidence", "capture-report.md"), renderCaptureReport(manifest, results));
  logger.info(`capture complete: ${results.filter((result) => result.status === "captured").length} captured, ${results.filter((result) => result.status === "skipped").length} skipped`);
  return { manifest, results };
}
