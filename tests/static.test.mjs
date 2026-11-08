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
