import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 768, height: 1000 },
  mobile: { width: 390, height: 844 },
};

export function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const body = item.slice(2);
    const separator = body.indexOf("=");
    const key = separator >= 0 ? body.slice(0, separator) : body;
    if (separator >= 0) {
      out[key] = body.slice(separator + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      out[key] = argv[++index];
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function requireOption(args, key) {
  if (!args[key] || args[key] === true) throw new Error(`Missing --${key}.`);
  return String(args[key]);
}

export const absolute = (path) => resolve(process.cwd(), path);

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

export async function loadBrowser() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

export async function stablePage(browser, viewport, options = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: options.reducedMotion ?? "reduce",
    ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
    userAgent: options.userAgent,
  });
  const page = await context.newPage();
  return { context, page };
}

function withTimeout(promise, milliseconds, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((done) => {
      timer = setTimeout(() => done(onTimeout), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Force lazy images to load, then wait for decode/load/error. This is bounded
 * and reports unresolved and broken source URLs instead of treating a timed
 * wait as a complete capture.
 */
async function settleImages(page, budgetMs) {
  if (!(budgetMs > 0)) {
    return { pendingImages: -1, pendingImageUrls: [], brokenImageUrls: [] };
  }
  try {
    return await page.evaluate(async (budget) => {
      const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
      const images = [...document.images].filter((image) => image.currentSrc || image.src || image.srcset);
      for (const image of images) {
        if (image.loading === "lazy") image.loading = "eager";
      }
      const pending = images.filter((image) => !image.complete);
      await Promise.race([
        Promise.all(pending.map(async (image) => {
          try {
            await image.decode();
          } catch {
            await new Promise((done) => {
              image.addEventListener("load", done, { once: true });
              image.addEventListener("error", done, { once: true });
              setTimeout(done, 2_000);
            });
          }
        })),
        sleep(budget),
      ]);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const sourceOf = (image) => image.currentSrc || image.src || image.srcset || "";
      return {
        pendingImages: images.filter((image) => !image.complete).length,
        pendingImageUrls: images.filter((image) => !image.complete).map(sourceOf),
        brokenImageUrls: images.filter((image) => image.complete && image.naturalWidth === 0).map(sourceOf),
      };
    }, budgetMs);
  } catch {
    return { pendingImages: -1, pendingImageUrls: [], brokenImageUrls: [] };
  }
}

/**
 * Bounded stabilization. Every wait has a deadline and every unmet condition is
 * reported to the caller instead of being treated as a complete capture.
 */
export async function stabilize(page, url, options = {}) {
  const {
    timeoutMs = 30_000,
    networkIdleMs = 3_500,
    hydrationMs = 6_000,
    scroll = false,
    maxScrollSteps = 10,
  } = options;
  const report = {
    url,
    navigated: false,
    networkIdle: false,
    fontsReady: false,
    pendingImages: 0,
    pendingImageUrls: [],
    brokenImageUrls: [],
    timedOut: [],
    navigationError: null,
  };
  const startedAt = Date.now();
  const remaining = () => Math.max(500, timeoutMs - (Date.now() - startedAt));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    report.navigated = true;
  } catch (error) {
    report.navigationError = error.message.split("\n")[0];
    report.timedOut.push("navigation");
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(networkIdleMs, remaining()) });
    report.networkIdle = true;
  } catch {
    report.timedOut.push("network-idle");
  }

  try {
    const hydration = await withTimeout(
      page.evaluate(async (budget) => {
        const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
        if (document.fonts?.ready) await Promise.race([document.fonts.ready, sleep(budget)]);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return { fontsReady: document.fonts?.status === "loaded" };
      }, hydrationMs),
      hydrationMs + 500,
      { fontsReady: false },
    );
    report.fontsReady = hydration.fontsReady;
    if (!hydration.fontsReady) report.timedOut.push("fonts");
  } catch {
    report.timedOut.push("hydration");
  }

  if (scroll) {
    try {
      await withTimeout(
        page.evaluate(async ({ steps, delay }) => {
          const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
          for (let index = 1; index <= steps; index += 1) {
            window.scrollTo(0, document.documentElement.scrollHeight * (index / steps));
            await wait(delay);
          }
          window.scrollTo(0, 0);
          await wait(delay);
        }, { steps: maxScrollSteps, delay: 80 }),
        Math.min(4_000, remaining()),
        null,
      );
    } catch {
      report.timedOut.push("lazy-scroll");
    }
  }

  const images = await settleImages(page, Math.min(12_000, remaining()));
  report.pendingImages = images.pendingImages;
  report.pendingImageUrls = images.pendingImageUrls;
  report.brokenImageUrls = images.brokenImageUrls;
  if (images.pendingImages !== 0) report.timedOut.push("images");

  try {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  } catch {
    report.timedOut.push("animation-frames");
  }

  return report;
}

/** Backwards-compatible settle wrapper used by the original single-page scripts. */
export async function settle(page, url, options = {}) {
  return stabilize(page, url, options);
}

export function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "capture";
}

export function rectOf(rect) {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}
