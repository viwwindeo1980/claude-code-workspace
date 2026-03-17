import { readFileSync, writeFileSync } from "fs";

const defects = JSON.parse(readFileSync("data/jira-defects.json", "utf8"));
const ado = JSON.parse(readFileSync("data/ado_custom_fields.json", "utf8"));

// Build lookup by ADO id
const lookup = {};
ado.value.forEach(item => {
  lookup[item.id] = item.fields;
});

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Ignore non-meaningful values
const IGNORE = new Set(["Not an issue", "Not applicable", "Not Reproducible", "Existing Issue"]);

let enriched = 0;
defects.forEach(d => {
  const f = lookup[d.id];
  if (f) {
    d.issue_type = f["Custom.IssueType"] && !IGNORE.has(f["Custom.IssueType"]) ? f["Custom.IssueType"] : null;
    d.fix_type = f["Custom.FixType"] && !IGNORE.has(f["Custom.FixType"]) ? f["Custom.FixType"] : null;
    d.rca_category = f["Custom.RCA"] && !IGNORE.has(f["Custom.RCA"]) ? f["Custom.RCA"] : null;
    const raw = stripHtml(f["Custom.Commentstofix"] || "");
    d.resolution_comments = raw.length > 5 && raw.toLowerCase() !== "not an issue" ? raw : null;
    enriched++;
  } else {
    d.issue_type = null;
    d.fix_type = null;
    d.rca_category = null;
    d.resolution_comments = null;
  }
});

writeFileSync("data/jira-defects.json", JSON.stringify(defects, null, 2));

// Stats
const withComments = defects.filter(d => d.resolution_comments).length;
const withRca = defects.filter(d => d.rca_category).length;
const withFix = defects.filter(d => d.fix_type).length;
console.log(`Enriched ${enriched}/${defects.length} defects`);
console.log(`  resolution_comments: ${withComments}`);
console.log(`  rca_category: ${withRca}`);
console.log(`  fix_type: ${withFix}`);

// Sample
const sample = defects.find(d => d.resolution_comments && d.rca_category);
if (sample) {
  console.log("\nSample enriched defect:");
  console.log(`  ${sample.key}: ${sample.summary}`);
  console.log(`  issue_type: ${sample.issue_type}`);
  console.log(`  fix_type: ${sample.fix_type}`);
  console.log(`  rca_category: ${sample.rca_category}`);
  console.log(`  resolution_comments: ${sample.resolution_comments}`);
}
