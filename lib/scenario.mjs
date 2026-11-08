import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { compareScreenshots, missingScreenshot } from "./diff.mjs";
import { stablePage, stabilize, writeJson } from "./core.mjs";
import { textSimilarity } from "./match.mjs";

export const SAFE_SCENARIO_PERMISSIONS = [
  "click",
  "hover",
  "focus",
  "press",
  "wait",
  "assert",
  "scroll",
  "navigate",
];

export const SCENARIO_COMPARISONS = ["screenshot", "dom", "accessibility", "route"];

const ACTION_PERMISSION = {
  click: "click",
  hover: "hover",
  focus: "focus",
  press: "press",
  wait: "wait",
  assert: "assert",
  scroll: "scroll",
  navigate: "navigate",
  fill: "fill",
};

const DESTRUCTIVE_SELECTOR = /\[type\s*=\s*["']?(?:submit|image)|\[data-(?:destructive|dangerous)|\[download\]/i;
const DESTRUCTIVE_TEXT = /\b(?:submit order|place order|purchase|pay now|checkout|delete account|delete|remove|unsubscribe|log out|sign out)\b/i;
const CREDENTIAL_SELECTOR = /\[type\s*=\s*["']?password|password|credit-card|cc-number|autocomplete\s*=\s*["']?cc-/i;

export class ScenarioError extends Error {
  constructor(issues) {
    super(`Invalid scenario:\n- ${issues.join("\n- ")}`);
    this.name = "ScenarioError";
    this.issues = issues;
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function localRoute(route, issues, label) {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
    issues.push(`${label} must be a local route beginning with a single /.`);
    return "/";
  }
  try {
    const parsed = new URL(route, "http://scenario.invalid");
    if (parsed.origin !== "http://scenario.invalid") {
      issues.push(`${label} must remain on the scenario origin.`);
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    issues.push(`${label} is not a valid route.`);
    return "/";
  }
}

function validSelector(selector) {
  return typeof selector === "string" && selector.trim().length > 0 && selector.length <= 500 && !/[\r\n]/.test(selector);
}

function timeoutValue(value, fallback, issues, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    issues.push(`${label} must be an integer between 100 and 60000 milliseconds.`);
    return fallback;
  }
  return value;
}

export function resolveScenarioViewport(value, viewports = {}, issues = [], label = "viewport") {
  const requested = value === undefined ? "desktop" : value;
  if (typeof requested === "string") {
    const viewport = viewports[requested];
    if (!viewport) {
      issues.push(`${label} references unknown viewport "${requested}".`);
      return { width: 1440, height: 1000 };
    }
    return { width: viewport.width, height: viewport.height };
  }
  if (!isObject(requested) || !Number.isInteger(requested.width) || !Number.isInteger(requested.height) || requested.width < 100 || requested.height < 100) {
    issues.push(`${label} must be a configured viewport name or {width,height}.`);
    return { width: 1440, height: 1000 };
  }
  return { width: requested.width, height: requested.height };
}

function normalizeReadiness(readiness, issues, label) {
  const entries = readiness === undefined ? [] : Array.isArray(readiness) ? readiness : [readiness];
  if (entries.length > 8) issues.push(`${label} has more than 8 readiness conditions.`);
  return entries.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isObject(entry)) {
      issues.push(`${entryLabel} must be an object.`);
      return { type: "invalid" };
    }
    if (entry.selector !== undefined && !validSelector(entry.selector)) issues.push(`${entryLabel}.selector is not valid.`);
    if (entry.text !== undefined && (typeof entry.text !== "string" || !entry.text.trim())) issues.push(`${entryLabel}.text must be a non-empty string.`);
    const type = entry.selector ? "selector" : entry.text ? "text" : entry.fonts ? "fonts" : null;
    if (!type) issues.push(`${entryLabel} needs a selector, text, or fonts condition.`);
    return {
      type,
      selector: entry.selector,
      text: entry.text,
      state: ["attached", "visible", "hidden", "detached"].includes(entry.state) ? entry.state : "visible",
      timeoutMs: timeoutValue(entry.timeoutMs, 5_000, issues, `${entryLabel}.timeoutMs`),
    };
  });
}

function normalizeAction(action, index, permissions, issues, label) {
  const actionLabel = `${label}[${index}]`;
  if (!isObject(action)) {
    issues.push(`${actionLabel} must be an object.`);
    return { type: "invalid" };
  }
  const type = action.type;
  if (!Object.hasOwn(ACTION_PERMISSION, type)) {
    issues.push(`${actionLabel}.type must be one of ${Object.keys(ACTION_PERMISSION).join(", ")}.`);
    return { type: "invalid" };
  }
  if (!permissions.includes(ACTION_PERMISSION[type])) {
    issues.push(`${actionLabel} requires explicit permission "${ACTION_PERMISSION[type]}".`);
  }
  if (type === "press" && (typeof action.key !== "string" || !action.key.trim() || action.key.length > 32)) {
    issues.push(`${actionLabel}.key must be a non-empty key name.`);
  }
  if (["click", "hover", "focus", "fill"].includes(type)) {
    if (!validSelector(action.selector)) issues.push(`${actionLabel}.selector is required.`);
    if (DESTRUCTIVE_SELECTOR.test(String(action.selector || ""))) {
      issues.push(`${actionLabel} targets a destructive or submission control; scenarios may not submit forms or trigger consequential actions.`);
    }
  }
  if (type === "fill") {
    if (typeof action.value !== "string" || action.value.length > 500) issues.push(`${actionLabel}.value must be a string of at most 500 characters.`);
    if (CREDENTIAL_SELECTOR.test(String(action.selector || ""))) {
      issues.push(`${actionLabel} targets a credential or payment field; secret collection is not permitted.`);
    }
  }
  if (type === "wait") {
    if (!action.selector && !action.text) issues.push(`${actionLabel} needs a selector or text to wait for.`);
    if (action.selector !== undefined && !validSelector(action.selector)) issues.push(`${actionLabel}.selector is not valid.`);
    if (action.state !== undefined && !["attached", "visible", "hidden", "detached"].includes(action.state)) {
      issues.push(`${actionLabel}.state must be attached, visible, hidden, or detached.`);
    }
  }
  if (type === "assert") {
    const keys = ["selector", "visible", "hidden", "text", "urlIncludes", "count", "titleIncludes"].filter((key) => action[key] !== undefined);
    if (!keys.length) issues.push(`${actionLabel} needs at least one assertion.`);
    if (action.selector !== undefined && !validSelector(action.selector)) issues.push(`${actionLabel}.selector is not valid.`);
    if (action.visible !== undefined && !validSelector(action.visible)) issues.push(`${actionLabel}.visible must be a selector.`);
    if (action.hidden !== undefined && !validSelector(action.hidden)) issues.push(`${actionLabel}.hidden must be a selector.`);
    if (action.count !== undefined && (!isObject(action.count) || !validSelector(action.count.selector) || !Number.isInteger(action.count.equals))) {
      issues.push(`${actionLabel}.count needs {selector,equals}.`);
    }
  }
  if (type === "scroll") {
    for (const axis of ["x", "y"]) {
      if (action[axis] !== undefined && !Number.isFinite(action[axis])) issues.push(`${actionLabel}.${axis} must be a number.`);
    }
    if (action.selector !== undefined && !validSelector(action.selector)) issues.push(`${actionLabel}.selector is not valid.`);
  }
  if (type === "navigate") {
    action = { ...action, route: localRoute(action.route, issues, `${actionLabel}.route`) };
  }
  return {
    type,
    selector: action.selector,
    key: action.key,
    text: action.text,
    state: action.state,
    route: action.route,
    x: action.x,
    y: action.y,
    value: action.value,
    visible: action.visible,
    hidden: action.hidden,
    urlIncludes: action.urlIncludes,
    titleIncludes: action.titleIncludes,
    count: action.count,
    timeoutMs: timeoutValue(action.timeoutMs, 5_000, issues, `${actionLabel}.timeoutMs`),
  };
}

export function normalizeScenario(scenario, { viewports = {}, index = 0 } = {}) {
  const issues = [];
  const label = `scenario[${index}]`;
  if (!isObject(scenario)) throw new ScenarioError([`${label} must be an object.`]);
  const id = typeof scenario.id === "string" ? scenario.id.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    issues.push(`${label}.id must be 1-64 lowercase letters, numbers, dots, dashes, or underscores.`);
  }
  const permissions = scenario.permissions === undefined
    ? [...SAFE_SCENARIO_PERMISSIONS]
    : Array.isArray(scenario.permissions)
      ? [...new Set(scenario.permissions)]
      : null;
  if (!permissions) issues.push(`${label}.permissions must be an array.`);
  else {
    for (const permission of permissions) {
      if (!Object.values(ACTION_PERMISSION).includes(permission)) issues.push(`${label}.permissions contains unknown permission "${permission}".`);
    }
  }
  const resolvedPermissions = permissions || [];
  const actions = Array.isArray(scenario.actions) ? scenario.actions.slice(0, 30) : [];
  if (!Array.isArray(scenario.actions)) issues.push(`${label}.actions must be an array.`);
  if (actions.length > 30) issues.push(`${label}.actions exceeds the 30-action limit.`);
  const normalizedActions = actions.map((action, actionIndex) => normalizeAction(action, actionIndex, resolvedPermissions, issues, `${label}.actions`));
  const comparisons = Array.isArray(scenario.compare) ? [...new Set(scenario.compare)] : [...SCENARIO_COMPARISONS];
  for (const axis of comparisons) {
    if (!SCENARIO_COMPARISONS.includes(axis)) issues.push(`${label}.compare contains unknown axis "${axis}".`);
  }
  const expect = isObject(scenario.expect) ? scenario.expect : {};
  if (scenario.expect !== undefined && !isObject(scenario.expect)) issues.push(`${label}.expect must be an object.`);
  const route = localRoute(scenario.route || "/", issues, `${label}.route`);
  const viewport = resolveScenarioViewport(scenario.viewport, viewports, issues, `${label}.viewport`);
  const readiness = normalizeReadiness(scenario.readiness, issues, `${label}.readiness`);
  const expectedRoute = expect.route === undefined ? null : localRoute(expect.route, issues, `${label}.expect.route`);
  if (issues.length) throw new ScenarioError(issues);

  return {
    id,
    name: typeof scenario.name === "string" ? scenario.name.slice(0, 160) : id,
    route,
    viewportName: typeof scenario.viewport === "string" ? scenario.viewport : "custom",
    viewport,
    permissions: resolvedPermissions,
    readiness,
    actions: normalizedActions,
    compare: comparisons,
    expect: {
      route: expectedRoute,
      urlIncludes: typeof expect.urlIncludes === "string" ? expect.urlIncludes.slice(0, 500) : null,
      titleIncludes: typeof expect.titleIncludes === "string" ? expect.titleIncludes.slice(0, 200) : null,
      selectorVisible: validSelector(expect.selectorVisible) ? expect.selectorVisible : null,
      selectorHidden: validSelector(expect.selectorHidden) ? expect.selectorHidden : null,
    },
    timeoutMs: timeoutValue(scenario.timeoutMs, 15_000, issues, `${label}.timeoutMs`),
  };
}

export function normalizeScenarioSuite(input, { viewports = {} } = {}) {
  const scenarios = Array.isArray(input) ? input : input?.scenarios;
  if (!Array.isArray(scenarios) || !scenarios.length) throw new ScenarioError(["The suite must contain at least one scenario."]);
  if (scenarios.length > 50) throw new ScenarioError(["The suite exceeds the 50-scenario limit."]);
  const normalized = scenarios.map((scenario, index) => normalizeScenario(scenario, { viewports, index }));
  const ids = new Set();
  const issues = [];
  for (const scenario of normalized) {
    if (ids.has(scenario.id)) issues.push(`Duplicate scenario id "${scenario.id}".`);
    ids.add(scenario.id);
  }
  if (issues.length) throw new ScenarioError(issues);
  return normalized;
}

export async function loadScenarioSuite(path, options = {}) {
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ScenarioError([`Unable to read ${path}: ${error.message.split("\n")[0]}`]);
  }
  return normalizeScenarioSuite(document, options);
}

function assertSafeAction(action) {
  if (["click", "hover", "focus", "fill"].includes(action.type) && DESTRUCTIVE_SELECTOR.test(String(action.selector || ""))) {
    throw new Error(`Refusing ${action.type} on a submission or destructive target: ${action.selector}`);
  }
  if (action.type === "click" && DESTRUCTIVE_TEXT.test(String(action.selector || ""))) {
    throw new Error(`Refusing consequential click target: ${action.selector}`);
  }
  if (action.type === "fill" && CREDENTIAL_SELECTOR.test(String(action.selector || ""))) {
    throw new Error(`Refusing to fill a credential or payment field: ${action.selector}`);
  }
}

function sanitizeAction(action) {
  const safe = { ...action };
  if (typeof safe.value === "string") safe.value = "[redacted]";
  return safe;
}

function observePage() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name: clean(element.getAttribute("aria-label") || element.innerText || element.getAttribute("title") || element.getAttribute("placeholder") || "").slice(0, 180),
      selector: element.id
        ? `#${CSS.escape(element.id)}`
        : `${element.tagName.toLowerCase()}${element.classList.length ? `.${[...element.classList].slice(0, 3).map(CSS.escape).join(".")}` : ""}`,
      expanded: element.getAttribute("aria-expanded"),
      selected: element.getAttribute("aria-selected"),
      disabled: element.matches(":disabled"),
      hidden: !visible(element),
    };
  };
  const roots = [...document.querySelectorAll("body > header, main > *, body > footer")]
    .filter((element) => element.getBoundingClientRect().height > 4);
  const sections = (roots.length ? roots : [...document.querySelectorAll("main, section")].filter((element) => element.getBoundingClientRect().height > 4))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const heading = element.querySelector("h1,h2,h3,h4");
      return {
        selector: element.id
          ? `#${CSS.escape(element.id)}`
          : `${element.tagName.toLowerCase()}${element.classList.length ? `.${[...element.classList].slice(0, 3).map(CSS.escape).join(".")}` : ""}`,
        heading: clean(heading?.textContent).slice(0, 160) || null,
        text: clean(element.innerText || element.textContent).slice(0, 500),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
  const interactive = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="tab"],summary')]
    .filter((element) => element.getBoundingClientRect().width > 0)
    .slice(0, 200)
    .map(describe);
  const forms = [...document.querySelectorAll("form")].slice(0, 20).map((form) => ({
    action: form.getAttribute("action"),
    method: (form.getAttribute("method") || "get").toLowerCase(),
    fields: [...form.querySelectorAll("input,select,textarea")].map((field) => ({
      name: field.getAttribute("name"),
      type: field.getAttribute("type") || field.tagName.toLowerCase(),
      required: field.required,
      disabled: field.disabled,
    })),
  }));
  return {
    url: `${location.pathname}${location.search}${location.hash}`,
    title: clean(document.title),
    text: clean(document.body.innerText || document.body.textContent).slice(0, 12_000),
    headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((element) => clean(element.textContent)).filter(Boolean),
    sections,
    interactive,
    accessibility: {
      landmarks: [...document.querySelectorAll('header,footer,main,nav,aside,[role="banner"],[role="main"],[role="contentinfo"],[role="navigation"],[role="dialog"]')]
        .map((element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: element.getAttribute("aria-label") }))
        .slice(0, 40),
      names: interactive.map((entry) => entry.name).filter(Boolean),
      headingLevels: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((element) => Number(element.tagName[1])),
      formCount: forms.length,
      dialogOpenCount: document.querySelectorAll("dialog[open]").length,
    },
    forms,
  };
}

async function bounded(page, label, timeoutMs, operation) {
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (error) {
    throw new Error(`${label}: ${error.message.split("\n")[0]}`);
  }
}

async function waitReadiness(page, conditions, overallTimeoutMs) {
  const warnings = [];
  const deadline = Date.now() + overallTimeoutMs;
  for (const condition of conditions) {
    const timeout = Math.max(100, Math.min(condition.timeoutMs, deadline - Date.now()));
    if (condition.type === "selector") {
      await page.locator(condition.selector).first().waitFor({ state: condition.state, timeout });
    } else if (condition.type === "text") {
      await page.waitForFunction((text) => (document.body?.innerText || "").includes(text), condition.text, { timeout });
    } else if (condition.type === "fonts") {
      await page.evaluate(() => document.fonts.ready);
    }
  }
  return warnings;
}

async function readObservation(page) {
  const observation = await page.evaluate(observePage);
  observation.textHash = hash(observation.text);
  observation.interactiveHash = hash(observation.interactive.map((entry) => `${entry.role || ""}:${entry.name}:${entry.expanded}:${entry.selected}`).join("|"));
  observation.sectionHash = hash(observation.sections.map((section) => `${section.selector}:${section.heading}:${section.text}`).join("|"));
  return observation;
}

async function writeState(page, { out, directory, name, captureScreenshots }) {
  const observation = await readObservation(page);
  let screenshot = null;
  if (captureScreenshots) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${name}.png`);
    await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide" });
    screenshot = relative(out, path);
  }
  return { observation, screenshot };
}

async function locate(page, selector, action) {
  const target = page.locator(selector).first();
  const expected = action?.type === "assert" ? "attached" : "visible";
  await target.waitFor({ state: expected, timeout: action?.timeoutMs || 5_000 });
  return target;
}

async function checkAssertions(page, action) {
  const failures = [];
  if (action.visible) {
    if (!(await page.locator(action.visible).first().isVisible().catch(() => false))) failures.push(`Expected ${action.visible} to be visible.`);
  }
  if (action.hidden) {
    if (await page.locator(action.hidden).first().isVisible().catch(() => false)) failures.push(`Expected ${action.hidden} to be hidden.`);
  }
  if (action.text) {
    const body = await page.evaluate(() => document.body?.innerText || "");
    if (!body.includes(action.text)) failures.push(`Expected visible text to include "${action.text}".`);
  }
  if (action.urlIncludes && !page.url().includes(action.urlIncludes)) failures.push(`Expected URL to include "${action.urlIncludes}".`);
  if (action.titleIncludes && !(await page.title()).includes(action.titleIncludes)) failures.push(`Expected title to include "${action.titleIncludes}".`);
  if (action.count) {
    const count = await page.locator(action.count.selector).count();
    if (count !== action.count.equals) failures.push(`Expected ${action.count.selector} count ${action.count.equals}, got ${count}.`);
  }
  if (failures.length) throw new Error(failures.join(" "));
}

async function executeAction(page, action, baseUrl, out, runRoot) {
  assertSafeAction(action);
  if (action.type === "click") {
    const target = await locate(page, action.selector, action);
    const text = clean(await target.innerText().catch(() => ""));
    if (DESTRUCTIVE_TEXT.test(text)) throw new Error(`Refusing consequential click target "${text}".`);
    await target.click({ timeout: action.timeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(action.timeoutMs, 3_000) }).catch(() => {});
  } else if (action.type === "hover") {
    await (await locate(page, action.selector, action)).hover({ timeout: action.timeoutMs });
  } else if (action.type === "focus") {
    await (await locate(page, action.selector, action)).focus({ timeout: action.timeoutMs });
  } else if (action.type === "fill") {
    if (CREDENTIAL_SELECTOR.test(action.selector)) throw new Error("Refusing to fill a credential or payment field.");
    await (await locate(page, action.selector, action)).fill(action.value, { timeout: action.timeoutMs });
  } else if (action.type === "press") {
    if (action.key === "Enter") {
      const inForm = await page.evaluate(() => Boolean(document.activeElement?.closest("form")));
      if (inForm) throw new Error("Refusing Enter inside a form because it may submit a consequential request.");
    }
    await page.keyboard.press(action.key);
  } else if (action.type === "wait") {
    if (action.selector) {
      await page.locator(action.selector).first().waitFor({ state: action.state || "visible", timeout: action.timeoutMs });
    } else {
      await page.waitForFunction((text) => (document.body?.innerText || "").includes(text), action.text, { timeout: action.timeoutMs });
    }
  } else if (action.type === "assert") {
    await checkAssertions(page, action);
  } else if (action.type === "scroll") {
    if (action.selector) {
      await (await locate(page, action.selector, action)).scrollIntoViewIfNeeded({ timeout: action.timeoutMs });
    } else {
      await page.mouse.wheel(action.x || 0, action.y || 600);
    }
  } else if (action.type === "navigate") {
    const target = new URL(action.route, baseUrl);
    if (target.origin !== new URL(baseUrl).origin) throw new Error("Scenario navigation must remain on the target origin.");
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: action.timeoutMs });
  }
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForTimeout(60);
  return readObservation(page);
}

export async function runScenario({ browser, scenario, baseUrl, out, role = "source", captureScreenshots = true }) {
  const directory = join(out, "scenarios", role, scenario.id);
  const startedAt = new Date().toISOString();
  const warnings = [];
  const failures = [];
  const steps = [];
  let initial = null;
  let final = null;
  let initialScreenshot = null;
  let finalScreenshot = null;

  const { context, page } = await stablePage(browser, scenario.viewport);
  try {
    await context.addInitScript(() => {
      addEventListener("submit", (event) => {
        event.preventDefault();
        window.__ppBlockedSubmits = (window.__ppBlockedSubmits || 0) + 1;
      }, true);
      HTMLFormElement.prototype.submit = function blockedSubmit() {};
      window.open = () => null;
    });
    page.on("dialog", (dialog) => {
      warnings.push(`Dismissed unexpected ${dialog.type()} dialog: ${dialog.message().slice(0, 120)}`);
      dialog.dismiss().catch(() => {});
    });
    page.on("popup", (popup) => {
      warnings.push(`Closed unexpected popup: ${popup.url()}`);
      popup.close().catch(() => {});
    });
    page.on("download", (download) => {
      warnings.push(`Cancelled download: ${download.suggestedFilename()}`);
      download.cancel().catch(() => {});
    });

    const target = new URL(scenario.route, baseUrl).href;
    const stabilization = await stabilize(page, target, { timeoutMs: scenario.timeoutMs, scroll: false });
    if (stabilization.navigationError) failures.push({ stage: "navigation", message: stabilization.navigationError });
    await waitReadiness(page, scenario.readiness, scenario.timeoutMs);
    const initialState = await writeState(page, { out, directory, name: "00-initial", captureScreenshots });
    initial = initialState.observation;
    initialScreenshot = initialState.screenshot;

    for (let index = 0; index < scenario.actions.length; index += 1) {
      const action = scenario.actions[index];
      const step = {
        index,
        action: sanitizeAction(action),
        status: "ok",
        startedAt: new Date().toISOString(),
      };
      try {
        step.observation = await executeAction(page, action, baseUrl, out, directory);
        const state = await writeState(page, { out, directory, name: `${String(index + 1).padStart(2, "0")}-${action.type}`, captureScreenshots });
        step.observation = state.observation;
        step.screenshot = state.screenshot;
        step.url = state.observation.url;
      } catch (error) {
        step.status = "failed";
        step.error = error.message.split("\n")[0];
        failures.push({ stage: "action", index, type: action.type, message: step.error });
      }
      step.durationMs = Date.now() - new Date(step.startedAt).getTime();
      steps.push(step);
      if (step.status === "failed") {
        for (let remaining = index + 1; remaining < scenario.actions.length; remaining += 1) {
          steps.push({ index: remaining, action: sanitizeAction(scenario.actions[remaining]), status: "skipped" });
        }
        break;
      }
    }

    const finalState = await writeState(page, { out, directory, name: "99-final", captureScreenshots });
    final = finalState.observation;
    finalScreenshot = finalState.screenshot;
    if (scenario.expect.route && final.url.split("#")[0] !== scenario.expect.route.split("#")[0]) failures.push({ stage: "expect", message: `Expected route ${scenario.expect.route}, got ${final.url}.` });
    if (scenario.expect.urlIncludes && !page.url().includes(scenario.expect.urlIncludes)) failures.push({ stage: "expect", message: `Expected URL to include ${scenario.expect.urlIncludes}.` });
    if (scenario.expect.titleIncludes && !final.title.includes(scenario.expect.titleIncludes)) failures.push({ stage: "expect", message: `Expected title to include ${scenario.expect.titleIncludes}.` });
    if (scenario.expect.selectorVisible && !(await page.locator(scenario.expect.selectorVisible).first().isVisible().catch(() => false))) failures.push({ stage: "expect", message: `${scenario.expect.selectorVisible} is not visible.` });
    if (scenario.expect.selectorHidden && await page.locator(scenario.expect.selectorHidden).first().isVisible().catch(() => false)) failures.push({ stage: "expect", message: `${scenario.expect.selectorHidden} is still visible.` });
    const blockedSubmits = await page.evaluate(() => window.__ppBlockedSubmits || 0).catch(() => 0);
    if (blockedSubmits) warnings.push(`Blocked ${blockedSubmits} form submission(s) during the scenario.`);

    const evidence = {
      version: 1,
      kind: "rml-scenario-evidence",
      scenario: {
        id: scenario.id,
        name: scenario.name,
        route: scenario.route,
        viewport: scenario.viewport,
        viewportName: scenario.viewportName,
        permissions: scenario.permissions,
        compare: scenario.compare,
      },
      role,
      target: { baseUrl, url: target },
      startedAt,
      completedAt: new Date().toISOString(),
      captureStatus: failures.length ? (steps.some((step) => step.status === "ok") ? "partial" : "failed") : "captured",
      initial,
      initialScreenshot,
      steps,
      final,
      finalScreenshot,
      failures,
      warnings,
      safety: {
        formSubmissionsBlocked: true,
        downloadsCancelled: true,
        popupsClosed: true,
        secretValuesCaptured: false,
        fillValuesRedacted: true,
      },
    };
    await writeJson(join(directory, "evidence.json"), evidence);
    return evidence;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function runScenarioSuite({ browser, scenarios, baseUrl, out, role = "source", logger = { info() {} }, captureScreenshots = true }) {
  const results = [];
  for (const scenario of scenarios) {
    logger.info?.(`[${role}] scenario ${scenario.id}`);
    try {
      results.push(await runScenario({ browser, scenario, baseUrl, out, role, captureScreenshots }));
    } catch (error) {
      results.push({
        version: 1,
        kind: "rml-scenario-evidence",
        scenario: { id: scenario.id, name: scenario.name, route: scenario.route, viewport: scenario.viewport, compare: scenario.compare },
        role,
        target: { baseUrl },
        captureStatus: "failed",
        failures: [{ stage: "setup", message: error.message.split("\n")[0] }],
        warnings: [],
        steps: [],
      });
    }
  }
  return results;
}

function routeOf(observation) {
  return String(observation?.url || "/").split("#")[0];
}

function compareDom(source, clone) {
  const exact = source?.textHash && source.textHash === clone?.textHash;
  const similarity = textSimilarity(source?.text || "", clone?.text || "");
  const headingsEqual = JSON.stringify(source?.headings || []) === JSON.stringify(clone?.headings || []);
  const sectionCount = (source?.sections || []).length;
  const cloneSectionCount = (clone?.sections || []).length;
  let status;
  let message;
  if (exact && headingsEqual && sectionCount === cloneSectionCount) {
    status = "measured";
    message = "Visible text, headings, and section counts are identical.";
  } else if (similarity >= 0.9) {
    status = "review";
    message = `DOM text similarity ${(similarity * 100).toFixed(1)}%; semantic equivalence requires review.`;
  } else {
    status = "fail";
    message = `DOM text similarity ${(similarity * 100).toFixed(1)}%; content differs materially.`;
  }
  return {
    axis: "dom",
    status,
    similarity: Number(similarity.toFixed(4)),
    textExact: Boolean(exact),
    headingsEqual,
    sectionCount,
    cloneSectionCount,
    message,
  };
}

function compareAccessibility(source, clone) {
  const left = source?.accessibility?.names || [];
  const right = clone?.accessibility?.names || [];
  const exact = JSON.stringify(left) === JSON.stringify(right);
  const similarity = textSimilarity(left.join(" | "), right.join(" | "));
  const landmarksEqual = JSON.stringify(source?.accessibility?.landmarks || []) === JSON.stringify(clone?.accessibility?.landmarks || []);
  const status = exact && landmarksEqual ? "measured" : similarity >= 0.85 ? "review" : "fail";
  return {
    axis: "accessibility",
    status,
    similarity: Number(similarity.toFixed(4)),
    namesEqual: exact,
    landmarksEqual,
    sourceNames: left.length,
    cloneNames: right.length,
    message: status === "measured" ? "Interactive names and landmarks match." : "Accessibility names/landmarks differ; review the structural semantics.",
  };
}

async function compareScreenshotsForScenario({ sourceEvidence, cloneEvidence, sourceDir, cloneDir, outDir, thresholds }) {
  const records = [];
  const pairs = [
    { label: "initial", source: sourceEvidence.initialScreenshot, clone: cloneEvidence.initialScreenshot },
    ...sourceEvidence.steps.map((step, index) => ({
      label: `step-${index + 1}`,
      source: step.screenshot,
      clone: cloneEvidence.steps[index]?.screenshot,
    })),
    { label: "final", source: sourceEvidence.finalScreenshot, clone: cloneEvidence.finalScreenshot },
  ].filter((pair) => pair.source || pair.clone);
  for (const pair of pairs) {
    if (!pair.source || !pair.clone) {
      records.push({ step: pair.label, status: "fail", message: "Missing source or clone screenshot.", changeRatio: 1 });
      continue;
    }
    try {
      const sourceBuffer = await readFile(join(sourceDir, pair.source));
      const cloneBuffer = await readFile(join(cloneDir, pair.clone));
      const comparison = await compareScreenshots(sourceBuffer, cloneBuffer, { threshold: 0.1 });
      if (comparison.diffPng) {
        await mkdir(outDir, { recursive: true });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(outDir, `${pair.label}.png`), comparison.diffPng);
      }
      const status = comparison.changeRatio <= thresholds.pass && !comparison.dimensionMismatch
        ? "pass"
        : comparison.changeRatio <= thresholds.review && !comparison.dimensionMismatch
          ? "review"
          : "fail";
      records.push({
        step: pair.label,
        status,
        changeRatio: Number(comparison.changeRatio.toFixed(6)),
        changedPixels: comparison.changedPixels,
        dimensionMismatch: comparison.dimensionMismatch,
        largestDifferenceRegion: comparison.largestDifferenceRegion,
      });
    } catch (error) {
      records.push({ step: pair.label, status: "fail", error: error.code || "SCREENSHOT_COMPARE_FAILED", message: error.message.split("\n")[0] });
    }
  }
  return records;
}

/**
 * Compare source and clone scenario evidence. Verified requires every axis to
 * agree; a visually similar screenshot can never override a DOM or route failure.
 */
export async function compareScenarioEvidence({
  source,
  clone,
  sourceDir,
  cloneDir,
  outDir,
  thresholds = { pass: 0.005, review: 0.02 },
}) {
  const discrepancies = [];
  if (source.scenario?.id !== clone.scenario?.id) {
    discrepancies.push({ axis: "identity", severity: "fail", message: "Scenario IDs do not match." });
  }
  const stepAlignment = source.steps?.length === clone.steps?.length
    && (source.steps || []).every((step, index) => step.action?.type === clone.steps[index]?.action?.type);
  if (!stepAlignment) discrepancies.push({ axis: "steps", severity: "fail", message: "Scenario steps are not aligned by action type and index." });

  const routeAxis = {
    axis: "route",
    status: routeOf(source.final) === routeOf(clone.final) ? "measured" : "fail",
    source: routeOf(source.final),
    clone: routeOf(clone.final),
    message: routeOf(source.final) === routeOf(clone.final) ? "Final routes match." : "Final routes differ.",
  };
  if (routeAxis.status === "fail") discrepancies.push({ axis: "route", severity: "fail", message: routeAxis.message });

  const domAxis = compareDom(source.final, clone.final);
  if (domAxis.status !== "measured") discrepancies.push({ axis: "dom", severity: domAxis.status, message: domAxis.message });
  const accessibilityAxis = compareAccessibility(source.final, clone.final);
  if (accessibilityAxis.status !== "measured") discrepancies.push({ axis: "accessibility", severity: accessibilityAxis.status, message: accessibilityAxis.message });

  const screenshotRecords = source.scenario?.compare?.includes("screenshot") === false
    ? []
    : await compareScreenshotsForScenario({ sourceEvidence: source, cloneEvidence: clone, sourceDir, cloneDir, outDir, thresholds });
  for (const record of screenshotRecords) {
    if (record.status === "fail") discrepancies.push({ axis: "screenshot", severity: "fail", step: record.step, message: record.error || `Screenshot changed by ${(record.changeRatio * 100).toFixed(3)}%.` });
    else if (record.status === "review") discrepancies.push({ axis: "screenshot", severity: "review", step: record.step, message: `Screenshot changed by ${(record.changeRatio * 100).toFixed(3)}%; review required.` });
  }

  if (!source.final || !clone.final) {
    discrepancies.push({ axis: "evidence", severity: "fail", message: "Scenario evidence is missing its final observation." });
  }
  if (source.captureStatus === "failed" || clone.captureStatus === "failed" || (source.steps || []).some((step) => step.status === "failed")) {
    discrepancies.push({ axis: "capture", severity: "fail", message: "Scenario capture contains failed or skipped actions." });
  } else if (source.captureStatus !== "captured" || clone.captureStatus !== "captured") {
    discrepancies.push({ axis: "capture", severity: "review", message: "Scenario capture is partial; the result cannot be verified." });
  }

  const axes = [routeAxis, domAxis, accessibilityAxis];
  const failed = discrepancies.some((entry) => entry.severity === "fail") || !stepAlignment;
  const reviewed = discrepancies.some((entry) => entry.severity === "review");
  const screenshotsPassed = screenshotRecords.every((record) => record.status === "pass");
  const status = failed ? "fail" : reviewed || !screenshotsPassed ? "review" : "verified";

  return {
    version: 1,
    kind: "rml-scenario-comparison",
    scenarioId: source.scenario?.id,
    generatedAt: new Date().toISOString(),
    status,
    verified: status === "verified" && source.captureStatus === "captured" && clone.captureStatus === "captured",
    stepAlignment,
    axes,
    screenshots: screenshotRecords,
    discrepancies,
    thresholds,
    caveats: [
      "Scenarios exercise only explicitly authored actions and states.",
      "Visual similarity alone is never treated as functional equivalence.",
      "A verified result covers this scenario, not every possible interaction.",
    ],
  };
}

export function scenarioReportMarkdown(report) {
  const lines = [
    "# Interaction scenario report",
    "",
    `- Scenario: ${report.scenarioId}`,
    `- Status: **${report.status}**`,
    `- Verified: **${report.verified ? "yes" : "no"}**`,
    `- Steps aligned: ${report.stepAlignment ? "yes" : "no"}`,
    "",
    "| Axis | Status | Detail |",
    "| --- | --- | --- |",
    ...report.axes.map((axis) => `| ${axis.axis} | ${axis.status} | ${String(axis.message || "").replace(/\|/g, "\\|")} |`),
    ...report.discrepancies.map((entry) => `| ${entry.axis}${entry.step ? `/${entry.step}` : ""} | ${entry.severity} | ${String(entry.message || "").replace(/\|/g, "\\|")} |`),
    "",
    "Screenshots:",
    "",
    ...report.screenshots.map((record) => `- ${record.step}: ${record.status}${record.changeRatio !== undefined ? ` (${(record.changeRatio * 100).toFixed(3)}% changed)` : ""}`),
    "",
    ...report.caveats.map((caveat) => `> ${caveat}`),
    "",
  ];
  return lines.join("\n");
}
