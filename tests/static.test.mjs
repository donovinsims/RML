import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrowser } from "../lib/core.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.STATIC_TEST_PORT || 4328);
const base = `http://127.0.0.1:${port}/`;
let server;
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // Keep polling while the local server starts.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Static server did not start at ${base}`);
}

test.before(async () => {
  server = spawn(process.execPath, ["serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer();
  browser = await loadBrowser();
});

test.after(async () => {
  await browser?.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((done) => {
      server.once("exit", done);
      setTimeout(done, 2_000);
    });
  }
});

test("home page has the static logo strip and working static controls", async () => {
  const errors = [];
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
  try {
    const page = await desktop.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const track = document.querySelector(".marquee-track");
      return Boolean(track && getComputedStyle(track).animationName === "none");
    });

    const logo = await page.evaluate(() => {
      const marquee = document.querySelector(".marquee");
      const track = marquee.querySelector(".marquee-track");
      const computed = getComputedStyle(marquee);
      return {
        animation: getComputedStyle(track).animationName,
        transform: getComputedStyle(track).transform,
        overflowX: computed.overflowX,
        mask: computed.maskImage || computed.webkitMaskImage,
        trackWidth: track.scrollWidth,
        containerWidth: marquee.clientWidth,
        scrollLeft: marquee.scrollLeft,
      };
    });
    assert.equal(logo.animation, "none");
    assert.equal(logo.transform, "none");
    assert.match(logo.overflowX, /^(auto|scroll)$/);
    assert.match(logo.mask, /linear-gradient/);
    assert.ok(logo.trackWidth > logo.containerWidth, `logo track ${logo.trackWidth} should exceed ${logo.containerWidth}`);
    assert.equal(logo.scrollLeft, 0);
    await page.evaluate(() => { document.querySelector(".marquee").scrollLeft = 120; });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.querySelector(".marquee").scrollLeft > 0), "logo strip should scroll horizontally");

    const faqButton = page.locator("#faq button[aria-controls]").first();
    assert.equal(await faqButton.getAttribute("aria-expanded"), "false");
    const regionId = await faqButton.getAttribute("aria-controls");
    const region = page.locator(`[id="${regionId}"]`);
    assert.equal(await region.isHidden(), true);
    await faqButton.click();
    assert.equal(await faqButton.getAttribute("aria-expanded"), "true");
    assert.equal(await region.isVisible(), true);
    await faqButton.click();
    assert.equal(await region.isHidden(), true);

    const form = page.locator("form").filter({ has: page.locator('input[name="fullName"]') });
    await form.locator('button[type="submit"]').click();
    await page.waitForSelector("[data-reconstruction-status]");
    assert.equal(new URL(page.url()).pathname, "/");
    assert.match(await page.locator("[data-reconstruction-status]").innerText(), /not sent/i);
  } finally {
    await desktop.close();
  }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  try {
    const page = await mobile.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: "networkidle" });
    const toggle = page.locator('button[aria-controls="mobile-nav"]');
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#mobile-nav").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#mobile-nav").isHidden(), true);

    const thirdDot = page.locator('button[aria-label="Show result 3 of 3"]');
    await thirdDot.click();
    await page.waitForTimeout(500);
    assert.equal(await thirdDot.getAttribute("aria-current"), "true");
    const scrollLeft = await page.evaluate(() => {
      const track = [...document.querySelectorAll("ul")].find((list) => list.querySelector("[data-tube]"));
      return track?.scrollLeft || 0;
    });
    assert.ok(scrollLeft > 0, "result carousel did not move");
  } finally {
    await mobile.close();
  }

  assert.deepEqual(errors, []);
});

test("home result cards bottom-align their actions on desktop and mobile", async () => {
  for (const width of [1440, 1180, 1024, 768, 640, 390, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);

      const cards = await page.evaluate(() => [...document.querySelectorAll("#results [data-tube]")].map((card) => {
        const content = card.lastElementChild;
        const cta = content.querySelector('a[href^="#case-"]');
        const attribution = [...content.children].find((child) => child.tagName === "SPAN" && child.querySelector(":scope > img"));
        const image = attribution?.querySelector("img");
        const text = attribution ? [...attribution.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
        const lines = [];
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects()) lines.push({ top: rect.top, height: rect.height });
        }
        const cardRect = card.getBoundingClientRect();
        const ctaRect = cta.getBoundingClientRect();
        const imageRect = image?.getBoundingClientRect();
        return {
          card: { top: cardRect.top, bottom: cardRect.bottom, height: cardRect.height },
          cta: { top: ctaRect.top, bottom: ctaRect.bottom, height: ctaRect.height },
          image: imageRect ? { top: imageRect.top, height: imageRect.height } : null,
          lines,
        };
      }));

      assert.equal(cards.length, 3, `expected three result cards at ${width}px`);
      const ctaBottoms = cards.map((card) => card.cta.bottom);
      const spread = Math.max(...ctaBottoms) - Math.min(...ctaBottoms);
      assert.ok(spread <= 1, `CTA bottoms differ by ${spread.toFixed(2)}px at ${width}px: ${ctaBottoms.map((value) => value.toFixed(1)).join(", ")}`);

      const heights = cards.map((card) => card.card.height);
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `card heights differ at ${width}px`);
      for (const card of cards) {
        assert.ok(card.cta.height >= 44, `CTA tap height ${card.cta.height}px at ${width}px`);
      }

      const wrapped = cards.filter((card) => card.lines.length > 1);
      if ([375, 640, 768].includes(width)) {
        assert.ok(wrapped.length > 0, `expected a wrapped attribution at ${width}px`);
      }
      for (const card of cards) {
        const firstLine = card.lines[0];
        const lineCenter = firstLine.top + firstLine.height / 2;
        const iconCenter = card.image.top + card.image.height / 2;
        assert.ok(
          Math.abs(lineCenter - iconCenter) <= 1.5,
          `icon center ${iconCenter.toFixed(2)} is not on the first line center ${lineCenter.toFixed(2)} at ${width}px`,
        );
      }

      if (width === 390) {
        assert.equal(await page.locator('button[aria-label="Show result 1 of 3"]').getAttribute("aria-current"), "true");
        assert.equal(await page.locator('button[aria-label="Show result 2 of 3"]').getAttribute("aria-current"), null);
        assert.equal(await page.locator('button[aria-label="Show result 3 of 3"]').getAttribute("aria-current"), null);
      }
    } finally {
      await context.close();
    }
  }
});

test("case-study read-another cards align wrapped meta icons and keep a large back-link target", async () => {
  const context = await browser.newContext({ viewport: { width: 768, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`${base}case-studies/ai-founder`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    const rows = await page.evaluate(() => [...document.querySelectorAll('[aria-labelledby="more-results"] a > span.flex.items-center')].map((row) => {
      const image = row.querySelector(":scope > img");
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      const text = walker.nextNode();
      const lines = [];
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) lines.push({ top: rect.top, height: rect.height });
      }
      const imageRect = image.getBoundingClientRect();
      return { lines, iconTop: imageRect.top, iconHeight: imageRect.height };
    }));

    assert.ok(rows.length >= 2, "expected the read-another cards");
    assert.ok(rows.some((row) => row.lines.length > 1), "expected a wrapped case-study label at 768px");
    for (const row of rows) {
      const firstLine = row.lines[0];
      const lineCenter = firstLine.top + firstLine.height / 2;
      const iconCenter = row.iconTop + row.iconHeight / 2;
      assert.ok(Math.abs(lineCenter - iconCenter) <= 1.5, `case meta icon center ${iconCenter.toFixed(2)} is not on the first line center ${lineCenter.toFixed(2)}`);
    }

    const expandedTarget = await page.evaluate(() => {
      const link = document.querySelector('main > header > a[href="/#reports"]');
      const rect = link.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top - 8);
      return hit === link || link.contains(hit);
    });
    assert.ok(expandedTarget, "case-study back link should have an expanded hit area");
  } finally {
    await context.close();
  }
});
