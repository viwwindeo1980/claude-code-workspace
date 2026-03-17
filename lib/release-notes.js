/**
 * Release Notes Knowledge Module
 *
 * Loads data/release-notes.json (produced by scripts/parse-release-notes.mjs)
 * and provides:
 *   - findMatchingIssues(defects)      — finds release note entries related to a defect cluster
 *   - buildReleaseNotesContext(cluster, defects) — formatted context string for RCA prompts
 *   - getReleaseNotesSummary()         — stats for the API status endpoint
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE  = join(__dirname, "../data/release-notes.json");

// ─── Load release notes ────────────────────────────────────────────────────────

let _releases = null;

function getReleases() {
  if (_releases) return _releases;
  if (!existsSync(DATA_FILE)) {
    console.warn("[ReleaseNotes] data/release-notes.json not found — run scripts/parse-release-notes.mjs");
    return [];
  }
  try {
    _releases = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    const total = _releases.reduce((s, r) => s + r.counts.resolved_issues, 0);
    console.log(`[ReleaseNotes] Loaded ${_releases.length} releases, ${total} resolved issues`);
  } catch (err) {
    console.error("[ReleaseNotes] Failed to load:", err.message);
    _releases = [];
  }
  return _releases;
}

// ─── Stopwords for keyword matching ───────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "is", "was", "were", "to", "for", "in", "on", "at", "of",
  "and", "or", "that", "this", "when", "with", "which", "from", "by", "be",
  "been", "has", "have", "had", "not", "are", "its", "it", "as", "would",
  "could", "should", "also", "than", "then", "some", "there", "their",
  "into", "after", "before", "while", "but", "if", "more", "all",
  "user", "users", "issue", "issues", "problem", "error", "field", "fields",
  "page", "screen", "button", "value", "values", "data", "form", "forms",
  "system", "application", "now", "new", "will", "can", "does", "did",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w));
}

// ─── Match finder ──────────────────────────────────────────────────────────────

/**
 * Find release note entries (resolved issues + improvements) that are related
 * to the given defect cluster.
 *
 * Match strategies (in priority order):
 *   1. Direct ID match — defect text mentions a release note issue ID
 *   2. Customer ticket match — release note customer_ticket matches a ZEN ref in defects
 *   3. Keyword overlap — scenario text shares significant terms with cluster summary
 *
 * @param {object[]} defects - cluster member defects
 * @returns {Array<{release, entry, matchType, score}>} sorted by relevance
 */
export function findMatchingIssues(defects) {
  const releases = getReleases();
  if (!releases.length || !defects?.length) return [];

  // Build search corpus from defect text
  const corpus = defects
    .map(d => [d.summary, d.description, d.resolution_comments].filter(Boolean).join(" "))
    .join(" ");
  const corpusLower = corpus.toLowerCase();
  const corpusTokens = new Set(tokenize(corpus));

  const matches = [];

  for (const release of releases) {
    const allEntries = [
      ...release.resolved_issues.map(e => ({ ...e, entry_type: "resolved" })),
      ...release.improvements.map(e => ({ ...e, entry_type: "improvement" })),
      ...release.new_features.map(e => ({ ...e, entry_type: "new_feature" })),
    ];

    for (const entry of allEntries) {
      // 1. Direct issue ID match
      if (entry.id && corpusLower.includes(entry.id)) {
        matches.push({ release, entry, matchType: "id", score: 1.0 });
        continue;
      }

      // 2. Customer ticket match (ZenDesk ticket ref overlap)
      if (entry.customer_ticket && corpusLower.includes(entry.customer_ticket)) {
        matches.push({ release, entry, matchType: "customer_ticket", score: 0.9 });
        continue;
      }

      // 3. Keyword overlap on scenario / description
      const entryText = [
        entry.scenario || "",
        entry.description || "",
        entry.root_cause || "",
      ].join(" ");
      const entryTokenSet = new Set(tokenize(entryText));
      if (entryTokenSet.size < 3) continue;

      const matched = [...entryTokenSet].filter(w => corpusTokens.has(w));
      // Score = matched / min(corpus size, entry size) — symmetric precision
      const denominator = Math.min(corpusTokens.size, entryTokenSet.size, 10);
      const score = matched.length / Math.max(denominator, 1);

      if (score >= 0.3 && matched.length >= 2) {
        matches.push({ release, entry, matchType: "keyword", score, matchedWords: matched.slice(0, 6) });
      }
    }
  }

  // Deduplicate by entry id + release version, keep highest score
  const seen = new Map();
  for (const m of matches) {
    const key = `${m.release.version}::${m.entry.id || m.entry.description?.slice(0, 40)}`;
    if (!seen.has(key) || seen.get(key).score < m.score) seen.set(key, m);
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

// ─── Context builder ───────────────────────────────────────────────────────────

/**
 * Build a formatted release notes context string for injection into the RCA prompt.
 *
 * @param {object} cluster
 * @param {object[]} defects
 * @returns {string|null}
 */
export function buildReleaseNotesContext(cluster, defects) {
  const matches = findMatchingIssues(defects);
  if (!matches.length) return null;

  const lines = [
    "=== LOSS CONTROL RELEASE NOTES — RELATED FIXES ===",
    "The following officially documented issues and fixes from Duck Creek Loss Control release notes",
    "are related to this defect cluster. Use the Root Cause and Resolution fields as ground truth",
    "for your analysis — they reflect what Duck Creek engineering identified and fixed.",
    "",
  ];

  let lastVersion = null;

  for (const { release, entry, matchType, matchedWords } of matches) {
    // Group under version header
    if (release.version !== lastVersion) {
      lines.push(`Release v${release.version} (${release.release_date_display}) — ${release.platform}`);
      lastVersion = release.version;
    }

    const tag = entry.entry_type === "resolved" ? "RESOLVED ISSUE" : "IMPROVEMENT";
    const idStr = entry.id ? `#${entry.id}` : "";
    const ticketStr = entry.customer_ticket ? ` | Customer Ticket: ${entry.customer_ticket}` : "";
    const productStr = entry.product ? ` [${entry.product}]` : "";
    const matchNote = matchType === "keyword" ? ` (keyword match: ${(matchedWords || []).join(", ")})` : "";

    lines.push(`  ${tag} ${idStr}${ticketStr}${productStr}${matchNote}`);

    if (entry.scenario)     lines.push(`    Scenario   : ${entry.scenario}`);
    if (entry.root_cause)   lines.push(`    Root Cause : ${entry.root_cause}`);
    if (entry.resolution)   lines.push(`    Resolution : ${entry.resolution}`);
    if (entry.description && !entry.scenario) lines.push(`    Description: ${entry.description}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Summary for API ───────────────────────────────────────────────────────────

export function getReleaseNotesSummary() {
  const releases = getReleases();
  return {
    loaded:           releases.length > 0,
    releases_count:   releases.length,
    versions:         releases.map(r => r.version),
    date_range:       releases.length
      ? { oldest: releases[releases.length - 1].release_date, newest: releases[0].release_date }
      : null,
    total_counts: {
      resolved_issues: releases.reduce((s, r) => s + r.counts.resolved_issues, 0),
      improvements:    releases.reduce((s, r) => s + r.counts.improvements, 0),
      enhancements:    releases.reduce((s, r) => s + r.counts.enhancements, 0),
    },
  };
}

// ─── All releases (for API endpoint) ──────────────────────────────────────────

export function getAllReleases() {
  return getReleases();
}
