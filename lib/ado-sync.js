/**
 * ADO Sync Module
 *
 * Fetches live Bug work items from Azure DevOps (DCOD-Upgrade / Upgrade Operations)
 * and writes the transformed data to data/jira-defects.json.
 *
 * Auth priority:
 *   1. ADO_PAT in .env  (Personal Access Token — recommended for unattended runs)
 *   2. Azure CLI bearer token via `az account get-access-token` (fallback, expires hourly)
 *
 * Required .env:
 *   ADO_PAT   — PAT with Work Items (Read) scope for dev.azure.com/DCOD-Upgrade
 *               Generate at: dev.azure.com/DCOD-Upgrade → User Settings → Personal access tokens
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE  = join(__dirname, "../data/jira-defects.json");

const ADO_ORG     = "https://dev.azure.com/DCOD-Upgrade";
const ADO_PROJECT = "Upgrade Operations";
const BATCH_SIZE  = 200; // ADO batch API limit

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthHeader() {
  // 1. PAT — most reliable for scheduled runs
  if (process.env.ADO_PAT) {
    const encoded = Buffer.from(`:${process.env.ADO_PAT}`).toString("base64");
    return `Basic ${encoded}`;
  }

  // 2. Azure CLI bearer token (works if `az login` session is still valid)
  try {
    const token = execSync(
      "az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv",
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (token) return `Bearer ${token}`;
  } catch {
    // az CLI not available or session expired
  }

  throw new Error("No ADO auth available. Set ADO_PAT in .env or run `az login`.");
}

// ─── Field transformers ───────────────────────────────────────────────────────

function mapState(adoState) {
  const s = (adoState || "").toLowerCase();
  if (["new", "active", "more info reqd", "more info required"].includes(s)) return "Open";
  if (["closed", "resolved", "done"].includes(s)) return "Resolved";
  if (s === "deferred") return "Deferred";
  if (s === "in progress") return "In Progress";
  return "Open";
}

function mapSeverity(adoSeverity) {
  if (!adoSeverity) return "Medium";
  if (adoSeverity.startsWith("1")) return "Critical";
  if (adoSeverity.startsWith("2")) return "High";
  if (adoSeverity.startsWith("3")) return "Medium";
  if (adoSeverity.startsWith("4")) return "Low";
  return "Medium";
}

function lastSegment(areaPath) {
  if (!areaPath) return "Loss Control";
  const parts = areaPath.split("\\");
  return parts[parts.length - 1] || "Loss Control";
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const IGNORE_VALUES = new Set(["Not an issue", "Not applicable", "Not Reproducible", "Existing Issue"]);

function cleanCustomField(val) {
  if (!val || IGNORE_VALUES.has(val)) return null;
  return val;
}

function transformWorkItem(wi) {
  const f = wi.fields;
  const id = wi.id;

  const createdDate  = f["System.CreatedDate"]  ? f["System.CreatedDate"].slice(0, 10)  : null;
  const resolvedDate = f["Microsoft.VSTS.Common.ResolvedDate"]
    ? f["Microsoft.VSTS.Common.ResolvedDate"].slice(0, 10)
    : (f["Microsoft.VSTS.Common.ClosedDate"] ? f["Microsoft.VSTS.Common.ClosedDate"].slice(0, 10) : null);

  const rawTags = f["System.Tags"] || "";
  const labels  = rawTags.split(";").map(t => t.trim()).filter(Boolean);

  const resolutionRaw = stripHtml(f["Custom.Commentstofix"] || "");
  const resolution    = resolutionRaw.length > 5 && resolutionRaw.toLowerCase() !== "not an issue"
    ? resolutionRaw : null;

  return {
    id,
    key:                 `LC-${id}`,
    summary:             f["System.Title"] || "",
    description:         stripHtml(f["System.Description"] || ""),
    status:              mapState(f["System.State"]),
    priority:            mapSeverity(f["Microsoft.VSTS.Common.Severity"]),
    component:           lastSegment(f["System.AreaPath"]),
    reporter:            f["System.CreatedBy"]?.displayName  || null,
    assignee:            f["System.AssignedTo"]?.displayName || null,
    created:             createdDate,
    resolved:            resolvedDate,
    reopened:            false,
    labels,
    comments:            [],
    issue_type:          cleanCustomField(f["Custom.IssueType"]),
    fix_type:            cleanCustomField(f["Custom.FixType"]),
    rca_category:        cleanCustomField(f["Custom.RCA"]),
    resolution_comments: resolution,
  };
}

// ─── ADO API helpers ──────────────────────────────────────────────────────────

async function wiqlQuery(authHeader, query) {
  const url = `${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_apis/wit/wiql?api-version=7.1`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`WIQL query failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function fetchBatch(authHeader, ids) {
  const fields = [
    "System.Id",
    "System.Title",
    "System.Description",
    "System.State",
    "System.AreaPath",
    "System.CreatedDate",
    "System.CreatedBy",
    "System.AssignedTo",
    "System.Tags",
    "Microsoft.VSTS.Common.Severity",
    "Microsoft.VSTS.Common.ResolvedDate",
    "Microsoft.VSTS.Common.ClosedDate",
    "Custom.IssueType",
    "Custom.FixType",
    "Custom.RCA",
    "Custom.Commentstofix",
  ].join(",");

  const url = `${ADO_ORG}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields}&api-version=7.1`;
  const resp = await fetch(url, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`Batch fetch failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.value || [];
}

// ─── Main sync function ───────────────────────────────────────────────────────

/**
 * Run a full ADO sync.
 * Fetches all Bug work items created in the last 12 months,
 * transforms them, and writes to data/jira-defects.json.
 *
 * @returns {Promise<object>} sync result stats
 */
export async function runSync() {
  const startedAt = new Date().toISOString();
  console.log(`[ADO Sync] Starting at ${startedAt}`);

  const authHeader = await getAuthHeader();

  // ── 1. WIQL: get all Bug IDs from last 12 months ─────────────────────────
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const wiqlResult = await wiqlQuery(
    authHeader,
    `SELECT [System.Id] FROM WorkItems
     WHERE [System.WorkItemType] = 'Bug'
       AND [System.AreaPath] UNDER 'Loss Control'
       AND [System.CreatedDate] >= '${cutoffStr}'
     ORDER BY [System.CreatedDate] DESC`
  );

  const allIds = (wiqlResult.workItems || []).map(w => w.id);
  console.log(`[ADO Sync] WIQL returned ${allIds.length} IDs (since ${cutoffStr})`);

  if (allIds.length === 0) {
    return { ok: true, started_at: startedAt, defects_fetched: 0, message: "No work items found" };
  }

  // ── 2. Batch fetch all work items (200 per request) ───────────────────────
  const rawItems = [];
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    console.log(`[ADO Sync] Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allIds.length / BATCH_SIZE)} (${batch.length} items)`);
    const items = await fetchBatch(authHeader, batch);
    rawItems.push(...items);
  }

  // ── 3. Transform ──────────────────────────────────────────────────────────
  const defects = rawItems.map(transformWorkItem);
  console.log(`[ADO Sync] Transformed ${defects.length} defects`);

  // ── 4. Write to data file ─────────────────────────────────────────────────
  writeFileSync(DATA_FILE, JSON.stringify(defects, null, 2));
  console.log(`[ADO Sync] Written to ${DATA_FILE}`);

  const completedAt = new Date().toISOString();

  const stats = {
    ok:              true,
    started_at:      startedAt,
    completed_at:    completedAt,
    defects_fetched: defects.length,
    cutoff_date:     cutoffStr,
    by_status: {
      Open:        defects.filter(d => d.status === "Open").length,
      "In Progress": defects.filter(d => d.status === "In Progress").length,
      Resolved:    defects.filter(d => d.status === "Resolved").length,
      Deferred:    defects.filter(d => d.status === "Deferred").length,
    },
    with_resolution_comments: defects.filter(d => d.resolution_comments).length,
    with_rca_category:        defects.filter(d => d.rca_category).length,
  };

  console.log("[ADO Sync] Complete:", JSON.stringify(stats));
  return stats;
}

// ─── Scheduler (weekly Monday) ────────────────────────────────────────────────

let _lastSyncResult = null;
let _lastSyncDate   = null;  // "YYYY-MM-DD" string
let _syncInProgress = false;

export function getLastSyncStatus() {
  return {
    last_sync_date:   _lastSyncDate,
    last_sync_result: _lastSyncResult,
    sync_in_progress: _syncInProgress,
    next_sync:        nextMondayISO(),
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nextMondayISO() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMonday);
  d.setHours(6, 0, 0, 0); // 06:00 AM server time
  return d.toISOString();
}

/**
 * Trigger a sync, update in-memory state via the provided callback,
 * and record the result.
 */
export async function triggerSync(onComplete) {
  if (_syncInProgress) {
    console.log("[ADO Sync] Sync already in progress — skipping");
    return { ok: false, message: "Sync already in progress" };
  }

  _syncInProgress = true;
  try {
    const result = await runSync();
    _lastSyncResult = result;
    _lastSyncDate   = todayISO();
    if (onComplete) onComplete(result);
    return result;
  } catch (err) {
    const errorResult = { ok: false, error: err.message, started_at: new Date().toISOString() };
    _lastSyncResult = errorResult;
    console.error("[ADO Sync] Sync failed:", err.message);
    return errorResult;
  } finally {
    _syncInProgress = false;
  }
}

/**
 * Start the weekly Monday scheduler.
 * Checks every hour: if today is Monday and we haven't synced today, trigger sync.
 *
 * @param {function} onComplete - callback called with sync result after each successful sync
 */
export function startWeeklyScheduler(onComplete) {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

  function check() {
    const now  = new Date();
    const today = todayISO();
    const isMonday = now.getDay() === 1;

    if (isMonday && _lastSyncDate !== today) {
      console.log(`[ADO Sync] It's Monday ${today} — starting scheduled weekly sync`);
      triggerSync(onComplete);
    }
  }

  // Check immediately on startup (catches Monday restarts)
  check();

  // Then check every hour
  const interval = setInterval(check, CHECK_INTERVAL_MS);

  console.log(`[ADO Sync] Weekly scheduler started. Next Monday sync: ${nextMondayISO()}`);
  return interval; // return so caller can clearInterval if needed
}
