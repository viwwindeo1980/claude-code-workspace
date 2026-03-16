// RCA Engine — uses Claude API if ANTHROPIC_API_KEY is set, else template-based

// ─── Keyword → RCA template rules ────────────────────────────────────────────

const TEMPLATES = [
  {
    keywords: ["payment", "gateway", "timeout", "billing", "transaction"],
    root_cause: {
      technical: "The PaymentGatewayClient lacks configurable timeout, retry logic, and circuit breaker patterns. A hard 30-second blocking call with no fallback causes thread exhaustion and cascading failures across the billing service.",
      process: "No formal timeout and resilience policy exists for third-party payment API integrations. There is no defined SLA for gateway response time, no alerting threshold, and no escalation process when timeouts begin occurring.",
    },
    contributing_factors: [
      "Hard-coded 30-second timeout with no environment-specific configuration",
      "No exponential backoff or retry mechanism in PaymentGatewayClient",
      "Missing circuit breaker to stop cascading failures under gateway degradation",
      "No idempotency key — retries cause duplicate billing charges",
      "Connection pool exhausted during timeout storms (pool size too small)",
      "No monitoring or alerting for payment gateway timeout rate",
    ],
    impact: {
      severity: "Critical",
      modules: ["Billing", "Payment Processing", "Policy Management"],
      description: "Insurance carriers experience failed billing transactions, customer double-charges, and service unavailability. SLA breaches reported by at least one carrier. Revenue collection affected.",
    },
    corrective_actions: [
      { action: "Add configurable timeout (10s default) and exponential backoff with 3 retries to PaymentGatewayClient", owner: "Backend Engineering", effort: "M", priority: "immediate" },
      { action: "Add idempotency key to every payment POST request to prevent duplicate charges", owner: "Backend Engineering", effort: "M", priority: "immediate" },
      { action: "Implement circuit breaker (Resilience4j or custom) to halt requests when error rate > 20%", owner: "Backend Engineering", effort: "L", priority: "immediate" },
      { action: "Fix connection leak — ensure HTTP connection is always released after timeout via try-finally", owner: "Backend Engineering", effort: "S", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Add integration tests simulating gateway latency (5s, 15s, 60s) to regression suite", type: "testing", effort: "M" },
      { action: "Add Datadog/AppInsights alert when payment_timeout_rate > 5% over 5-minute window", type: "monitoring", effort: "S" },
      { action: "Define and document resilience policy for all third-party API integrations (timeout, retry, circuit breaker standards)", type: "process", effort: "M" },
      { action: "Add offline queue (message broker) as fallback for failed payment requests", type: "code", effort: "L" },
      { action: "Move to async payment processing with webhook callback to eliminate synchronous blocking", type: "code", effort: "XL" },
    ],
  },
  {
    keywords: ["premium", "calculation", "rate", "formula", "policy", "pricing"],
    root_cause: {
      technical: "The LossControlPremiumCalc module has multiple defects: it uses integer arithmetic for intermediate division (causing decimal precision loss), does not read endorsement overrides during calculation, loads incorrect rate factor tables for some policy types, and applies tax/surcharge in the wrong order.",
      process: "Premium calculation logic changes are not subject to mandatory actuarial review before deployment. No automated regression test suite validates calculation outputs against known expected values for all policy types.",
    },
    contributing_factors: [
      "Integer arithmetic used in rate calculation — should use BigDecimal or float64",
      "Endorsement override values stored in DB but not queried during calculation",
      "Rate factor table ID hardcoded in some code paths — wrong table used for commercial auto",
      "Tax and surcharge applied in incorrect order (tax before surcharge, should be reversed)",
      "Quote-time rate table not locked — rate changes between quote and bind",
      "Experience modification factor (EMF) not retrieved for renewal calculations",
    ],
    impact: {
      severity: "Critical",
      modules: ["PolicyManagement", "Billing", "Underwriting"],
      description: "Incorrect premiums charged to policyholders and carriers. Compliance risk in TX, FL, CA due to incorrect tax order. Revenue loss from underpriced commercial auto policies (18% gap). Underwriter manual corrections required daily.",
    },
    corrective_actions: [
      { action: "Replace integer arithmetic with BigDecimal (Java) / Decimal (JS) in all rate calculation methods", owner: "PolicyManagement Team", effort: "M", priority: "immediate" },
      { action: "Fix PolicyPremiumService.calculate() to query active endorsement overrides before applying base rates", owner: "PolicyManagement Team", effort: "S", priority: "immediate" },
      { action: "Fix rate factor table lookup to use correct table ID per policy type (replace hardcoded 101 with dynamic lookup)", owner: "PolicyManagement Team", effort: "S", priority: "immediate" },
      { action: "Fix tax/surcharge application order to comply with state regulations (surcharge first, then tax)", owner: "PolicyManagement Team", effort: "S", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Build premium calculation regression test suite with known input/output pairs for all 12 policy types, validated by actuarial team", type: "testing", effort: "L" },
      { action: "Require actuarial sign-off on any change to premium calculation logic before code review", type: "process", effort: "S" },
      { action: "Lock rate table version at quote time and store rate_table_snapshot_id on quote record", type: "code", effort: "M" },
      { action: "Add calculation audit log showing every factor, multiplier, and intermediate value used for each premium calculation", type: "code", effort: "M" },
    ],
  },
  {
    keywords: ["validation", "form", "required", "field", "submit", "error", "input"],
    root_cause: {
      technical: "Form validation is implemented only on the client side (JavaScript). Server-side API endpoints in RiskAssessmentService do not independently validate required fields, allowing bypasses via direct API calls, integrations, and race conditions. Conditional field validation logic is missing.",
      process: "No validation specification document exists. The definition of required fields is maintained only in UI code comments, leading to divergence between create/edit modes and API behaviour. Automated form testing is not part of the QA process.",
    },
    contributing_factors: [
      "Server-side RiskAssessmentService.save() does not enforce required field rules",
      "Validation logic duplicated separately in create and edit form components — diverged over time",
      "Conditional required field rules (field A required when field B = X) not implemented in validator",
      "Submit button not disabled during submission — allows duplicate submissions",
      "Form state not preserved on network error — user loses all input data",
      "Date field accepts future dates — no range validation implemented",
    ],
    impact: {
      severity: "High",
      modules: ["RiskAssessment", "PolicyManagement"],
      description: "Incomplete risk assessments stored in database cause null pointer exceptions in downstream premium calculation. API validation bypass is a data integrity and security concern. User data loss on form errors reduces adoption.",
    },
    corrective_actions: [
      { action: "Implement server-side validation in RiskAssessmentService.save() mirroring all client-side required field rules", owner: "RiskAssessment Team", effort: "M", priority: "immediate" },
      { action: "Extract shared validation schema (JSON Schema or Zod) used by both frontend and backend", owner: "RiskAssessment Team", effort: "M", priority: "immediate" },
      { action: "Disable submit button during form submission and re-enable only on completion or error", owner: "Frontend Team", effort: "S", priority: "immediate" },
      { action: "Preserve form field state on network error and display actionable error message", owner: "Frontend Team", effort: "S", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Maintain a single validation specification document (owned by Product) as the source of truth for all required fields", type: "process", effort: "S" },
      { action: "Add Playwright/Cypress E2E tests for all form validation scenarios (create, edit, API direct call)", type: "testing", effort: "M" },
      { action: "Add server-side validation unit tests with 100% coverage on RiskAssessmentService.save()", type: "testing", effort: "M" },
      { action: "Implement API input validation middleware (e.g., Bean Validation / express-validator) applied to all endpoints", type: "code", effort: "M" },
    ],
  },
  {
    keywords: ["report", "performance", "slow", "generation", "pdf", "memory", "query", "export"],
    root_cause: {
      technical: "Report generation has multiple performance bottlenecks: N+1 database queries per policy record, missing indexes on date columns (causing full table scans on 2M rows), in-memory loading of entire result sets for PDF/Excel export, and no request queuing for concurrent report jobs.",
      process: "No performance benchmarks or SLAs are defined for report generation. Performance testing is not included in the release cycle for reporting features. Reports run against the primary database instead of a read replica.",
    },
    contributing_factors: [
      "N+1 database queries — each policy record triggers a separate claims history sub-query",
      "Missing index on POLICY_ACTIVITY.CREATED_DATE — full table scan on 2M rows",
      "In-memory result set loading for PDF/Excel — causes OOM for large reports (50MB files, 200k rows)",
      "No request queue for concurrent report generation — 5+ concurrent jobs crash the report server",
      "Report generation runs on primary DB — blocks transactional operations during peak periods",
      "No user feedback or cancel mechanism for long-running reports — spinner runs indefinitely",
    ],
    impact: {
      severity: "High",
      modules: ["Reporting", "Database", "Operations"],
      description: "Users abandon reports after 30+ seconds. Server OOM crashes affect all users. Nightly scheduled reports degrade transactional performance for 15 minutes. Management unable to get timely Loss Control insights.",
    },
    corrective_actions: [
      { action: "Add missing index on POLICY_ACTIVITY.CREATED_DATE and POLICY_ID (composite)", owner: "Database / DBA Team", effort: "S", priority: "immediate" },
      { action: "Implement streaming row-by-row export for PDF (Apache PDFBox incremental) and Excel (SXSSFWorkbook streaming)", owner: "Reporting Team", effort: "L", priority: "immediate" },
      { action: "Batch all rate/claims lookup queries — eliminate N+1 using IN clause or JOIN", owner: "Reporting Team", effort: "M", priority: "immediate" },
      { action: "Add report generation queue with max 3 concurrent jobs — queue and poll for others", owner: "Reporting Team", effort: "M", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Define performance SLA for all reports: P50 < 5s, P99 < 15s, max 200 pages in under 30s", type: "process", effort: "S" },
      { action: "Add performance test stage to CI/CD pipeline running representative report queries against staging DB", type: "testing", effort: "M" },
      { action: "Route all report generation queries to read replica (replica lag < 5 minutes acceptable)", type: "code", effort: "M" },
      { action: "Implement async report generation with background job + status polling + download link", type: "code", effort: "L" },
    ],
  },
  {
    keywords: ["session", "authentication", "token", "expire", "login", "jwt", "sso", "auth"],
    root_cause: {
      technical: "Session management has multiple defects: 30-minute idle timeout is too short for long workflows, session cookies are not server-side invalidated on logout, JWT refresh is not triggered on browser tab focus, and SSO redirect loop occurs due to state parameter mismatch. Concurrent session limits are not enforced.",
      process: "Session timeout and security configuration values are not reviewed against workflow duration requirements. Security testing does not include session lifecycle scenarios (logout, expiry, concurrent sessions).",
    },
    contributing_factors: [
      "30-minute idle timeout too short for risk assessments that take 45-60 minutes",
      "Logout endpoint invalidates cookie client-side only — server session remains valid for 24h",
      "JWT refresh not triggered when browser tab regains focus from background",
      "SSO redirect loop due to state parameter mismatch on session expiry",
      "Unlimited concurrent sessions per user — audit compliance violation",
      "No warning notification shown before session expiry",
    ],
    impact: {
      severity: "High",
      modules: ["Authentication", "RiskAssessment", "Reporting"],
      description: "Users lose unsaved risk assessment data on session expiry. Security vulnerability from non-invalidated logout sessions. Audit compliance risk from unlimited concurrent sessions. Azure AD SSO users experience login loops.",
    },
    corrective_actions: [
      { action: "Implement server-side session invalidation on logout — delete session token from Redis/session store", owner: "Authentication Team", effort: "S", priority: "immediate" },
      { action: "Show session expiry warning banner 5 minutes before expiry with 'Extend Session' button", owner: "Frontend Team", effort: "S", priority: "immediate" },
      { action: "Trigger JWT refresh on browser visibilitychange event (tab focus)", owner: "Frontend Team", effort: "S", priority: "immediate" },
      { action: "Fix SSO redirect loop by validating and preserving state parameter through IdP redirect cycle", owner: "Authentication Team", effort: "M", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Implement role-based session timeout: Viewer=30min, Analyst=60min, Assessor=90min (configurable)", type: "code", effort: "M" },
      { action: "Enforce max 2 concurrent sessions per user — invalidate oldest on third login", type: "code", effort: "M" },
      { action: "Add security test suite covering: logout invalidation, session expiry, concurrent session limits, SSO flows", type: "testing", effort: "M" },
      { action: "Use pre-signed download tokens for file downloads — independent of session state", type: "code", effort: "M" },
    ],
  },
  {
    keywords: ["import", "csv", "file", "parsing", "batch", "format", "column", "delimiter", "encoding"],
    root_cause: {
      technical: "The CSV import module uses a naive comma-split parser that does not comply with RFC 4180. It lacks: BOM stripping, case-insensitive header matching, delimiter auto-detection, quoted field handling, streaming for large files, and per-row error reporting.",
      process: "No formal data import specification exists documenting supported formats, encodings, and delimiters. Import feature acceptance criteria do not include edge cases (BOM, large files, semicolons, quoted fields). No integration tests with real carrier-exported files.",
    },
    contributing_factors: [
      "No BOM stripping — UTF-8 BOM from Excel exports breaks first column header name",
      "Case-sensitive header matching — POLICY_ID vs policy_id fails",
      "No RFC 4180 compliant CSV parsing — quoted fields with embedded commas split incorrectly",
      "Delimiter hardcoded as comma — semicolon-delimited files from European carriers fail",
      "Entire file loaded into memory — OOM for 50MB files (200k rows)",
      "Silent skip on date format mismatch — data loss without user notification",
    ],
    impact: {
      severity: "Medium",
      modules: ["DataImport", "PolicyManagement"],
      description: "Carriers and users unable to import standard Excel exports. Data loss occurs silently when rows are skipped. Large batch import files crash the import service. European carrier integrations broken by semicolon delimiter mismatch.",
    },
    corrective_actions: [
      { action: "Replace naive CSV parser with RFC 4180 compliant library (csv-parse Node.js or OpenCSV Java)", owner: "DataImport Team", effort: "M", priority: "immediate" },
      { action: "Add BOM detection and stripping at file read time before parsing", owner: "DataImport Team", effort: "S", priority: "immediate" },
      { action: "Make header matching case-insensitive (toLowerCase() comparison)", owner: "DataImport Team", effort: "S", priority: "immediate" },
      { action: "Add delimiter auto-detection (check first line for , vs ; vs \\t frequency)", owner: "DataImport Team", effort: "S", priority: "immediate" },
    ],
    preventive_actions: [
      { action: "Switch to streaming CSV parser to handle files of any size without OOM", type: "code", effort: "M" },
      { action: "Implement per-row validation with error report returned to user (line number, field, error reason)", type: "code", effort: "M" },
      { action: "Create import test suite with real carrier-exported CSV files covering: BOM, semicolons, quoted commas, uppercase headers, large files", type: "testing", effort: "M" },
      { action: "Publish formal Data Import Specification document listing supported formats, encodings, delimiters, and date formats", type: "process", effort: "S" },
    ],
  },
];

/** Find best matching template for a cluster based on keyword overlap */
function matchTemplate(keywords) {
  let best = null;
  let bestScore = 0;
  for (const tmpl of TEMPLATES) {
    const score = keywords.filter(k =>
      tmpl.keywords.some(tk => k.includes(tk) || tk.includes(k))
    ).length;
    if (score > bestScore) { bestScore = score; best = tmpl; }
  }
  // Fallback to generic template
  return best || TEMPLATES[0];
}

/** Generate a generic template RCA for unknown cluster patterns */
function genericRCA(cluster) {
  const kw = cluster.keywords.slice(0, 4).join(", ");
  return {
    root_cause: {
      technical: `Recurring defects related to [${kw}] indicate a systemic technical gap in the ${cluster.components.join("/")} module. The pattern suggests missing validation, error handling, or resilience logic in the affected code paths.`,
      process: "Defects of this type have recurred ${cluster.defect_count} times over ${cluster.day_span} days without a permanent fix, indicating insufficient root cause analysis and follow-through on corrective actions.",
    },
    contributing_factors: [
      `${cluster.defect_count} related defects identified across ${cluster.components.join(", ")} over ${cluster.day_span} days`,
      `Recurrence score: ${cluster.recurrence_score} — indicates high repeat rate`,
      "No permanent corrective action applied after initial occurrence",
      "Pattern detection was manual — delayed response to recurring issue",
    ],
    impact: {
      severity: cluster.priority_distribution?.Critical > 0 ? "Critical" : "High",
      modules: cluster.components,
      description: `Recurring defect cluster affecting ${cluster.components.join(", ")}. ${cluster.defect_count} defects logged over ${cluster.day_span} days. Reopen rate: ${Math.round(cluster.reopen_rate * 100)}%.`,
    },
    corrective_actions: [
      { action: `Conduct code review of ${cluster.components.join("/")} module to identify root cause of [${kw}] pattern`, owner: "Engineering Team", effort: "M", priority: "immediate" },
      { action: "Apply targeted fix for the identified root cause with unit test coverage", owner: "Engineering Team", effort: "M", priority: "immediate" },
    ],
    preventive_actions: [
      { action: `Add automated regression tests covering [${kw}] scenarios`, type: "testing", effort: "M" },
      { action: "Add monitoring alert for recurrence of this defect pattern", type: "monitoring", effort: "S" },
      { action: "Schedule bi-weekly defect pattern review to catch clusters before they grow", type: "process", effort: "S" },
    ],
  };
}

// ─── Shared RCA prompt ────────────────────────────────────────────────────────
function buildPrompt(cluster, sampleDefects) {
  return `You are a senior software quality engineer specializing in P&C insurance platforms (DuckCreek Loss Control).

Analyze the following defect cluster and generate a comprehensive Root Cause Analysis.

Cluster: ${cluster.label}
Defects: ${cluster.defect_count} over ${cluster.day_span} days (recurrence score: ${cluster.recurrence_score})
Components: ${cluster.components.join(", ")}
Keywords: ${cluster.keywords.join(", ")}

Sample defects:
${sampleDefects}

Generate a structured RCA with root cause (technical + process), contributing factors, business impact, corrective actions (immediate fixes with effort), and preventive actions (long-term improvements by type).`;
}

// ─── Shared tool/function schema ──────────────────────────────────────────────
const RCA_SCHEMA = {
  type: "object",
  properties: {
    root_cause: {
      type: "object",
      properties: {
        technical: { type: "string" },
        process:   { type: "string" },
      },
      required: ["technical", "process"],
    },
    contributing_factors: { type: "array", items: { type: "string" } },
    impact: {
      type: "object",
      properties: {
        severity:    { type: "string", enum: ["Critical", "High", "Medium", "Low"] },
        modules:     { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["severity", "modules", "description"],
    },
    corrective_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action:   { type: "string" },
          owner:    { type: "string" },
          effort:   { type: "string", enum: ["S", "M", "L", "XL"] },
          priority: { type: "string", enum: ["immediate", "short-term"] },
        },
        required: ["action", "owner", "effort", "priority"],
      },
    },
    preventive_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          type:   { type: "string", enum: ["code", "process", "testing", "monitoring"] },
          effort: { type: "string", enum: ["S", "M", "L", "XL"] },
        },
        required: ["action", "type", "effort"],
      },
    },
  },
  required: ["root_cause", "contributing_factors", "impact", "corrective_actions", "preventive_actions"],
};

/**
 * Generate RCA for a cluster.
 * Priority: Azure AI Foundry → Anthropic Claude → Template engine (offline)
 *
 * @param {object} cluster
 * @param {object[]} defects - member defects of the cluster
 * @returns {Promise<object>} RCA document
 */
export async function generateRCA(cluster, defects) {
  const sampleDefects = defects.slice(0, 5).map(d =>
    `[${d.key}] ${d.summary}\n${d.description.slice(0, 400)}`
  ).join("\n\n---\n\n");

  // ── Azure AI Foundry path (GPT-4o via Azure OpenAI) ───────────────────────
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    try {
      const { OpenAI } = await import("openai");
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";

      const client = new OpenAI({
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey:  process.env.AZURE_OPENAI_KEY,
      });

      const response = await client.chat.completions.create({
        model: deployment,
        temperature: 0.2,
        max_tokens: 2048,
        tools: [{
          type: "function",
          function: {
            name:        "generate_rca",
            description: "Generate a structured Root Cause Analysis document for a defect cluster",
            parameters:  RCA_SCHEMA,
          },
        }],
        tool_choice: { type: "function", function: { name: "generate_rca" } },
        messages: [{ role: "user", content: buildPrompt(cluster, sampleDefects) }],
      });

      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (toolCall?.function?.arguments) {
        const result = JSON.parse(toolCall.function.arguments);
        return {
          ...result,
          confidence_score: 0.92,
          generated_by: `azure-foundry/${deployment}`,
          generated_at: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn("Azure AI Foundry call failed, falling back to template:", err.message);
    }
  }

  // ── Anthropic Claude API path ─────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const msg = await client.messages.create({
        model:       "claude-sonnet-4-6",
        max_tokens:  2048,
        temperature: 0.2,
        tools: [{
          name:         "generate_rca",
          description:  "Generate a structured Root Cause Analysis document for a defect cluster",
          input_schema: RCA_SCHEMA,
        }],
        tool_choice: { type: "tool", name: "generate_rca" },
        messages: [{ role: "user", content: buildPrompt(cluster, sampleDefects) }],
      });

      const toolUse = msg.content.find(b => b.type === "tool_use");
      if (toolUse?.input) {
        return {
          ...toolUse.input,
          confidence_score: 0.92,
          generated_by:    "claude-sonnet-4-6",
          generated_at:    new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn("Claude API call failed, falling back to template:", err.message);
    }
  }

  // ── Template path (offline) ───────────────────────────────────────────────
  const tmpl = matchTemplate(cluster.keywords);
  const rca = tmpl
    ? {
        root_cause: tmpl.root_cause,
        contributing_factors: tmpl.contributing_factors,
        impact: {
          ...tmpl.impact,
          modules: cluster.components.length > 0 ? cluster.components : tmpl.impact.modules,
        },
        corrective_actions: tmpl.corrective_actions,
        preventive_actions: tmpl.preventive_actions,
      }
    : genericRCA(cluster);

  return {
    ...rca,
    confidence_score: 0.75,
    generated_by: "template-engine",
    generated_at: new Date().toISOString(),
  };
}
