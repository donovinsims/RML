/**
 * Minimal RFC 9309 robots.txt parser. It deliberately implements only the
 * directives this workflow needs: user-agent grouping, allow/disallow,
 * crawl-delay, and sitemap discovery.
 */

export function parseRobots(text = "") {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasUserAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasUserAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value || "*");
      lastWasUserAgent = true;
      continue;
    }
    if (!current) continue;
    lastWasUserAgent = false;
    if (field === "allow") {
      if (value) current.allow.push(value);
    } else if (field === "disallow") {
      if (value) current.disallow.push(value);
    } else if (field === "crawl-delay") {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }

  return { groups, sitemaps: [...new Set(sitemaps)] };
}

function ruleToRegExp(rule) {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ".*"}`);
}

function selectRules(groups, userAgent) {
  const agent = String(userAgent).toLowerCase();
  let bestSpecificity = -1;
  let selected = [];
  for (const group of groups) {
    for (const token of group.agents) {
      const normalized = token.toLowerCase();
      const specificity = normalized === "*" ? 0 : agent.includes(normalized) ? normalized.length + 1 : -1;
      if (specificity < 0) continue;
      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        selected = [group];
      } else if (specificity === bestSpecificity) {
        selected.push(group);
      }
    }
  }
  return selected;
}

/** Longest matching rule wins; allow wins a tie, per RFC 9309. */
export function robotsAllows(inputPath, parsed, { userAgent = "RMLBenchmark" } = {}) {
  const groups = selectRules(parsed?.groups || [], userAgent);
  if (!groups.length) return true;
  const path = String(inputPath || "/");
  let best = null;
  for (const group of groups) {
    for (const [type, rules] of [["allow", group.allow], ["disallow", group.disallow]]) {
      for (const rule of rules) {
        if (!ruleToRegExp(rule).test(path)) continue;
        const length = rule.length;
        if (!best || length > best.length || (length === best.length && type === "allow")) best = { type, length, rule };
      }
    }
  }
  return !best || best.type === "allow";
}

export function crawlDelayFrom(parsed, { userAgent = "RMLBenchmark" } = {}) {
  const groups = selectRules(parsed?.groups || [], userAgent);
  const values = groups.map((group) => group.crawlDelay).filter((value) => typeof value === "number");
  return values.length ? Math.max(...values) : null;
}
