// RCA POC — frontend application logic

const API = "";  // same origin — Express serves this file

let allDefects   = [];
let allClusters  = [];
let currentRCA   = null;
let currentClusterId = null;

// ─── Tab navigation ───────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab-view").forEach(v => v.classList.add("hidden"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("view-" + name).classList.remove("hidden");
  document.getElementById("tab-" + name).classList.add("active");
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function priorityBadge(p) {
  const map = { Critical: "badge-critical", High: "badge-high", Medium: "badge-medium", Low: "badge-low" };
  return `<span class="badge ${map[p] || "badge-low"}">${p}</span>`;
}
function statusBadge(s) {
  const map = { Open: "badge-open", "In Progress": "badge-progress", Resolved: "badge-resolved" };
  return `<span class="badge ${map[s] || ""}">${s}</span>`;
}
function effortBadge(e) {
  return `<span class="badge effort-${e} text-center w-8">${e}</span>`;
}
function typeBadge(t) {
  return `<span class="badge type-${t}">${t}</span>`;
}
function scoreColor(score) {
  if (score >= 0.7) return "#C0392B";
  if (score >= 0.5) return "#E8630A";
  if (score >= 0.3) return "#B45309";
  return "#00A3A0";
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const stats = await fetch("/api/stats").then(r => r.json());

  document.getElementById("stat-total").textContent    = stats.total_defects;
  document.getElementById("stat-open").textContent     = stats.open_defects;
  document.getElementById("stat-clusters").textContent = stats.total_clusters;
  document.getElementById("stat-high-rec").textContent = stats.high_recurrence;
  document.getElementById("stat-critical").textContent = stats.priority_breakdown.Critical;
  document.getElementById("stat-reopened").textContent = stats.reopened_count;
  document.getElementById("stat-rca-count").textContent = stats.rca_generated;

  document.getElementById("hdr-counts").textContent =
    `${stats.total_defects} defects  ·  ${stats.total_clusters} clusters`;

  // Top clusters
  const { clusters } = await fetch("/api/clusters").then(r => r.json());
  const list = document.getElementById("top-clusters-list");
  list.innerHTML = clusters.slice(0, 6).map(c => `
    <div class="flex items-center gap-3 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 cursor-pointer transition"
         onclick="openClusterRCA('${c.id}')">
      <div class="shrink-0 w-10 h-10 rounded-lg bg-navy flex items-center justify-center text-white font-bold text-sm">
        ${c.display_rank}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-sm text-gray-800 truncate">${c.label}</div>
        <div class="text-xs text-gray-500 mt-0.5">${c.defect_count} defects · ${c.components.join(", ")} · ${c.day_span} days</div>
        <div class="score-bar-bg mt-1.5 w-full">
          <div class="score-bar-fill" style="width:${Math.round(c.recurrence_score*100)}%; background:${scoreColor(c.recurrence_score)}"></div>
        </div>
      </div>
      <div class="shrink-0 text-right">
        <div class="font-bold text-lg" style="color:${scoreColor(c.recurrence_score)}">${c.recurrence_score.toFixed(2)}</div>
        <div class="text-xs text-gray-400">score</div>
      </div>
    </div>
  `).join("");

  // Priority bars
  const total = stats.total_defects || 1;
  const pColors = { Critical: "#C0392B", High: "#E8630A", Medium: "#3B82F6", Low: "#10B981" };
  const pb = document.getElementById("priority-bars");
  pb.innerHTML = Object.entries(stats.priority_breakdown).map(([p, n]) => `
    <div class="flex items-center gap-3">
      <div class="w-20 text-xs font-semibold text-gray-600">${p}</div>
      <div class="flex-1 bg-gray-100 rounded h-5">
        <div class="priority-bar h-5" style="width:${Math.round(n/total*100)}%; background:${pColors[p]}">
          ${n > 0 ? n : ""}
        </div>
      </div>
      <div class="w-8 text-xs font-mono text-gray-500 text-right">${n}</div>
    </div>
  `).join("");
}

// ─── Defects ──────────────────────────────────────────────────────────────────
async function loadDefects() {
  const { defects, total } = await fetch("/api/defects").then(r => r.json());
  allDefects = defects;
  renderDefects(defects);

  // Populate filter dropdowns
  const { statuses, priorities, components } = await fetch("/api/filters").then(r => r.json());
  const ss = document.getElementById("filter-status");
  statuses.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; ss.appendChild(o); });
  const sp = document.getElementById("filter-priority");
  priorities.forEach(p => { const o = document.createElement("option"); o.value = p; o.textContent = p; sp.appendChild(o); });
  const sc = document.getElementById("filter-component");
  components.forEach(c => { const o = document.createElement("option"); o.value = c; o.textContent = c; sc.appendChild(o); });
}

function renderDefects(defects) {
  const tbody = document.getElementById("defects-tbody");
  document.getElementById("defect-count-badge").textContent = `${defects.length} defects`;
  if (!defects.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400 text-sm">No defects match your filters</td></tr>`;
    return;
  }
  tbody.innerHTML = defects.map(d => `
    <tr class="hover:bg-gray-50 transition cursor-pointer" onclick="openDefectCluster('${d.cluster_id}')">
      <td class="px-4 py-2.5 font-mono text-xs text-teal font-semibold">${d.key}</td>
      <td class="px-4 py-2.5 text-sm text-gray-800 max-w-xs">
        <div class="truncate">${d.summary}</div>
        ${d.reopened ? '<span class="text-xs text-orange font-semibold">↩ Reopened</span>' : ""}
      </td>
      <td class="px-4 py-2.5 text-xs text-gray-600">${d.component}</td>
      <td class="px-4 py-2.5">${priorityBadge(d.priority)}</td>
      <td class="px-4 py-2.5">${statusBadge(d.status)}</td>
      <td class="px-4 py-2.5">
        ${d.cluster_id
          ? `<span class="text-xs font-mono text-navy bg-blue-50 px-2 py-0.5 rounded cursor-pointer hover:bg-blue-100" onclick="event.stopPropagation(); openClusterRCA('${d.cluster_id}')">${d.cluster_id}</span>`
          : `<span class="text-xs text-gray-400">—</span>`}
      </td>
      <td class="px-4 py-2.5 text-xs text-gray-500">${d.created}</td>
    </tr>
  `).join("");
}

function filterDefects() {
  const q     = document.getElementById("defect-search").value.toLowerCase();
  const st    = document.getElementById("filter-status").value;
  const pr    = document.getElementById("filter-priority").value;
  const comp  = document.getElementById("filter-component").value;

  const filtered = allDefects.filter(d => {
    const matchQ    = !q    || d.summary.toLowerCase().includes(q) || d.key.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);
    const matchSt   = !st   || d.status === st;
    const matchPr   = !pr   || d.priority === pr;
    const matchComp = !comp || d.component === comp;
    return matchQ && matchSt && matchPr && matchComp;
  });
  renderDefects(filtered);
}

// ─── Clusters ─────────────────────────────────────────────────────────────────
async function loadClusters() {
  const { clusters } = await fetch("/api/clusters").then(r => r.json());
  allClusters = clusters;
  renderClusters(clusters);
}

function renderClusters(clusters) {
  const grid = document.getElementById("clusters-grid");
  if (!clusters.length) {
    grid.innerHTML = `<div class="text-gray-400 text-sm">No clusters found</div>`;
    return;
  }
  grid.innerHTML = clusters.map(c => `
    <div class="cluster-card">
      <div class="cluster-card-header">
        <div class="flex justify-between items-start gap-2">
          <div>
            <div class="text-xs font-mono text-teal mb-1">${c.id} · Rank #${c.display_rank}</div>
            <div class="font-bold text-base leading-snug">${c.label}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-2xl font-black" style="color:${scoreColor(c.recurrence_score)}">${c.recurrence_score.toFixed(2)}</div>
            <div class="text-xs text-gray-400">recurrence</div>
          </div>
        </div>
        <!-- score bar -->
        <div class="score-bar-bg mt-3">
          <div class="score-bar-fill" style="width:${Math.round(c.recurrence_score*100)}%; background:${scoreColor(c.recurrence_score)}"></div>
        </div>
      </div>

      <div class="p-4 space-y-3">
        <!-- Stats row -->
        <div class="flex gap-4 text-xs text-gray-600">
          <div><span class="font-bold text-navy">${c.defect_count}</span> defects</div>
          <div><span class="font-bold text-navy">${c.day_span}</span> days span</div>
          <div><span class="font-bold text-navy">${Math.round(c.reopen_rate * 100)}%</span> reopen rate</div>
        </div>

        <!-- Date range -->
        <div class="text-xs text-gray-500">
          📅 ${c.first_seen} → ${c.last_seen}
        </div>

        <!-- Components -->
        <div class="flex flex-wrap gap-1">
          ${c.components.map(comp => `<span class="kw-chip bg-navy/10 text-navy border-navy/20">${comp}</span>`).join("")}
        </div>

        <!-- Keywords -->
        <div class="flex flex-wrap gap-1">
          ${c.keywords.map(k => `<span class="kw-chip">${k}</span>`).join("")}
        </div>

        <!-- Priority mini-bar -->
        <div class="flex gap-1 h-2">
          ${c.priority_distribution.Critical > 0 ? `<div title="Critical: ${c.priority_distribution.Critical}" class="rounded" style="flex:${c.priority_distribution.Critical}; background:#C0392B"></div>` : ""}
          ${c.priority_distribution.High > 0     ? `<div title="High: ${c.priority_distribution.High}"     class="rounded" style="flex:${c.priority_distribution.High};     background:#E8630A"></div>` : ""}
          ${c.priority_distribution.Medium > 0   ? `<div title="Medium: ${c.priority_distribution.Medium}" class="rounded" style="flex:${c.priority_distribution.Medium};   background:#3B82F6"></div>` : ""}
          ${c.priority_distribution.Low > 0      ? `<div title="Low: ${c.priority_distribution.Low}"       class="rounded" style="flex:${c.priority_distribution.Low};      background:#10B981"></div>` : ""}
        </div>

        <!-- Action button -->
        <button id="rca-btn-${c.id}"
          class="btn-primary w-full mt-1 flex items-center justify-center gap-2"
          onclick="generateRCA('${c.id}', this)">
          ${c.has_rca ? "✅ View RCA" : "⚡ Generate RCA"}
        </button>
      </div>
    </div>
  `).join("");
}

// ─── Generate / view RCA ──────────────────────────────────────────────────────
async function generateRCA(clusterId, btn) {
  const cluster = allClusters.find(c => c.id === clusterId);
  if (!cluster) return;

  // If RCA already exists, just view it
  if (cluster.has_rca) {
    const { rca } = await fetch(`/api/clusters/${clusterId}/rca`).then(r => r.json());
    renderRCA(cluster, rca);
    showTab("rca");
    return;
  }

  // Generate
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Generating RCA...`;

  try {
    const { rca } = await fetch(`/api/clusters/${clusterId}/rca`, { method: "POST" }).then(r => r.json());
    cluster.has_rca = true;
    btn.innerHTML = "✅ View RCA";
    btn.disabled = false;
    renderRCA(cluster, rca);
    showTab("rca");
    // Refresh stats
    loadDashboard();
  } catch (err) {
    btn.innerHTML = origText;
    btn.disabled = false;
    alert("RCA generation failed: " + err.message);
  }
}

async function openClusterRCA(clusterId) {
  if (!clusterId) return;
  const cluster = allClusters.find(c => c.id === clusterId)
    || (await fetch(`/api/clusters/${clusterId}`).then(r => r.json()));

  if (cluster.has_rca || cluster.rca) {
    const { rca } = await fetch(`/api/clusters/${clusterId}/rca`).then(r => r.json());
    renderRCA(cluster, rca);
    showTab("rca");
  } else {
    // Navigate to clusters and highlight
    showTab("clusters");
  }
}

function openDefectCluster(clusterId) {
  if (!clusterId) return;
  showTab("clusters");
}

function renderRCA(cluster, rca) {
  currentRCA = rca;
  currentClusterId = cluster.id;

  document.getElementById("rca-placeholder").classList.add("hidden");
  document.getElementById("rca-content").classList.remove("hidden");

  document.getElementById("rca-cluster-id").textContent    = cluster.id;
  document.getElementById("rca-cluster-label").textContent = cluster.label;
  document.getElementById("rca-score").textContent         = cluster.recurrence_score.toFixed(2);
  document.getElementById("rca-defect-count").textContent  = `${cluster.defect_count} defects`;
  document.getElementById("rca-timespan").textContent      = `${cluster.day_span} days`;
  document.getElementById("rca-components").textContent    = cluster.components.join(", ");

  const genBy = rca.generated_by === "template-engine"
    ? "📋 Template Engine (offline)"
    : `🤖 ${rca.generated_by}`;
  document.getElementById("rca-generated-by").innerHTML =
    `<span class="text-xs ${rca.generated_by === 'template-engine' ? 'text-gray-400' : 'text-teal'}">${genBy} · Confidence: ${Math.round(rca.confidence_score * 100)}%</span>`;

  document.getElementById("rca-root-technical").textContent = rca.root_cause.technical;
  document.getElementById("rca-root-process").textContent   = rca.root_cause.process;

  // Impact
  const sevMap = { Critical: "badge-critical", High: "badge-high", Medium: "badge-medium", Low: "badge-low" };
  document.getElementById("rca-impact-severity").className = `badge ${sevMap[rca.impact.severity] || "badge-medium"}`;
  document.getElementById("rca-impact-severity").textContent = rca.impact.severity;
  document.getElementById("rca-impact-modules").innerHTML =
    rca.impact.modules.map(m => `<span class="kw-chip">${m}</span>`).join("");
  document.getElementById("rca-impact-desc").textContent = rca.impact.description;

  // Contributing factors
  document.getElementById("rca-contributing").innerHTML =
    rca.contributing_factors.map(f =>
      `<li class="flex gap-2"><span class="text-orange shrink-0 mt-0.5">▸</span><span>${f}</span></li>`
    ).join("");

  // Corrective actions
  document.getElementById("rca-corrective").innerHTML =
    rca.corrective_actions.map((a, i) => `
      <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}">
        <td class="px-3 py-2.5 text-sm text-gray-700">${a.action}</td>
        <td class="px-3 py-2.5 text-xs text-gray-600">${a.owner}</td>
        <td class="px-3 py-2.5 text-center">${effortBadge(a.effort)}</td>
        <td class="px-3 py-2.5 text-center">
          <span class="badge ${a.priority === 'immediate' ? 'badge-critical' : 'badge-medium'}">${a.priority}</span>
        </td>
      </tr>
    `).join("");

  // Preventive actions
  document.getElementById("rca-preventive").innerHTML =
    rca.preventive_actions.map((a, i) => `
      <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}">
        <td class="px-3 py-2.5 text-sm text-gray-700">${a.action}</td>
        <td class="px-3 py-2.5 text-center">${typeBadge(a.type)}</td>
        <td class="px-3 py-2.5 text-center">${effortBadge(a.effort)}</td>
      </tr>
    `).join("");

  // Member defects
  fetch(`/api/clusters/${cluster.id}`).then(r => r.json()).then(data => {
    const memberEl = document.getElementById("rca-member-defects");
    if (!data.defects) return;
    memberEl.innerHTML = data.defects.map(d => `
      <div class="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50 text-sm">
        <span class="font-mono text-xs text-teal font-bold w-20 shrink-0">${d.key}</span>
        <span class="flex-1 text-gray-700 text-xs truncate">${d.summary}</span>
        <span class="shrink-0">${priorityBadge(d.priority)}</span>
        <span class="shrink-0">${statusBadge(d.status)}</span>
      </div>
    `).join("");
  });
}

// ─── Copy RCA as Markdown ─────────────────────────────────────────────────────
function copyRCA() {
  if (!currentRCA) return;
  const cluster = allClusters.find(c => c.id === currentClusterId) || { label: "—" };
  const rca = currentRCA;

  const md = [
    `# RCA: ${cluster.label}`,
    `\n**Cluster ID:** ${currentClusterId}  |  **Recurrence Score:** ${cluster.recurrence_score?.toFixed(2) || "—"}  |  **Generated by:** ${rca.generated_by}`,
    `\n## Root Cause`,
    `\n### Technical\n${rca.root_cause.technical}`,
    `\n### Process\n${rca.root_cause.process}`,
    `\n## Contributing Factors\n${rca.contributing_factors.map(f => `- ${f}`).join("\n")}`,
    `\n## Impact\n**Severity:** ${rca.impact.severity}  |  **Modules:** ${rca.impact.modules.join(", ")}\n\n${rca.impact.description}`,
    `\n## Corrective Actions\n| Action | Owner | Effort | Priority |\n|---|---|---|---|`,
    ...rca.corrective_actions.map(a => `| ${a.action} | ${a.owner} | ${a.effort} | ${a.priority} |`),
    `\n## Preventive Actions\n| Action | Type | Effort |\n|---|---|---|`,
    ...rca.preventive_actions.map(a => `| ${a.action} | ${a.type} | ${a.effort} |`),
  ].join("\n");

  navigator.clipboard.writeText(md).then(() => {
    const btn = document.querySelector("button[onclick='copyRCA()']");
    const orig = btn.textContent;
    btn.textContent = "✓ Copied!";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
let chatHistory = [];

function handleChatKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function appendBubble(role, text, sources = []) {
  const pane = document.getElementById("chat-messages");

  const bubble = document.createElement("div");
  bubble.className = role === "user" ? "bubble-user" : "bubble-assistant";

  const sender = document.createElement("div");
  sender.className = "bubble-sender";
  sender.textContent = role === "user" ? "You" : "RCA Assistant";

  const body = document.createElement("div");
  body.className = "bubble-text";
  // Render newlines and bullet points as HTML
  body.innerHTML = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-•] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n/g, "<br>");

  bubble.appendChild(sender);
  bubble.appendChild(body);

  if (sources.length > 0) {
    const srcRow = document.createElement("div");
    srcRow.className = "bubble-sources";
    sources.forEach(s => {
      const chip = document.createElement("span");
      chip.className = "bubble-source";
      chip.textContent = s;
      chip.title = "Click to view cluster/defect";
      chip.onclick = () => {
        const cluster = allClusters.find(c => c.id === s);
        if (cluster) openClusterRCA(s);
      };
      srcRow.appendChild(chip);
    });
    bubble.appendChild(srcRow);
  }

  pane.appendChild(bubble);
  pane.scrollTop = pane.scrollHeight;
  return bubble;
}

function appendTyping() {
  const pane = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "bubble-assistant bubble-typing";
  div.id = "chat-typing";
  div.innerHTML = `<div class="bubble-sender">RCA Assistant</div><div class="bubble-text"><span class="spinner" style="border-color:#0D1F4C40;border-top-color:#0D1F4C"></span></div>`;
  pane.appendChild(div);
  pane.scrollTop = pane.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const btn   = document.getElementById("chat-send-btn");
  const message = input.value.trim();
  if (!message) return;

  input.value = "";
  input.style.height = "auto";
  appendBubble("user", message);
  chatHistory.push({ role: "user", content: message });

  btn.disabled = true;
  appendTyping();

  try {
    const r = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ message, history: chatHistory.slice(-10) }),
    });
    if (!r.ok && r.headers.get("content-type")?.includes("text/html")) {
      throw new Error(`Server error ${r.status} — check server logs`);
    }
    const data = await r.json();

    document.getElementById("chat-typing")?.remove();

    const reply = data.reply || data.error || "No response.";
    appendBubble("assistant", reply, data.sources || []);
    chatHistory.push({ role: "assistant", content: reply });
  } catch (err) {
    document.getElementById("chat-typing")?.remove();
    appendBubble("assistant", "Error: " + err.message);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await Promise.all([loadDashboard(), loadDefects(), loadClusters()]);

    // Show mode badge
    const { mode, label } = await fetch("/api/mode").then(r => r.json());
    const modeEl = document.getElementById("hdr-mode");
    modeEl.textContent = label;
    if (mode === "azure") {
      modeEl.style.background = "rgba(0,120,212,0.35)";
      modeEl.style.color = "#90caf9";
    } else if (mode === "claude") {
      modeEl.style.background = "rgba(0,163,160,0.3)";
      modeEl.style.color = "#fff";
    }
  } catch (err) {
    console.error("Init error:", err);
    document.getElementById("hdr-counts").textContent = "⚠ Server not reachable";
  }
}

init();
