/**
 * RCT Platform Knowledge Base
 *
 * Deep technical context derived from the RCT source repository
 * (dev.azure.com/riskcontroltech/_git/RCT). Used to ground AI-generated
 * RCA recommendations in the actual product architecture.
 */

// ─── Platform architecture overview ─────────────────────────────────────────

export const PLATFORM_OVERVIEW = `
RCT (Risk Control Technology) is a multi-tenant P&C insurance Loss Control platform.

CORE SERVICES:
- RCI  : Main web client. Custom JET/BSD proprietary framework (.NET 4.8/IIS). All UI pages are .bsd files.
         Config files: System.bsd, CustomOptions.bsd, Config_DSN.bsd, Config_SMTP.bsd.
- JAWS : Primary REST API (.NET Framework). Handles data operations, SmartForms, event publishing.
         Layers: API → Services → DAL → SQL Server. Config: ConnectionStrings.config, AppSettings.config.
- RDI  : .NET Core 3.1 REST API. Manages inspections, audit logging, batch processing.
         Uses Azure App Configuration, Key Vault, Serilog, FluentValidation, AspNetCoreRateLimit.
         Async processing via Azure Storage Queues. JWT authentication (30-min expiry, 24h refresh).
- SAWS : .NET WCF/Web API. Vendor Hub — external vendors retrieve/submit inspections.
         Config: VendorHub.config, ConnectionString.config. Requires 'shared:isenvironmentdockerized' flag.
- LetterService : .NET Framework Windows Service. Generates PDF/Word via mail merge.
         Components: RCTLetterComponent, RCTBusinessLayer, RCTPresentation, RCTEntities.
         Letter files stored at: /files/mailmerge/Letters_*/
         Called via: RCI (CallLetterService@Letters.bsd) or RDI endpoint.
- ImagingService : .NET Windows Service. Async media file imaging.
         Mounts: rci:rootPath (Azure File Share), im:outputPath (ImageRight), afs:share.
         Docker health check via ServiceHealthChecker executable.
- SSO  : .NET Service. Single Sign-On. Config: ConnectionStrings.config.
         Supports Azure AD / OAuth2 / Okta.

FRONTEND:
- RCI (JET/BSD) : Main legacy UI. 32-bit app pool. IIS-deployed.
- WebUI         : Angular 13.3, Kendo UI, MSAL Azure AD auth. Modern cloud frontend.
- NG-Injector   : Angular 8 Elements injected into RCI as web components. Uses TinyMCE.
- Mercury       : Angular 2.4 (legacy). Being replaced by WebUI.
- InsuredPortal : AngularJS 1.5.6. End-user portal. Gulp+Browserify build.
- Mobile (RCM)  : Ionic v1/AngularJS 1.5. SQLite local DB. Electron + Cordova (iOS/Android).

DATABASE:
- SQL Server. Schema managed via VSDB (.sqlproj). Extension fields: ExtFldN columns.
- Azure Table Storage: Used for default views configuration (Tasks, Accounts, Letters, Recommendations, etc.)
- Migration scripts managed in VSDB project.

JOBS:
- Evolution : .NET Console. Processes client XML imports. Plugin architecture per client.
              File mounts: /Plugins, /ImportFolders. Logs via Log4net + Application Insights.

INTEGRATIONS:
- SmartForms     : IFormEventService, IAccountEventService, ITaskEventService, ILetterEventService.
                   Handlers: Excel, E2Value, OptaSingleService. Events via Azure Event Grid.
- Guidewire      : Gradle/Java connector. GuideWire 10.1.1. Async policy data sync via Event Grid rules.
- SendGrid       : Azure Function webhook. Bounce/drop relay. Email delivery.
- Azure Services : App Configuration, Key Vault, Blob Storage, Queue Storage, Application Insights,
                   Event Grid, Azure Functions, Azure Logic Apps (per-client).

DEPLOYMENT:
- Docker (Windows Server Core base images). IIS-hosted (RCI, SAWS). nginx (WebUI).
- Octopus Deploy for variable substitution and multi-tenant deployment.
- CI/CD: Azure Pipelines (trunk, release/*, hotfix/*). Windows-2019 build agents.
- VariableSubstitutionUtility (.NET 6.0) generates environment-specific configs.
- Azure API Management layer with global policies.

AUTHENTICATION:
- Azure AD / MSAL (WebUI, RDI)
- JWT tokens in RDI (custom claims, 30-min expiry)
- Okta SSO (some clients via SSO service)
- Legacy RCT login (RCI, being phased out)

MONITORING:
- Application Insights across all services (connection string format, not instrumentation key — deprecated March 2025).
- Serilog multi-sink: AppInsights + rolling files + audit logs (/logs/AuditLogs/, 3650-day retention).
- Health endpoints: /healthcheck, /ImagingHealthCheck.

CUSTOM CLIENT FEATURES:
- 40+ insurance clients each have CustomFeatures/<ClientName>/ with:
  - Custom Evolution Plugins (XML import customizations)
  - Custom Web features (BSD overrides, manuscript SQL)
  - Azure Functions / Logic Apps (client workflows)
- Clients include: AFGroup, Farmers, BerkleyOne, Erie, SAIF, Pharmacists Mutual, Sompo, MedPro, etc.
- "Manuscript" = client-specific BSD/SQL overrides of base platform behaviour.
`;

// ─── Component → Service mapping ─────────────────────────────────────────────

/**
 * Map ADO component/area-path names to RCT services + typical failure modes.
 */
export const COMPONENT_CONTEXT = {
  "Loss Control": {
    services: ["RCI", "JAWS", "RDI"],
    description: "Core platform. Issues usually span the full RCI→JAWS→DB stack.",
    typicalFailures: [
      "BSD script errors (null reference, missing variable in .bsd files)",
      "JAWS API returning wrong data (DAL query issues, missing JOIN)",
      "Database ExtFld columns missing or wrongly mapped",
      "Session/authentication failures (Okta redirect, JWT expiry)",
    ],
  },
  "Letter / Click / Result": {
    services: ["LetterService", "RCI", "RDI"],
    description: "Letter generation and document output pipeline.",
    typicalFailures: [
      "LetterService PDF/Word generation failure (404 — missing template or wrong file share path)",
      "Mail merge field not resolved (ExtFld missing in DB or wrong binding key)",
      "Underwriter signature or contact data not transferred to letter (DB query missing column)",
      "Azure File Share mount misconfiguration (path not matching /files/mailmerge/Letters_*/)",
      "LetterService RCTLetterComponent binding error (wrong column in RCTEntities layer)",
    ],
  },
  "Pharmacists Mutual Upgrades": {
    services: ["RCI", "JAWS", "LetterService", "RDI"],
    description: "Client-specific upgrade. Custom manuscript overrides common.",
    typicalFailures: [
      "Custom manuscript override conflicting with base code after version upgrade",
      "Missing database migration script during client upgrade",
      "ExtFld columns added to base but not present in client-specific DB",
      "Recommendation due date calculation using wrong config entry in Azure Table Storage",
    ],
  },
  "AF Group Upgrades": {
    services: ["RCI", "JAWS", "LetterService"],
    description: "AF Group client upgrade track.",
    typicalFailures: [
      "PDF letter/report 404 — VSDB query change not deployed to client DB",
      "Run Report button failure — missing stored procedure or permission",
      "Base code change without corresponding manuscript re-merge",
    ],
  },
  "Sompo Upgrades": {
    services: ["RCI", "JAWS", "RDI"],
    description: "Sompo Japan insurance client upgrade.",
    typicalFailures: [
      "Recommendation due date wrong — Azure Table Storage config entry mismatch",
      "Missing database object introduced in base version not deployed to client",
    ],
  },
  "default": {
    services: ["RCI", "JAWS"],
    description: "General Loss Control platform issue.",
    typicalFailures: [
      "Database object missing (stored proc, view, ExtFld column)",
      "Config file entry missing or wrong after upgrade",
      "Manuscript override conflicting with upgraded base code",
      "File share path misconfiguration (Azure File Share vs on-prem IIS path)",
    ],
  },
};

// ─── RCA category → platform-specific root cause context ────────────────────

export const RCA_CATEGORY_CONTEXT = {
  "Database object issues": {
    technicalPattern: "SQL Server object missing or incorrect. Common causes: VSDB migration script not executed on client DB during upgrade; ExtFld column added in base schema but absent on client; stored procedure/view not re-deployed; custom manuscript SQL query referencing wrong column or table.",
    services: ["VSDB", "JAWS DAL", "RDI Infrastructure"],
    investigationSteps: [
      "Check VSDB migration scripts executed for this client version",
      "Verify ExtFld columns present on target table (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=...)",
      "Compare stored proc/view definition in VSDB against client DB object",
      "Check JAWS DAL query for column reference against actual schema",
    ],
    correctivePattern: "Execute missing migration script or CREATE/ALTER statement on client DB. Re-deploy stored procedure from VSDB. Add missing ExtFld column with default value.",
  },
  "Missing config changes/entries": {
    technicalPattern: "Configuration entry missing from Azure Table Storage (default views, system config), BSD config files (System.bsd, CustomOptions.bsd), or Octopus variable set. Newly introduced config keys in a base version upgrade were not propagated to the client deployment.",
    services: ["RCI (BSD config)", "Azure Table Storage", "Octopus Deploy", "RDI appsettings"],
    investigationSteps: [
      "Check AzureTable_DefaultViews CSV for missing row vs. deployed table",
      "Compare System.bsd / CustomOptions.bsd template against deployed config",
      "Validate Octopus variable set for client environment has new keys from this release",
      "Check RDI appsettings.json keys added in this version are present in deployment",
    ],
    correctivePattern: "Add missing row to Azure Table Storage config. Update System.bsd or CustomOptions.bsd via deployment. Add Octopus variable to client channel. Re-run Octopus deployment to refresh config.",
  },
  "Base Changes": {
    technicalPattern: "Breaking change introduced in base platform code that was not merged into or tested against client manuscript. Common in RCI (.bsd files) and JAWS API where client-specific overrides diverge from updated base behavior.",
    services: ["RCI manuscript", "JAWS", "CustomFeatures"],
    investigationSteps: [
      "Identify which base .bsd or API method changed in this version",
      "Check CustomFeatures/<Client>/Web/ for overriding .bsd files",
      "Review git diff of base vs client manuscript for the changed component",
      "Check JAWS Services/DAL for client-specific overrides (partial class, inheritance)",
    ],
    correctivePattern: "Merge base changes into client manuscript. Re-test affected workflows. Update CustomFeatures/<Client>/ with corrected override. Create regression test for this scenario.",
  },
  "Manuscript fix/merge": {
    technicalPattern: "Client manuscript (custom BSD/SQL code in CustomFeatures/<Client>/) was not updated after a base platform version change, causing incorrect behavior. The client override code references deprecated methods, missing variables, or outdated query structures.",
    services: ["RCI manuscript (.bsd)", "JAWS client customizations", "CustomFeatures"],
    investigationSteps: [
      "Find the relevant .bsd file in CustomFeatures/<Client>/Web/",
      "Identify the base change that broke the manuscript (compare base .bsd versions)",
      "Check if the manuscript uses deprecated variables or removed server-side functions",
    ],
    correctivePattern: "Update client manuscript to align with base version. Re-merge or revert overridden code sections to use the updated base implementation. Test all affected pages in the client environment.",
  },
  "Not applicable": {
    technicalPattern: "Issue did not have an identifiable repeating root cause. Likely one-off environmental or user-error scenario.",
    services: [],
    investigationSteps: [],
    correctivePattern: "Document and monitor. No systemic fix required.",
  },
};

// ─── Fix type → actionable guidance ─────────────────────────────────────────

export const FIX_TYPE_GUIDANCE = {
  "Data Fix": "Execute a targeted SQL script against the client database. Always take a DB backup first. Script should be reviewed by a DBA before execution. Verify affected rows before and after with a SELECT statement.",
  "Config File Fix": "Update the relevant BSD config file (System.bsd, CustomOptions.bsd) or Azure Table Storage row. Re-deploy via Octopus. Verify config is picked up by IIS application restart if needed.",
  "Code Fix": "Code change in JAWS, RDI, or RCI. Requires PR review, unit test coverage, and deployment through the CI/CD pipeline (Azure Pipelines → Octopus).",
  "Base Fix": "Fix applied to the shared base platform code. Must be regression-tested against all affected client manuscripts. Deploy via standard release pipeline.",
  "Custom manuscript changed": "Client-specific BSD or SQL override updated in CustomFeatures/<Client>/. Requires QA sign-off in client staging environment before production deploy.",
  "Deployment Fix": "Infrastructure or deployment configuration corrected (Octopus variables, Docker volume mounts, IIS app pool settings, Azure File Share paths). No code change required.",
  "Infra Fix": "Azure resource or server configuration change (VM sizing, Azure File Share quota, Application Insights connection string, Azure AD app registration). Coordinated with Azure admin.",
  "Data and Code Fix": "Combination: DB script applied first, then code deployed. Sequence matters — apply DB fix before code deployment to avoid runtime errors.",
};

// ─── Issue type → diagnostic context ─────────────────────────────────────────

export const ISSUE_TYPE_CONTEXT = {
  "Known Issue": "Documented defect in the base platform with a known workaround or pending fix in a future release. Check the release notes for the target version. May require client-specific hotfix.",
  "Custom": "Issue specific to the client's manuscript customization. Not reproducible in the base platform. Root cause is typically a manuscript conflict or client-specific data/config anomaly.",
  "Environmental": "Issue caused by the deployment environment (server config, IIS settings, Azure resource limits, file share permissions, SSL certificate). Not a code bug.",
  "Base": "Defect in the base platform code affecting all clients on this version. Requires base code fix and coordinated deployment.",
  "Deployment": "Issue introduced during the deployment process (incorrect Octopus variable, missing migration step, wrong Docker image tag, file share not mounted). Rollback or re-deploy resolves.",
  "Upgrade": "Issue specific to the version upgrade process. Often involves missing migration scripts, deprecated API calls in manuscripts, or config schema changes between versions.",
};

// ─── High-frequency defect patterns from production data ────────────────────

export const KNOWN_PATTERNS = [
  {
    pattern: "letter|pdf|word|404|run report|template",
    component: "LetterService",
    rootCause: "LetterService pipeline failure. Most common causes: (1) Missing database object (ExtFld column or stored proc not in client DB); (2) Wrong Azure File Share path for /files/mailmerge/Letters_*/; (3) Mail merge binding key mismatch (RCTEntities layer references wrong column); (4) LetterService not restarted after config change.",
    immediateActions: [
      "Verify the DB query in RCTBusinessLayer returns all expected columns including the failing field",
      "Check /files/mailmerge/Letters_*/ path is correctly mounted and writable",
      "Compare mail merge template binding keys against current DB column names",
      "Restart LetterService Windows Service / Docker container after any config change",
    ],
    preventiveActions: [
      "Add LetterService smoke test to post-deployment checklist: generate one letter per template type",
      "Add ExtFld columns to VSDB schema validation script run pre-deployment",
      "Document all mail merge binding keys per client in a maintained mapping table",
    ],
  },
  {
    pattern: "signature|underwriter|contact|missing.*letter",
    component: "LetterService / Database",
    rootCause: "Mail merge field not populated. Either the RCTEntities query does not retrieve the field (missing JOIN or column), the ExtFld column is null/missing in the client DB, or the client manuscript overrides the letter data fetch with an incomplete query.",
    immediateActions: [
      "Execute a SELECT on the relevant table to confirm the field has data",
      "Check RCTBusinessLayer data fetch query includes the missing field",
      "Verify ExtFld mapping for the signature/contact field in the client DB",
    ],
    preventiveActions: [
      "Require letter QA checklist sign-off (all dynamic fields visible) before go-live",
      "Add signature/contact field to automated letter generation test suite",
    ],
  },
  {
    pattern: "okta|sso|login|redirect|auth|session",
    component: "SSO / RCI",
    rootCause: "SSO authentication misconfiguration. Common: (1) Okta app redirect URI not updated for new environment URL; (2) RCI still showing legacy login screen after SSO enable (Config_DSN.bsd or CustomOptions.bsd not updated); (3) JWT token expiry mismatch between RDI (30-min) and client session expectations.",
    immediateActions: [
      "Verify Okta application redirect URIs include the current environment URL",
      "Check CustomOptions.bsd: SSOEnabled flag and SSOProvider setting",
      "Check Config_DSN.bsd: Authentication provider settings",
      "Confirm RDI JWT token expiry settings in appsettings.json match client requirements",
    ],
    preventiveActions: [
      "Maintain SSO configuration checklist per client (Okta app, redirect URIs, RCI config)",
      "Add SSO login smoke test to post-deployment verification pipeline",
    ],
  },
  {
    pattern: "due date|recommendation|date.*wrong|wrong.*date|auto.*date",
    component: "RCI / Azure Table Storage",
    rootCause: "Recommendation due date configuration mismatch. Due dates for Advisory/Critical/Important recommendations are driven by Azure Table Storage config entries. If the config row is missing or has wrong day-offset values, dates will be wrong or unchanged.",
    immediateActions: [
      "Query Azure Table Storage Recommendations table for the client: verify DueDateOffset entries for each severity",
      "Compare config values against client requirements specification",
      "Update Azure Table Storage row with correct offset values",
    ],
    preventiveActions: [
      "Include Azure Table Storage config validation in upgrade checklist",
      "Export and version-control client Azure Table Storage config as part of deployment artefacts",
    ],
  },
  {
    pattern: "photo|image|attachment|file|upload|imaging",
    component: "ImagingService / Azure File Share",
    rootCause: "ImagingService file processing failure. Common: (1) Azure File Share mount path incorrect (rci:rootPath mismatch); (2) Output path (im:outputPath) not accessible; (3) ImagingService Windows Service stopped; (4) Missing ExtFld13/14 columns for photo metadata in DB.",
    immediateActions: [
      "Verify ImagingService health endpoint: GET /ImagingHealthCheck",
      "Check Docker volume mount for rci:rootPath points to correct Azure File Share",
      "Verify im:outputPath directory exists and has write permissions",
      "Check SQL for ExtFld13/ExtFld14 presence on target table",
    ],
    preventiveActions: [
      "Add file share mount validation to ImagingService startup health check",
      "Monitor ImagingService queue depth via Application Insights",
    ],
  },
  {
    pattern: "import|xml|evolution|plugin|batch",
    component: "Evolution / Jobs",
    rootCause: "XML import processing failure. Common: (1) ImportFolders path not mounted in Docker; (2) Client-specific plugin (in CustomFeatures/<Client>/Jobs/Evolution/Plugins/) not compiled or deployed; (3) XML structure changed between versions; (4) Application Insights connection string using deprecated instrumentation key (deprecated March 2025).",
    immediateActions: [
      "Check Evolution Docker volume mount: /ImportFolders matches file share structure",
      "Verify client plugin assembly is present in /Plugins directory",
      "Check Application Insights connection string format (must be: InstrumentationKey=...;IngestionEndpoint=...)",
      "Review Evolution Application Insights logs (LoggerName=EvolutionIntegration) for exception details",
    ],
    preventiveActions: [
      "Update all Evolution configurations to use AppInsights connection string (not instrumentation key)",
      "Add XML schema validation step before Evolution import processing",
      "Test each client plugin against new XML format in staging before production upgrade",
    ],
  },
  {
    pattern: "performance|slow|timeout|memory|query",
    component: "JAWS / RDI / SQL Server",
    rootCause: "Performance degradation. Common: (1) Missing DB index on high-cardinality columns used in WHERE/JOIN clauses; (2) N+1 queries in JAWS DAL; (3) RDI AspNetCoreRateLimit misconfigured — throttling legitimate requests; (4) Azure Storage Queue backlog causing async operations to appear slow.",
    immediateActions: [
      "Run SQL Server execution plan on the slow query to identify missing indexes",
      "Check RDI rate limiting configuration (AspNetCoreRateLimit settings in appsettings.json)",
      "Monitor Azure Storage Queue depth for RDI batch processing queues",
      "Check Application Insights for JAWS dependency call durations",
    ],
    preventiveActions: [
      "Add index analysis to VSDB pre-deployment validation",
      "Set up Application Insights alerts for P99 response time > 5s",
      "Review JAWS DAL for N+1 patterns when adding new data features",
    ],
  },
];

/**
 * Get the best-matching known pattern context for a cluster's keywords.
 * Returns the most relevant pattern or null.
 */
export function matchKnownPattern(keywords) {
  const keywordText = keywords.join(" ").toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const p of KNOWN_PATTERNS) {
    const patternTerms = p.pattern.split("|");
    const score = patternTerms.filter(t => keywordText.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Get component-specific context for a cluster's component list.
 */
export function getComponentContext(components) {
  for (const comp of components) {
    if (COMPONENT_CONTEXT[comp]) return COMPONENT_CONTEXT[comp];
  }
  return COMPONENT_CONTEXT["default"];
}

/**
 * Build a concise platform context string to inject into the AI prompt.
 */
export function buildPlatformContext(cluster, defects) {
  const compCtx = getComponentContext(cluster.components);
  const pattern = matchKnownPattern(cluster.keywords);

  // Collect unique rca_categories and fix_types from defects
  const rcaCategories = [...new Set(defects.map(d => d.rca_category).filter(Boolean))];
  const fixTypes = [...new Set(defects.map(d => d.fix_type).filter(Boolean))];
  const issueTypes = [...new Set(defects.map(d => d.issue_type).filter(Boolean))];

  const rcaCategoryDetails = rcaCategories
    .map(c => RCA_CATEGORY_CONTEXT[c])
    .filter(Boolean);

  const fixTypeDetails = fixTypes
    .map(f => FIX_TYPE_GUIDANCE[f])
    .filter(Boolean);

  const issueTypeDetails = issueTypes
    .map(i => ISSUE_TYPE_CONTEXT[i])
    .filter(Boolean);

  let ctx = `
=== RCT PLATFORM ARCHITECTURE CONTEXT ===

${PLATFORM_OVERVIEW}

=== COMPONENT-SPECIFIC CONTEXT FOR THIS CLUSTER ===

Affected Services: ${compCtx.services.join(", ")}
Description: ${compCtx.description}
Typical failure modes for this component:
${compCtx.typicalFailures.map(f => `  - ${f}`).join("\n")}
`;

  if (pattern) {
    ctx += `
=== KNOWN DEFECT PATTERN MATCH ===
Pattern: ${pattern.pattern}
Component: ${pattern.component}
Root Cause Pattern: ${pattern.rootCause}
Known Immediate Actions:
${pattern.immediateActions.map(a => `  - ${a}`).join("\n")}
Known Preventive Actions:
${pattern.preventiveActions.map(a => `  - ${a}`).join("\n")}
`;
  }

  if (rcaCategoryDetails.length > 0) {
    ctx += `
=== ADO RCA CATEGORY TECHNICAL CONTEXT ===
${rcaCategories.map((cat, i) => {
  const d = rcaCategoryDetails[i];
  if (!d) return "";
  return `
Category: ${cat}
Technical Pattern: ${d.technicalPattern}
Affected Services: ${d.services.join(", ")}
Investigation Steps:
${d.investigationSteps.map(s => `  - ${s}`).join("\n")}
Corrective Approach: ${d.correctivePattern}
`;
}).join("\n")}`;
  }

  if (fixTypeDetails.length > 0) {
    ctx += `
=== FIX TYPE GUIDANCE ===
${fixTypes.map((ft, i) => `${ft}: ${fixTypeDetails[i]}`).join("\n")}
`;
  }

  if (issueTypeDetails.length > 0) {
    ctx += `
=== ISSUE TYPE CONTEXT ===
${issueTypes.map((it, i) => `${it}: ${issueTypeDetails[i]}`).join("\n")}
`;
  }

  return ctx.trim();
}
