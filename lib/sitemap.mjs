import { normalizeUrl } from "./url.mjs";

const LOC_PATTERN = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;

function decodeXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Parse a sitemap urlset or sitemapindex without an XML dependency. Sitemaps
 * are simple, well-specified documents; malformed input returns "unknown"
 * rather than throwing.
 */
export function parseSitemap(xml) {
  const text = String(xml || "");
  if (/<sitemapindex[\s>]/i.test(text)) {
    const sitemaps = [...text.matchAll(LOC_PATTERN)].map((match) => decodeXml(match[1])).filter(Boolean);
    return { kind: "index", entries: [], sitemaps: [...new Set(sitemaps)] };
  }
  if (/<urlset[\s>]/i.test(text)) {
    const entries = [];
    for (const match of text.matchAll(/<url[\s>][\s\S]*?<\/url>/gi)) {
      const block = match[0];
      const location = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
      if (!location) continue;
      const lastmod = block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i);
      entries.push({ loc: decodeXml(location[1]), lastmod: lastmod ? decodeXml(lastmod[1]) : null });
    }
    return { kind: "urlset", entries, sitemaps: [] };
  }
  return { kind: "unknown", entries: [], sitemaps: [] };
}

/**
 * Traverse sitemap indexes breadth-first with a hard file-count bound.
 * Failures are reported per sitemap and never abort the whole discovery.
 */
export async function collectSitemapUrls({ sitemapUrls = [], maxSitemaps = 10, fetchText }) {
  const queue = [...new Set(sitemapUrls)];
  const visited = new Set();
  const records = [];
  const failures = [];
  const urls = new Map();
  let truncated = false;

  while (queue.length) {
    const sitemapUrl = queue.shift();
    if (visited.has(sitemapUrl)) continue;
    if (visited.size >= maxSitemaps) {
      truncated = true;
      break;
    }
    visited.add(sitemapUrl);
    let document;
    try {
      document = await fetchText(sitemapUrl);
    } catch (error) {
      failures.push({ url: sitemapUrl, error: error.message });
      records.push({ url: sitemapUrl, kind: "unknown", status: "error", count: 0, error: error.message });
      continue;
    }
    const parsed = parseSitemap(document);
    const record = { url: sitemapUrl, kind: parsed.kind, status: "ok", count: 0, error: null };
    if (parsed.kind === "index") {
      for (const child of parsed.sitemaps) {
        if (visited.has(child) || queue.includes(child)) continue;
        queue.push(child);
      }
      record.count = parsed.sitemaps.length;
    } else {
      record.count = parsed.entries.length;
      for (const entry of parsed.entries) {
        let normalized;
        try {
          normalized = normalizeUrl(entry.loc, sitemapUrl);
        } catch {
          continue;
        }
        const existing = urls.get(normalized);
        if (existing) {
          if (!existing.sources.includes(sitemapUrl)) existing.sources.push(sitemapUrl);
          if (!existing.lastmod && entry.lastmod) existing.lastmod = entry.lastmod;
        } else {
          urls.set(normalized, { url: normalized, lastmod: entry.lastmod || null, sources: [sitemapUrl] });
        }
      }
    }
    records.push(record);
  }

  return {
    urls: [...urls.values()].sort((left, right) => left.url.localeCompare(right.url)),
    sitemaps: records,
    failures,
    truncated: truncated || queue.length > 0,
    visited: [...visited],
  };
}

/** Common sitemap locations tried when robots.txt declares none. */
export function defaultSitemapCandidates(origin) {
  return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
}
