import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { clusterDefects } from "./lib/clustering.js";
import { generateRCA } from "./lib/rca-engine.js";
import { buildCorpus, cosineSimilarity, topTerms } from "./lib/tfidf.js";
import { testConnection as testZenDesk, isZenDeskConfigured, collectZenDeskIds } from "./lib/zendesk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load & cluster data on startup ──────────────────────────────────────────
const rawDefects = JSON.parse(
  readFileSync(join(__dirname, "data", "jira-defects.json"), "utf-8")
);

console.log(`Loaded ${rawDefects.length} defects — clustering...`);
const { defects, clusters } = clusterDefects(rawDefects);
console.log(`Clustered into ${clusters.length} groups`);

// RCA cache: cluster.id → rca object
const rcaCache = new Map();

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ─── GET /api/mode ────────────────────────────────────────────────────────────
app.get("/api/mode", (req, res) => {
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    res.json({ mode: "azure", label: `Azure AI Foundry · ${process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o"}` });
  } else if (process.env.ANTHROPIC_API_KEY) {
    res.json({ mode: "claude", label: "Claude API" });
  } else {
    res.json({ mode: "offline", label: "Template Engine (offline)" });
  }
});

// ─── GET /api/zendesk/status ──────────────────────────────────────────────────
app.get("/api/zendesk/status", async (req, res) => {
  if (!isZenDeskConfigured()) {
    return res.json({
      configured: false,
      message: "ZenDesk not configured. Set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_API_TOKEN in .env",
    });
  }
  const result = await testZenDesk();
  // Count defects with ZenDesk references
  const idMap = collectZenDeskIds(defects);
  res.json({
    configured: true,
    connected: result.ok,
    mode: result.mode,
    message: result.message,
    user: result.user || null,
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    defects_with_zen_refs: idMap.size,
    zen_ticket_ids: [...idMap.keys()],
  });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const open   = defects.filter(d => d.status === "Open").length;
  const inProg = defects.filter(d => d.status === "In Progress").length;
  const resolved = defects.filter(d => d.status === "Resolved").length;
  const reopened = defects.filter(d => d.reopened).length;
  const highRecurrence = clusters.filter(c => c.recurrence_score >= 0.5).length;
  const rcaGenerated   = rcaCache.size;

  const topCluster = clusters[0] || null;

  // Priority breakdown
  const priorities = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const d of defects) if (priorities[d.priority] !== undefined) priorities[d.priority]++;

  res.json({
    total_defects:     defects.length,
    open_defects:      open,
    in_progress:       inProg,
    resolved_defects:  resolved,
    reopened_count:    reopened,
    total_clusters:    clusters.length,
    high_recurrence:   highRecurrence,
    rca_generated:     rcaGenerated,
    top_cluster:       topCluster ? { id: topCluster.id, label: topCluster.label, score: topCluster.recurrence_score } : null,
    priority_breakdown: priorities,
  });
});

// ─── GET /api/defects ─────────────────────────────────────────────────────────
app.get("/api/defects", (req, res) => {
  const { status, priority, component, cluster_id, q } = req.query;
  let result = defects;
  if (status)     result = result.filter(d => d.status === status);
  if (priority)   result = result.filter(d => d.priority === priority);
  if (component)  result = result.filter(d => d.component === component);
  if (cluster_id) result = result.filter(d => d.cluster_id === cluster_id);
  if (q) {
    const lq = q.toLowerCase();
    result = result.filter(d =>
      d.summary.toLowerCase().includes(lq) ||
      d.description.toLowerCase().includes(lq) ||
      d.key.toLowerCase().includes(lq)
    );
  }
  res.json({ total: result.length, defects: result });
});

// ─── GET /api/defects/:id ─────────────────────────────────────────────────────
app.get("/api/defects/:id", (req, res) => {
  const d = defects.find(d => d.key === req.params.id || String(d.id) === req.params.id);
  if (!d) return res.status(404).json({ error: "Defect not found" });
  res.json(d);
});

// ─── GET /api/clusters ────────────────────────────────────────────────────────
app.get("/api/clusters", (req, res) => {
  const enriched = clusters.map(c => ({
    ...c,
    has_rca: rcaCache.has(c.id),
  }));
  res.json({ total: enriched.length, clusters: enriched });
});

// ─── GET /api/clusters/:id ────────────────────────────────────────────────────
app.get("/api/clusters/:id", (req, res) => {
  const cluster = clusters.find(c => c.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: "Cluster not found" });

  const members = defects.filter(d => cluster.defect_ids.includes(d.key));
  res.json({
    ...cluster,
    has_rca: rcaCache.has(cluster.id),
    rca: rcaCache.get(cluster.id) || null,
    defects: members,
  });
});

// ─── POST /api/clusters/:id/rca ───────────────────────────────────────────────
app.post("/api/clusters/:id/rca", async (req, res) => {
  const cluster = clusters.find(c => c.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: "Cluster not found" });

  try {
    const members = defects.filter(d => cluster.defect_ids.includes(d.key));
    const rca = await generateRCA(cluster, members);
    rcaCache.set(cluster.id, rca);
    res.json({ cluster_id: cluster.id, rca });
  } catch (err) {
    console.error("RCA generation error:", err);
    res.status(500).json({ error: "RCA generation failed", detail: err.message });
  }
});

// ─── GET /api/clusters/:id/rca ────────────────────────────────────────────────
app.get("/api/clusters/:id/rca", (req, res) => {
  const cluster = clusters.find(c => c.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: "Cluster not found" });
  const rca = rcaCache.get(cluster.id);
  if (!rca) return res.status(404).json({ error: "RCA not yet generated for this cluster" });
  res.json({ cluster_id: cluster.id, rca });
});

// ─── POST /api/search ─────────────────────────────────────────────────────────
app.post("/api/search", (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: "Query must be at least 2 characters" });
  }

  // Build corpus from query + all defect texts, then compare
  const defectTexts = defects.map(d =>
    [d.summary, d.description, (d.labels || []).join(" ")].join(" ")
  );
  const allTexts = [query, ...defectTexts];
  const { vectors } = buildCorpus(allTexts);

  const queryVec = vectors[0];
  const results = defects
    .map((d, i) => ({
      ...d,
      similarity: Math.round(cosineSimilarity(queryVec, vectors[i + 1]) * 1000) / 1000,
    }))
    .filter(d => d.similarity > 0.05)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 15);

  res.json({ query, total: results.length, results });
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message is required" });

  // ── Build context snapshot ──────────────────────────────────────────────────
  const defectSummary = defects.map(d => ({
    key: d.key, summary: d.summary, status: d.status,
    priority: d.priority, component: d.component, cluster_id: d.cluster_id,
  }));

  const clusterSummary = clusters.map(c => ({
    id: c.id, label: c.label, keywords: c.keywords,
    recurrence_score: c.recurrence_score, components: c.components,
    defect_count: c.defect_count, day_span: c.day_span, reopen_rate: c.reopen_rate,
  }));

  const rcaSummary = {};
  for (const [cid, rca] of rcaCache) {
    rcaSummary[cid] = {
      root_cause: rca.root_cause,
      contributing_factors: rca.contributing_factors,
      impact: rca.impact,
      corrective_actions: rca.corrective_actions,
      preventive_actions: rca.preventive_actions,
    };
  }

  const systemPrompt = `You are an RCA Assistant for DuckCreek Loss Control P&C insurance platform.
You have access to the following live defect data. Use it to answer questions accurately.

DEFECTS (${defectSummary.length} total):
${JSON.stringify(defectSummary)}

CLUSTERS (${clusterSummary.length} total):
${JSON.stringify(clusterSummary)}

GENERATED RCAs (${rcaCache.size} clusters have RCAs):
${JSON.stringify(rcaSummary)}

Instructions:
- Answer questions about specific defects, clusters, root causes, corrective actions, and preventive actions.
- When referencing defects use their key (e.g. LC-1001). When referencing clusters use their ID (e.g. CLU-001).
- Be concise and structured. Use bullet points for lists of actions.
- If asked about a defect that has no RCA yet, say so and suggest generating one from the Clusters tab.
- If data is not available, say so clearly.`;

  // ── Azure OpenAI ────────────────────────────────────────────────────────────
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    try {
      const { OpenAI } = await import("openai");
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
      const client = new OpenAI({
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey:  process.env.AZURE_OPENAI_KEY,
      });

      const messages = [
        { role: "system", content: systemPrompt },
        ...history.slice(-10),           // keep last 10 turns for context window
        { role: "user", content: message },
      ];

      const response = await client.chat.completions.create({
        model: deployment,
        temperature: 0.3,
        max_tokens: 1024,
        messages,
      });

      const reply = response.choices[0]?.message?.content || "No response generated.";

      // Extract mentioned cluster/defect IDs as sources
      const sources = [
        ...[...rcaCache.keys()].filter(id => reply.includes(id)),
        ...defects.map(d => d.key).filter(k => reply.includes(k)).slice(0, 5),
      ];

      return res.json({ reply, sources: [...new Set(sources)] });
    } catch (err) {
      console.error("Chat Azure OpenAI error:", err.message);
      return res.status(500).json({ error: "AI call failed", detail: err.message });
    }
  }

  // ── Anthropic Claude ────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const msgs = [
        ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: "user", content: message },
      ];

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: msgs,
      });

      const reply = response.content[0]?.text || "No response generated.";
      const sources = [
        ...[...rcaCache.keys()].filter(id => reply.includes(id)),
        ...defects.map(d => d.key).filter(k => reply.includes(k)).slice(0, 5),
      ];
      return res.json({ reply, sources: [...new Set(sources)] });
    } catch (err) {
      console.error("Chat Claude error:", err.message);
      return res.status(500).json({ error: "AI call failed", detail: err.message });
    }
  }

  // ── Offline fallback ────────────────────────────────────────────────────────
  res.json({
    reply: "Chat requires an AI provider. Please start the server with `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY` (Azure) or `ANTHROPIC_API_KEY` (Claude) environment variables.",
    sources: [],
  });
});

// ─── GET /api/filters ─────────────────────────────────────────────────────────
app.get("/api/filters", (req, res) => {
  res.json({
    statuses:    [...new Set(defects.map(d => d.status))].sort(),
    priorities:  ["Critical", "High", "Medium", "Low"],
    components:  [...new Set(defects.map(d => d.component))].sort(),
  });
});

// ─── JSON error handler (replaces Express's default HTML error page) ─────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(err.status || err.statusCode || 500).json({ error: err.message || "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const mode = process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY
    ? `Azure AI Foundry (${process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o"})`
    : process.env.ANTHROPIC_API_KEY
      ? "Claude API"
      : "Template Engine (offline)";
  console.log(`\n RCA POC running on http://localhost:${PORT}`);
  console.log(` RCA Mode: ${mode}`);
  console.log(` Defects: ${defects.length}  |  Clusters: ${clusters.length}`);
  console.log(` Top cluster: "${clusters[0]?.label}" (score: ${clusters[0]?.recurrence_score})\n`);
});
