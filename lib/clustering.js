// Greedy cosine-similarity clustering + recurrence scoring

import { buildCorpus, cosineSimilarity, topTerms } from "./tfidf.js";

const SIMILARITY_THRESHOLD = 0.18; // defects above this threshold are grouped

/**
 * Cluster defects by semantic similarity of summary + description.
 * Returns enriched defects (with cluster_id) and cluster metadata.
 *
 * @param {object[]} defects
 * @returns {{ defects: object[], clusters: object[] }}
 */
export function clusterDefects(defects) {
  // Build one text per defect: summary + description + labels
  const docs = defects.map(d =>
    [d.summary, d.description, (d.labels || []).join(" ")].join(" ")
  );

  const { idf, vectors } = buildCorpus(docs);

  // Greedy single-linkage clustering
  const assignments = new Array(defects.length).fill(-1); // -1 = unassigned
  let nextClusterId = 0;

  for (let i = 0; i < defects.length; i++) {
    if (assignments[i] !== -1) continue; // already assigned

    // Find all defects similar to i
    const members = [i];
    for (let j = i + 1; j < defects.length; j++) {
      if (assignments[j] !== -1) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= SIMILARITY_THRESHOLD) members.push(j);
    }

    // Also check if existing cluster members pull in more neighbours
    for (let pass = 0; pass < 2; pass++) {
      for (const m of members) {
        for (let j = 0; j < defects.length; j++) {
          if (assignments[j] !== -1 || members.includes(j)) continue;
          const sim = cosineSimilarity(vectors[m], vectors[j]);
          if (sim >= SIMILARITY_THRESHOLD) members.push(j);
        }
      }
    }

    const cid = nextClusterId++;
    for (const m of members) assignments[m] = cid;
  }

  // Build cluster map: cid → member indices
  const clusterMap = new Map();
  for (let i = 0; i < defects.length; i++) {
    const cid = assignments[i];
    if (!clusterMap.has(cid)) clusterMap.set(cid, []);
    clusterMap.get(cid).push(i);
  }

  // Build cluster metadata
  const clusterMeta = [];
  for (const [cid, indices] of clusterMap) {
    const members = indices.map(i => defects[i]);

    // Representative vector: average of member vectors
    const combinedText = members.map(d =>
      [d.summary, d.description, (d.labels || []).join(" ")].join(" ")
    ).join(" ");
    const { vectors: [repVec] } = buildCorpus([combinedText]);
    const keywords = topTerms(repVec, 6);

    // Dates
    const dates = members
      .map(d => d.created)
      .filter(Boolean)
      .sort();
    const firstSeen = dates[0] || "unknown";
    const lastSeen = dates[dates.length - 1] || "unknown";

    // Days span
    const msSpan = dates.length >= 2
      ? (new Date(lastSeen) - new Date(firstSeen))
      : 0;
    const daySpan = Math.max(1, Math.round(msSpan / 86400000));

    // Max possible day span (from earliest defect to now)
    const allDates = defects.map(d => d.created).filter(Boolean).sort();
    const totalDays = Math.max(1, Math.round(
      (new Date() - new Date(allDates[0])) / 86400000
    ));

    // Reopen rate
    const reopened = members.filter(d => d.reopened).length;
    const reopenRate = members.length > 0 ? reopened / members.length : 0;

    // Recurrence score: weighted blend
    const maxCount = Math.max(...[...clusterMap.values()].map(v => v.length));
    const countScore   = members.length / maxCount;
    const timeScore    = Math.min(1, daySpan / totalDays);
    const reopenScore  = reopenRate;
    const recurrenceScore = Math.min(1,
      0.5 * countScore + 0.25 * timeScore + 0.25 * reopenScore
    );

    // Priority distribution
    const priorities = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const d of members) {
      if (priorities[d.priority] !== undefined) priorities[d.priority]++;
    }

    // Status distribution
    const statuses = {};
    for (const d of members) statuses[d.status] = (statuses[d.status] || 0) + 1;

    // Derive label from top keywords
    const label = keywords.slice(0, 3).map(k =>
      k.charAt(0).toUpperCase() + k.slice(1)
    ).join(" / ");

    clusterMeta.push({
      id: `CLU-${String(cid + 1).padStart(3, "0")}`,
      label,
      keywords,
      defect_count: members.length,
      defect_ids: members.map(d => d.key),
      first_seen: firstSeen,
      last_seen: lastSeen,
      day_span: daySpan,
      recurrence_score: Math.round(recurrenceScore * 100) / 100,
      priority_distribution: priorities,
      status_distribution: statuses,
      reopen_rate: Math.round(reopenRate * 100) / 100,
      components: [...new Set(members.map(d => d.component))],
      rca: null,
    });
  }

  // Sort clusters by recurrence score descending
  clusterMeta.sort((a, b) => b.recurrence_score - a.recurrence_score);
  // Re-assign stable display IDs after sort
  clusterMeta.forEach((c, i) => { c.display_rank = i + 1; });

  // Enrich defects with cluster_id
  const enriched = defects.map((d, i) => ({
    ...d,
    cluster_id: clusterMeta.find(c => c.defect_ids.includes(d.key))?.id || null,
  }));

  return { defects: enriched, clusters: clusterMeta };
}
