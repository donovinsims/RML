import { createHash } from "node:crypto";

export function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(value) {
  return normalizeText(value).split(/[^a-z0-9\u00c0-\u024f]+/i).filter(Boolean);
}

/** Dice coefficient over token multisets; stable for repeated words. */
export function textSimilarity(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.length && !rightTokens.length) return 1;
  if (!leftTokens.length || !rightTokens.length) return 0;
  const counts = new Map();
  for (const token of leftTokens) counts.set(token, (counts.get(token) || 0) + 1);
  let intersection = 0;
  for (const token of rightTokens) {
    const count = counts.get(token);
    if (count) {
      intersection += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

export function sectionFingerprint(section) {
  const material = [
    section?.tag || "",
    section?.role || "",
    normalizeText(section?.heading),
    normalizeText(section?.text).slice(0, 160),
  ].join("|");
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

function headingOf(section) {
  if (section?.heading) return section.heading;
  return String(section?.text || "").split(/\s+/).slice(0, 4).join(" ");
}

function rectHeight(section) {
  return Math.abs(Number(section?.rect?.height) || 0);
}

export function geometryScore(source, candidate, sourceIndex, candidateIndex) {
  if (source?.tag && candidate?.tag && source.tag !== candidate.tag) return 0;
  if (!source?.rect || !candidate?.rect) return 0;
  const sourceHeight = rectHeight(source);
  const candidateHeight = rectHeight(candidate);
  const heightRatio = sourceHeight && candidateHeight
    ? Math.min(sourceHeight, candidateHeight) / Math.max(sourceHeight, candidateHeight)
    : 0;
  const indexPenalty = Math.abs(sourceIndex - candidateIndex);
  if (heightRatio >= 0.8 && indexPenalty === 0) return 0.75;
  if (heightRatio >= 0.8 && indexPenalty === 1) return 0.65;
  if (heightRatio >= 0.5 && indexPenalty === 0) return 0.6;
  return 0;
}

function scorePair(source, candidate, sourceIndex, candidateIndex) {
  let score = 0;
  let matchedBy = null;
  const sameSelector = Boolean(source?.selector && candidate?.selector && source.selector === candidate.selector);
  const sameTag = Boolean(source?.tag && candidate?.tag && source.tag === candidate.tag);
  const headingSimilarity = textSimilarity(headingOf(source), headingOf(candidate));
  const bodySimilarity = textSimilarity(source?.text, candidate?.text);
  const sameFingerprint = Boolean(source?.fingerprint && source.fingerprint === candidate?.fingerprint);

  if (sameFingerprint) return { score: 1, matchedBy: "semantic" };
  if (sameTag && headingSimilarity >= 0.99 && (source?.text || source?.heading)) {
    score = 0.95;
    matchedBy = "semantic";
  }
  if (bodySimilarity >= 0.8 && score < 0.85) {
    score = 0.85;
    matchedBy = "semantic";
  }
  if (sameSelector && sameTag && score < 0.8) {
    score = 0.8;
    matchedBy = "semantic";
  }
  if (sameTag && headingSimilarity >= 0.7 && score < 0.72) {
    score = 0.72;
    matchedBy = "semantic";
  }

  const geometry = geometryScore(source, candidate, sourceIndex, candidateIndex);
  const geometryWeighted = geometry * 0.8;
  if (geometryWeighted > score) {
    score = geometryWeighted;
    matchedBy = "geometry";
  }
  return { score, matchedBy };
}

function deltasBetween(source, candidate) {
  if (!source?.rect || !candidate?.rect) return {};
  return Object.fromEntries(
    ["x", "y", "width", "height"].map((key) => [key, Math.round((candidate.rect[key] || 0) - (source.rect[key] || 0))]),
  );
}

function styleMatchesBetween(source, candidate) {
  if (!source?.style || !candidate?.style) return undefined;
  return Object.fromEntries(
    Object.entries(source.style)
      .filter(([key]) => key in candidate.style)
      .map(([key, value]) => [key, value === candidate.style[key]]),
  );
}

/**
 * Match source sections to clone sections using stable semantic signals first.
 * Exact visible text, or an empty source/clone pair with identical tag,
 * geometry, and computed styles, may be reported as "measured". Every other
 * match is review-only, and no candidate is a failure rather than an index guess.
 */
export function matchSections(sourceSections = [], cloneSections = []) {
  const used = new Set();
  const results = new Array(sourceSections.length);
  const pairs = [];

  sourceSections.forEach((source, sourceIndex) => {
    const normalizedSource = normalizeText(source?.text);
    if (!normalizedSource) return;
    const candidateIndex = cloneSections.findIndex((candidate, index) => !used.has(index) && normalizeText(candidate?.text) === normalizedSource);
    if (candidateIndex >= 0) {
      used.add(candidateIndex);
      results[sourceIndex] = { matchedBy: "text", confidence: "exact", status: "measured", cloneIndex: candidateIndex, score: 1 };
    }
  });

  sourceSections.forEach((source, sourceIndex) => {
    if (results[sourceIndex] || normalizeText(source?.text)) return;
    const candidateIndex = cloneSections.findIndex((candidate, index) => (
      !used.has(index) && !normalizeText(candidate?.text) && candidate?.tag === source?.tag
    ));
    if (candidateIndex < 0) return;
    const candidate = cloneSections[candidateIndex];
    const deltas = deltasBetween(source, candidate);
    const styles = styleMatchesBetween(source, candidate);
    const exactGeometry = classifyGeometry(deltas, { controlTolerance: 1 }) === "pass";
    const exactStyles = Boolean(styles) && Object.values(styles).every(Boolean);
    if (!exactGeometry || !exactStyles) return;
    used.add(candidateIndex);
    results[sourceIndex] = {
      matchedBy: "structure",
      confidence: "structural",
      status: "measured",
      cloneIndex: candidateIndex,
      score: 1,
    };
  });

  sourceSections.forEach((source, sourceIndex) => {
    if (results[sourceIndex]) return;
    let best = { score: 0, matchedBy: null, cloneIndex: -1 };
    cloneSections.forEach((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return;
      const scored = scorePair(source, candidate, sourceIndex, candidateIndex);
      if (scored.score > best.score) best = { ...scored, cloneIndex: candidateIndex };
    });
    if (best.score >= 0.7 && best.cloneIndex >= 0) {
      used.add(best.cloneIndex);
      results[sourceIndex] = {
        matchedBy: best.matchedBy || "semantic",
        confidence: best.score >= 0.9 ? "high" : "review",
        status: "review",
        cloneIndex: best.cloneIndex,
        score: Number(best.score.toFixed(2)),
      };
    }
  });

  sourceSections.forEach((source, sourceIndex) => {
    if (results[sourceIndex]) return;
    const candidateIndex = sourceIndex < cloneSections.length && !used.has(sourceIndex) ? sourceIndex : -1;
    results[sourceIndex] = candidateIndex >= 0
      ? { matchedBy: "index", confidence: "review", status: "review", cloneIndex: candidateIndex, score: 0.5 }
      : { matchedBy: "missing", confidence: "missing", status: "fail", cloneIndex: -1, score: 0 };
    if (candidateIndex >= 0) used.add(candidateIndex);
  });

  return sourceSections.map((source, sourceIndex) => {
    const match = results[sourceIndex];
    const candidate = match.cloneIndex >= 0 ? cloneSections[match.cloneIndex] : null;
    return {
      source: source?.selector || source?.id || `section-${sourceIndex}`,
      sourceIndex,
      cloneIndex: match.cloneIndex,
      matchedBy: match.matchedBy,
      confidence: match.confidence,
      status: match.status,
      score: match.score,
      ...(candidate ? { deltas: deltasBetween(source, candidate), styleMatches: styleMatchesBetween(source, candidate) } : {}),
    };
  });
}

export function classifyGeometry(deltas = {}, { controlTolerance = 1, sectionTolerance = 2 } = {}) {
  const max = Math.max(...["x", "y", "width", "height"].map((key) => Math.abs(Number(deltas[key]) || 0)));
  if (max <= controlTolerance) return "pass";
  if (max <= sectionTolerance) return "review";
  return "fail";
}
