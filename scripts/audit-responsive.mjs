#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { absolute, loadBrowser, parseArgs, stablePage, stabilize } from "../lib/core.mjs";
import { compareScreenshots } from "../lib/diff.mjs";

const args = parseArgs(process.argv.slice(2));
const sourceDir = absolute(args.source || "capture");
const cloneUrl = String(args["clone-url"] || "http://127.0.0.1:4310/");
const out = absolute(args.out || ".audit/responsive");
const primaryWidths = [640, 1024, 1180];
const boundaryWidths = [375, 390, 500, 768, 900, 1100, 1440, 1920];
const requestedWidths = args.widths ? String(args.widths).split(",").map(Number).filter(Number.isFinite) : null;
const allWidths = [...new Set(requestedWidths || [...primaryWidths, ...boundaryWidths])].sort((left, right) => left - right);
const height = 1000;
const manifest = JSON.parse(await readFile(join(sourceDir, "evidence", "routes.json"), "utf8"));
const routes = manifest.routes.filter((route) => route.captureStatus === "captured");
if (!routes.length) throw new Error(`No captured routes found in ${sourceDir}.`);

const sourceOrigin = manifest.site?.origin || "https://revenuemedialab.com";
const allowedScrollerClasses = ["case-table", "marquee", "no-scrollbar"];
const slugFor = (route) => (route === "/" ? "home" : route.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9._-]+/gi, "-"));

const measure = () => {
  const overflow = [...document.querySelectorAll("body *")]
    .filter((element) => {
      const style = getComputedStyle(element);
      return ["auto", "scroll"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 4;
    })
    .slice(0, 30)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === "string" ? element.className : "",
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  const menu = document.querySelector('button[aria-controls="mobile-nav"]');
  return {
    title: document.title,
    heading: document.querySelector("h1")?.textContent?.trim() || "",
    innerWidth: window.innerWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    imageCount: document.images.length,
    brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.currentSrc || image.src),
    pendingImages: [...document.images].filter((image) => !image.complete).length,
    mobileMenuVisible: Boolean(menu && menu.getClientRects().length),
    scrollers: overflow,
  };
};

async function capture(page, url, screenshotPath) {
  const stabilization = await stabilize(page, url, { timeoutMs: 60_000, scroll: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const metrics = await page.evaluate(measure);
  let screenshot = null;
  if (screenshotPath) {
    await mkdir(dirname(screenshotPath), { recursive: true });
    screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
  }
  return { stabilization, metrics, screenshot };
}

function visualStatus(comparison) {
  if (comparison.dimensionMismatch || comparison.changeRatio > 0.02) return "failed";
  if (comparison.changeRatio > 0.005) return "review";
  return "pass";
}

function runStatus({ visual, checks }) {
  if (!checks.heightWithinTolerance || checks.cloneHorizontalOverflow > 1 || checks.cloneBrokenImages > 0 || checks.mobileMenuMissing) return "failed";
  if (visual?.status === "failed") return "failed";
  if (visual?.status === "review" || checks.scrollerCountDelta !== 0) return "review";
  return "pass";
}

const browser = await loadBrowser();
const results = [];
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

try {
  for (const width of allWidths) {
    process.stderr.write(`[audit] ${width}px\n`);
    const sourceContext = await stablePage(browser, { width, height });
    const cloneContext = await stablePage(browser, { width, height });
    try {
      const workers = Math.min(3, routes.length);
      const sourcePages = await Promise.all(Array.from({ length: workers }, () => sourceContext.context.newPage()));
      const clonePages = await Promise.all(Array.from({ length: workers }, () => cloneContext.context.newPage()));
      const widthResults = new Array(routes.length);
      await Promise.all(sourcePages.map(async (sourcePage, workerIndex) => {
        const clonePage = clonePages[workerIndex];
        for (let index = workerIndex; index < routes.length; index += workers) {
          const route = routes[index];
          const slug = slugFor(route.localRoute);
          const sourceUrl = new URL(route.sourceUrl || route.localRoute, sourceOrigin).href;
          const cloneTarget = new URL(route.localRoute, cloneUrl).href;
          const primary = primaryWidths.includes(width);
          const sourceShotPath = primary ? join(out, "source", slug, `${width}.png`) : null;
          const cloneShotPath = primary ? join(out, "clone", slug, `${width}.png`) : null;
          const source = await capture(sourcePage, sourceUrl, sourceShotPath);
          const clone = await capture(clonePage, cloneTarget, cloneShotPath);

          let visual = null;
          if (primary) {
            try {
              const comparison = await compareScreenshots(source.screenshot, clone.screenshot, { threshold: 0.1 });
              const { diffPng, ...rest } = comparison;
              visual = { ...rest, status: visualStatus(comparison) };
              if (comparison.changedPixels) {
                const diffPath = join(out, "diffs", slug, `${width}.png`);
                await mkdir(dirname(diffPath), { recursive: true });
                await writeFile(diffPath, diffPng);
              }
            } catch (error) {
              visual = { status: "failed", error: error.code || error.message.split("\n")[0] };
            }
          }

          const sourceScrollers = source.metrics.scrollers.filter((scroller) => allowedScrollerClasses.some((name) => scroller.className.split(/\s+/).includes(name))).length;
          const cloneScrollers = clone.metrics.scrollers.filter((scroller) => allowedScrollerClasses.some((name) => scroller.className.split(/\s+/).includes(name))).length;
          const unintendedScrollers = clone.metrics.scrollers.filter((scroller) => !allowedScrollerClasses.some((name) => scroller.className.split(/\s+/).includes(name)));
          const checks = {
            heightDelta: Math.abs(source.metrics.documentHeight - clone.metrics.documentHeight),
            heightWithinTolerance: Math.abs(source.metrics.documentHeight - clone.metrics.documentHeight) <= 2,
            cloneHorizontalOverflow: Math.max(0, clone.metrics.documentWidth - clone.metrics.innerWidth),
            cloneBrokenImages: clone.metrics.brokenImages.length,
            clonePendingImages: clone.metrics.pendingImages,
            sourceBrokenImages: source.metrics.brokenImages.length,
            mobileMenuMissing: width < 1024 && source.metrics.mobileMenuVisible && !clone.metrics.mobileMenuVisible,
            scrollerCountDelta: sourceScrollers - cloneScrollers,
            unintendedScrollers,
          };
          const status = runStatus({ visual, checks });
          const entry = {
            route: route.localRoute,
            width,
            primary,
            status,
            visual,
            checks,
            source: { ...source.metrics, stabilization: source.stabilization },
            clone: { ...clone.metrics, stabilization: clone.stabilization },
            screenshots: primary ? { source: sourceShotPath.replace(`${out}/`, ""), clone: cloneShotPath.replace(`${out}/`, "") } : null,
          };
          widthResults[index] = entry;
          if (status !== "pass") {
            process.stderr.write(
              `[audit] ${status} ${route.localRoute} @ ${width}: visual=${visual?.status || "n/a"} ratio=${visual?.changeRatio?.toFixed(5) ?? "-"} height=${checks.heightDelta} overflow=${checks.cloneHorizontalOverflow} broken=${checks.cloneBrokenImages} scrollers=${checks.scrollerCountDelta}\n`,
            );
          }
        }
      }));
      results.push(...widthResults.filter(Boolean));
      await writeFile(join(out, "partial.json"), JSON.stringify({ completedWidths: results.map((result) => result.width).filter((value, index, all) => all.indexOf(value) === index), results }, null, 2));
    } finally {
      await sourceContext.context.close().catch(() => {});
      await cloneContext.context.close().catch(() => {});
    }
  }
} finally {
  await browser.close().catch(() => {});
}

const counts = results.reduce((summary, result) => {
  summary[result.status] = (summary[result.status] || 0) + 1;
  return summary;
}, {});
const failed = results.filter((result) => result.status === "failed");
const review = results.filter((result) => result.status === "review");
const report = {
  kind: "reconstruction-responsive-audit",
  source: sourceOrigin,
  clone: cloneUrl,
  generatedAt: new Date().toISOString(),
  primaryWidths,
  boundaryWidths,
  routes: routes.map((route) => route.localRoute),
  summary: {
    checks: results.length,
    ...counts,
    failedRoutes: [...new Set(failed.map((result) => result.route))],
    reviewRoutes: [...new Set(review.map((result) => result.route))],
    primaryVisuals: results.filter((result) => result.primary).length,
  },
  results,
};
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
await writeFile(
  join(out, "report.md"),
  `# Reconstruction responsive audit

- Source: ${sourceOrigin}
- Clone: ${cloneUrl}
- Generated: ${report.generatedAt}
- Primary screenshot widths: ${primaryWidths.join(", ")}
- Boundary widths: ${boundaryWidths.join(", ")}
- Checks: ${results.length}
- Pass: ${counts.pass || 0}, review: ${counts.review || 0}, failed: ${counts.failed || 0}

## Routes with findings

${failed.map((result) => `- FAIL ${result.route} @ ${result.width}px: ${JSON.stringify(result.checks)}`).join("\n") || "No failures."}

${review.map((result) => `- REVIEW ${result.route} @ ${result.width}px: visual ${result.visual?.status || "n/a"}, ratio ${result.visual?.changeRatio?.toFixed(6) ?? "-"}`).join("\n") || "No reviews."}
`,
);
console.log(JSON.stringify({ out, summary: report.summary }, null, 2));
if (failed.length) process.exitCode = 1;
