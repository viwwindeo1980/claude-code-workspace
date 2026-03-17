/**
 * ZenDesk Integration Module
 *
 * Fetches ZenDesk ticket context for defects that reference ZEN-XXXX IDs.
 * Supports both API token auth and password auth (whichever is configured).
 *
 * Required .env variables:
 *   ZENDESK_SUBDOMAIN  — e.g. "riskcontroltech"
 *   ZENDESK_EMAIL      — e.g. "vinod.ramesh.deo@duckcreek.com"
 *
 * One of the following (API token preferred):
 *   ZENDESK_API_TOKEN  — Generated in ZenDesk Admin → Apps & Integrations → APIs → Zendesk API
 *   ZENDESK_PASSWORD   — Account password (only works if password auth enabled in ZenDesk)
 */

// ─── Auth header builder ──────────────────────────────────────────────────────

function buildAuthHeader() {
  const email    = process.env.ZENDESK_EMAIL;
  const token    = process.env.ZENDESK_API_TOKEN;
  const password = process.env.ZENDESK_PASSWORD;

  if (!email) return null;

  if (token) {
    // API token auth: email/token:api_token
    return "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64");
  }
  if (password) {
    // Password auth: email:password (requires password auth enabled in ZenDesk)
    return "Basic " + Buffer.from(`${email}:${password}`).toString("base64");
  }
  return null;
}

// ─── ZenDesk availability check ──────────────────────────────────────────────

export function isZenDeskConfigured() {
  return !!(
    process.env.ZENDESK_SUBDOMAIN &&
    process.env.ZENDESK_EMAIL &&
    (process.env.ZENDESK_API_TOKEN || process.env.ZENDESK_PASSWORD)
  );
}

// ─── Ticket ID extraction ─────────────────────────────────────────────────────

/**
 * Extract all ZenDesk ticket IDs from text.
 * Matches: ZEN-1234, ZD-1234, zendesk.com/...tickets/1234, ticket #1234
 */
export function extractZenDeskIds(text) {
  if (!text) return [];
  const ids = new Set();

  // ZEN-NNNN or ZD-NNNN
  const zenPattern = /\b(?:ZEN|ZD)-(\d+)\b/gi;
  for (const m of text.matchAll(zenPattern)) ids.add(m[1]);

  // zendesk.com URL: /tickets/NNNN or /agent/tickets/NNNN
  const urlPattern = /zendesk\.com\/(?:agent\/)?tickets\/(\d+)/gi;
  for (const m of text.matchAll(urlPattern)) ids.add(m[1]);

  return [...ids];
}

/**
 * Collect all ZenDesk IDs referenced across a list of defects
 * (summary + description + resolution_comments).
 */
export function collectZenDeskIds(defects) {
  const map = new Map(); // ticketId → [defect keys that reference it]
  for (const d of defects) {
    const text = [d.summary, d.description, d.resolution_comments].filter(Boolean).join(" ");
    const ids = extractZenDeskIds(text);
    for (const id of ids) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(d.key);
    }
  }
  return map; // Map<ticketId, adoKeys[]>
}

// ─── ZenDesk API fetch ────────────────────────────────────────────────────────

const ZENDESK_CACHE = new Map(); // ticketId → ticket object (in-memory, resets on server restart)

/**
 * Fetch a single ZenDesk ticket by ID.
 * Returns a simplified ticket object or null on failure.
 */
export async function fetchTicket(ticketId) {
  if (ZENDESK_CACHE.has(ticketId)) return ZENDESK_CACHE.get(ticketId);

  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const authHeader = buildAuthHeader();
  if (!subdomain || !authHeader) return null;

  try {
    const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
    const resp = await fetch(url, {
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
    });

    if (!resp.ok) {
      console.warn(`ZenDesk ticket ${ticketId} fetch failed: ${resp.status}`);
      ZENDESK_CACHE.set(ticketId, null); // cache negative result
      return null;
    }

    const data = await resp.json();
    const t = data.ticket;

    const ticket = {
      id:          String(t.id),
      subject:     t.subject || "",
      description: t.description ? t.description.slice(0, 800) : "",
      status:      t.status || "",
      priority:    t.priority || "",
      tags:        (t.tags || []).join(", "),
      created_at:  t.created_at,
      updated_at:  t.updated_at,
      url:         `https://${subdomain}.zendesk.com/agent/tickets/${t.id}`,
    };

    ZENDESK_CACHE.set(ticketId, ticket);
    return ticket;
  } catch (err) {
    console.warn(`ZenDesk fetch error for ticket ${ticketId}:`, err.message);
    return null;
  }
}

/**
 * Fetch comments for a ZenDesk ticket to get resolution details.
 * Returns array of comment objects (public only) or [].
 */
export async function fetchTicketComments(ticketId) {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const authHeader = buildAuthHeader();
  if (!subdomain || !authHeader) return [];

  try {
    const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`;
    const resp = await fetch(url, {
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
    });

    if (!resp.ok) return [];

    const data = await resp.json();
    return (data.comments || [])
      .filter(c => c.public)
      .map(c => ({
        id:         c.id,
        body:       c.plain_body ? c.plain_body.slice(0, 600) : (c.body || "").slice(0, 600),
        created_at: c.created_at,
      }));
  } catch (err) {
    console.warn(`ZenDesk comments fetch error for ticket ${ticketId}:`, err.message);
    return [];
  }
}

// ─── Cluster-level ZenDesk context builder ───────────────────────────────────

/**
 * Build a ZenDesk context string for all tickets referenced by cluster defects.
 * Used to enrich the RCA prompt.
 *
 * @param {object[]} defects — cluster member defects
 * @returns {Promise<string|null>} formatted context string or null if none found
 */
export async function buildZenDeskContext(defects) {
  if (!isZenDeskConfigured()) return null;

  const idMap = collectZenDeskIds(defects);
  if (idMap.size === 0) return null;

  const sections = [];

  for (const [ticketId, adoKeys] of idMap) {
    const ticket = await fetchTicket(ticketId);
    if (!ticket) continue;

    const comments = await fetchTicketComments(ticketId);
    const resolutionComment = comments.length > 0
      ? comments[comments.length - 1].body  // last comment is usually resolution
      : null;

    let section = `ZenDesk Ticket ZEN-${ticketId} (referenced by ADO: ${adoKeys.join(", ")})
  Subject   : ${ticket.subject}
  Status    : ${ticket.status} | Priority: ${ticket.priority || "normal"}
  Tags      : ${ticket.tags || "none"}
  Description: ${ticket.description}`;

    if (resolutionComment) {
      section += `\n  Resolution Comment: ${resolutionComment}`;
    }

    sections.push(section);
  }

  if (sections.length === 0) return null;

  return `=== ZENDESK TICKET CONTEXT ===
The following ZenDesk tickets are linked to defects in this cluster.
Use this to understand the customer-reported context and resolution details.

${sections.join("\n\n")}`;
}

// ─── Connection test ──────────────────────────────────────────────────────────

/**
 * Test ZenDesk connectivity and auth. Returns { ok, mode, message }.
 */
export async function testConnection() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const authHeader = buildAuthHeader();

  if (!subdomain || !authHeader) {
    return { ok: false, mode: "none", message: "ZenDesk not configured in .env" };
  }

  const mode = process.env.ZENDESK_API_TOKEN ? "api-token" : "password";

  try {
    const url = `https://${subdomain}.zendesk.com/api/v2/users/me.json`;
    const resp = await fetch(url, {
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
    });

    if (!resp.ok) {
      return {
        ok: false, mode,
        message: `Auth failed (HTTP ${resp.status}). ${mode === "password"
          ? "Password auth may be disabled — generate an API token in ZenDesk Admin → Apps & Integrations → APIs → Zendesk API."
          : "Check ZENDESK_API_TOKEN value."}`,
      };
    }

    const data = await resp.json();
    const user = data.user;

    if (!user?.id) {
      return { ok: false, mode, message: "Authenticated as anonymous — credentials rejected." };
    }

    return {
      ok: true, mode,
      message: `Authenticated as ${user.name} (${user.email}), role: ${user.role}`,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  } catch (err) {
    return { ok: false, mode, message: `Network error: ${err.message}` };
  }
}
