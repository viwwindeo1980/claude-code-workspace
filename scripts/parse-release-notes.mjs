/**
 * Release Notes Parser
 *
 * Reads saved HTML pages from data/release-notes/ (saved from Duck Creek Solution Centre)
 * and produces data/release-notes.json — a structured JSON array of all releases.
 *
 * Usage:
 *   node scripts/parse-release-notes.mjs
 *
 * Re-run whenever new HTML files are added to data/release-notes/.
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(__dirname, "../data/release-notes");
const OUT_FILE  = join(__dirname, "../data/release-notes.json");

// ─── HTML utilities ────────────────────────────────────────────────────────────

function stripTags(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function nullIfNA(val) {
  if (!val) return null;
  const v = val.trim();
  if (v === "N/A" || v === "n/a" || v === "-" || v === "") return null;
  return v;
}

// ─── Section extractor ─────────────────────────────────────────────────────────

/**
 * Return HTML content from the <span id="sectionId"> up to the next sibling section
 * boundary (</div><div) or end of content.
 */
function extractSectionHtml(html, sectionId) {
  const marker = `id="${sectionId}"`;
  const pos = html.indexOf(marker);
  if (pos === -1) return null;

  // Find section end: either next sibling section or end of content block
  const end = html.indexOf("</div><div", pos);
  return end !== -1 ? html.slice(pos, end) : html.slice(pos, html.indexOf("</section>", pos) || html.length);
}

/**
 * Extract the first <table>…</table> after a given span id.
 */
function extractSectionTable(html, sectionId) {
  const section = extractSectionHtml(html, sectionId);
  if (!section) return null;
  const tableStart = section.indexOf("<table");
  if (tableStart === -1) return null;
  const tableEnd = section.indexOf("</table>", tableStart);
  if (tableEnd === -1) return null;
  return section.slice(tableStart, tableEnd + 8);
}

// ─── Table parser ──────────────────────────────────────────────────────────────

const HEADER_WORDS = ["id", "customer ticket", "scenario", "root cause", "resolution",
                      "description", "documentation", "improvement", "enhancement"];

/**
 * Parse a docTable into structured rows.
 * Product sub-headers (Classic / RiskHub) are detected from colspan rows.
 */
function parseDocTable(tableHtml, columnDefs) {
  const items = [];
  let currentProduct = null;

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRe.exec(tableHtml)) !== null) {
    const rowHtml = trMatch[1];

    // Detect product sub-header row: <th colspan="N">Classic</th>
    const colspanMatch = rowHtml.match(/<th[^>]+colspan[^>]*>([\s\S]*?)<\/th>/i);
    if (colspanMatch) {
      const text = stripTags(colspanMatch[1]).trim();
      const isColumnHeader = HEADER_WORDS.some(h => text.toLowerCase().startsWith(h));
      if (!isColumnHeader && text) currentProduct = text;
      continue;
    }

    // Parse data cells
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdm;
    while ((tdm = tdRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(tdm[1]));
    }

    if (cells.length >= columnDefs.length) {
      const item = { product: currentProduct || "Classic" };
      columnDefs.forEach((col, i) => {
        item[col] = nullIfNA(cells[i]);
      });
      items.push(item);
    }
  }

  return items;
}

// ─── List extractor (for Enhancements/bullet sections) ────────────────────────

function extractBulletList(html, sectionId) {
  const section = extractSectionHtml(html, sectionId);
  if (!section) return [];
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(section)) !== null) {
    const text = stripTags(m[1]).trim();
    if (text) items.push(text);
  }
  return items;
}

// ─── Overview table ────────────────────────────────────────────────────────────

function parseOverview(html) {
  const section = extractSectionHtml(html, "Overview");
  if (!section) return {};

  const result = {};
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(section)) !== null) {
    const rowHtml = m[1];
    const thMatch = rowHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const tdMatch = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (thMatch && tdMatch) {
      const key = stripTags(thMatch[1]).trim().toLowerCase().replace(/\s+/g, "_");
      const val = stripTags(tdMatch[1]).trim();
      result[key] = val;
    }
  }
  return result;
}

// ─── Known issues ──────────────────────────────────────────────────────────────

function parseKnownIssues(html) {
  // Try table first, fall back to list
  const tableHtml = extractSectionTable(html, "Known_issues")
                 || extractSectionTable(html, "Known_Issues");
  if (tableHtml) {
    return parseDocTable(tableHtml, ["id", "customer_ticket", "description"]);
  }
  const listItems = extractBulletList(html, "Known_issues")
                 || extractBulletList(html, "Known_Issues");
  return (listItems || []).map(text => ({ description: text, product: null }));
}

// ─── Per-file parser ───────────────────────────────────────────────────────────

function parseReleaseNote(htmlFile) {
  const html = readFileSync(htmlFile, "utf8");
  const fname = basename(htmlFile);

  // Version and date from filename: "5.2.0.1 - January 15, 2026"
  const versionMatch = fname.match(/(\d+\.\d+[\d.]*)\s*-/);
  const dateMatch    = fname.match(/\d+\.\d+[\d.]*\s*-\s*([A-Za-z]+ \d+,\s*\d{4})/);

  const version          = versionMatch?.[1] || null;
  const releaseDateStr   = dateMatch?.[1]?.trim() || null;
  const releaseDate      = releaseDateStr ? new Date(releaseDateStr).toISOString().slice(0, 10) : null;

  // Overview metadata
  const overview = parseOverview(html);

  // Enhancements (bullet list)
  const enhancements = extractBulletList(html, "Enhancements");

  // Improvements (table with ID / Customer Ticket / Description / Documentation)
  const improvementsTable = extractSectionTable(html, "Improvements");
  const improvements = improvementsTable
    ? parseDocTable(improvementsTable, ["id", "customer_ticket", "description", "documentation"])
    : [];

  // New features (some releases use this label instead of Enhancements)
  const newFeaturesTable = extractSectionTable(html, "New_features");
  const newFeatures = newFeaturesTable
    ? parseDocTable(newFeaturesTable, ["id", "customer_ticket", "description", "documentation"])
    : [];

  // Resolved issues — try both casing variants used across releases
  const resolvedTable = extractSectionTable(html, "Resolved_issues")
                     || extractSectionTable(html, "Resolved_Issues");
  const resolvedIssues = resolvedTable
    ? parseDocTable(resolvedTable, ["id", "customer_ticket", "scenario", "root_cause", "resolution"])
    : [];

  // Known issues — try both casing variants
  const knownIssues = parseKnownIssues(html);

  // Enhancements nested inside sub-sections (e.g. v5.2 has Implementation_of_* sections)
  // Collect all <h4> sub-enhancement titles as additional enhancement entries
  if (enhancements.length === 0) {
    const enhSection = extractSectionHtml(html, "Enhancements");
    if (enhSection) {
      const h4Re = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
      let m;
      while ((m = h4Re.exec(enhSection)) !== null) {
        const text = stripTags(m[1]).trim();
        if (text) enhancements.push(text);
      }
    }
  }

  return {
    version,
    release_date:         releaseDate,
    release_date_display: releaseDateStr,
    platform:             "Loss Control (Classic and RiskHub)",
    overview_stats: {
      improvements:    overview["improvements"]    || null,
      resolved_issues: overview["resolved_issues"] || null,
    },
    enhancements,
    improvements,
    new_features: newFeatures,
    resolved_issues: resolvedIssues,
    known_issues: knownIssues,
    // Summary counts
    counts: {
      enhancements:    enhancements.length,
      improvements:    improvements.length + newFeatures.length,
      resolved_issues: resolvedIssues.length,
      known_issues:    knownIssues.length,
    },
    source_file: fname,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const htmlFiles = readdirSync(NOTES_DIR)
  .filter(f => f.endsWith(".html"))
  .map(f => join(NOTES_DIR, f));

console.log(`[Parse] Found ${htmlFiles.length} release note HTML files\n`);

const releases = htmlFiles
  .map(f => {
    console.log(`  Parsing: ${basename(f)}`);
    try {
      const r = parseReleaseNote(f);
      console.log(`    → v${r.version} | enhancements: ${r.counts.enhancements} | improvements: ${r.counts.improvements} | resolved: ${r.counts.resolved_issues} | known: ${r.counts.known_issues}`);
      return r;
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => {
    // Sort by version descending (most recent first)
    const va = (a.version || "0").split(".").map(Number);
    const vb = (b.version || "0").split(".").map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const diff = (vb[i] || 0) - (va[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

writeFileSync(OUT_FILE, JSON.stringify(releases, null, 2));

const totalResolved = releases.reduce((s, r) => s + r.counts.resolved_issues, 0);
const totalImprovements = releases.reduce((s, r) => s + r.counts.improvements, 0);

console.log(`\n[Parse] Done — ${releases.length} releases written to ${OUT_FILE}`);
console.log(`[Parse] Total: ${totalResolved} resolved issues, ${totalImprovements} improvements across all releases`);
