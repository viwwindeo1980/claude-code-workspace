// Pure JavaScript TF-IDF vectorizer — no external dependencies

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","was","are","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","shall","can",
  "not","no","nor","so","yet","both","either","neither","each","few","more",
  "most","other","some","such","than","then","there","these","they","this",
  "those","though","through","too","under","until","up","very","was","when",
  "where","whether","which","while","who","whom","why","how","all","any","both",
  "it","its","i","we","you","he","she","them","their","our","us","me","my",
  "your","his","her","into","also","after","before","about","out","if","as",
  "what","that","just","than","only","over","new","also","back","get","go",
  "see","use","user","using","used","due","per","via",
]);

/**
 * Tokenize and normalize a text string.
 * Returns array of lowercase alphanumeric tokens (min length 3), stop words removed.
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Build a TF (term frequency) map for a single document.
 * @param {string} text
 * @returns {Map<string, number>} term → normalized TF
 */
export function buildTF(text) {
  const tokens = tokenize(text);
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const total = tokens.length || 1;
  for (const [t, c] of freq) freq.set(t, c / total);
  return freq;
}

/**
 * Build IDF (inverse document frequency) map across a corpus of documents.
 * @param {string[]} docs - array of raw text strings
 * @returns {Map<string, number>} term → IDF score
 */
export function buildIDF(docs) {
  const dfMap = new Map();
  const N = docs.length;
  for (const doc of docs) {
    const unique = new Set(tokenize(doc));
    for (const t of unique) dfMap.set(t, (dfMap.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, df] of dfMap) idf.set(t, Math.log((N + 1) / (df + 1)) + 1);
  return idf;
}

/**
 * Build a TF-IDF vector (Map<term, score>) for a document given the IDF map.
 * @param {string} text
 * @param {Map<string, number>} idf
 * @returns {Map<string, number>}
 */
export function buildVector(text, idf) {
  const tf = buildTF(text);
  const vec = new Map();
  for (const [t, tfScore] of tf) {
    const idfScore = idf.get(t) || 0;
    if (idfScore > 0) vec.set(t, tfScore * idfScore);
  }
  return vec;
}

/**
 * Cosine similarity between two TF-IDF vectors.
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number} 0–1
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const [t, va] of a) {
    const vb = b.get(t) || 0;
    dot += va * vb;
    normA += va * va;
  }
  for (const [, vb] of b) normB += vb * vb;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Get top-N terms by TF-IDF score for a document vector.
 * @param {Map<string, number>} vector
 * @param {number} n
 * @returns {string[]}
 */
export function topTerms(vector, n = 5) {
  return [...vector.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

/**
 * Build TF-IDF vectors for all documents.
 * @param {string[]} docs
 * @returns {{ idf: Map, vectors: Map[] }}
 */
export function buildCorpus(docs) {
  const idf = buildIDF(docs);
  const vectors = docs.map(d => buildVector(d, idf));
  return { idf, vectors };
}
