import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");
const HISTORY_FILE = join(DOCS_DIR, "pmid_history.json");

// ── API endpoints ──
const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const CROSSREF_API = "https://api.crossref.org/works";
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";

const HEADERS = { "User-Agent": "DIDBrainBot/2.0 (research aggregator; mailto:research@leepsyclinic.com)" };

// ── PubMed search queries (expanded) ──
const PUBMED_QUERIES = [
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR dissociative disorder*[Title/Abstract]))',
  '(("dissociative identity disorder"[Title/Abstract]) AND (treatment[Title/Abstract] OR therapy[Title/Abstract] OR psychotherapy[Title/Abstract] OR "trauma-focused"[Title/Abstract] OR EMDR[Title/Abstract] OR "schema therapy"[Title/Abstract] OR DBT[Title/Abstract]))',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR pathological dissociation[Title/Abstract])) AND (neuroimaging[Title/Abstract] OR fMRI[Title/Abstract] OR EEG[Title/Abstract] OR biomarker*[Title/Abstract] OR "functional connectivity"[Title/Abstract])',
  '(depersonalization[Title/Abstract] OR derealization[Title/Abstract] OR "somatoform dissociation"[Title/Abstract] OR "identity alteration"[Title/Abstract] OR switching[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR dissociative disorder*[Title/Abstract])) AND ("childhood trauma"[Title/Abstract] OR "childhood abuse"[Title/Abstract] OR maltreatment[Title/Abstract] OR neglect[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (comorbid*[Title/Abstract] OR borderline[Title/Abstract] OR PTSD[Title/Abstract] OR psychosis[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR dissociative disorder*[Title/Abstract])) AND ("self-injury"[Title/Abstract] OR suicid*[Title/Abstract] OR self-harm[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (memory[Title/Abstract] OR autobiographical[Title/Abstract] OR identity[Title/Abstract] OR self-state*[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (review[Publication Type] OR "systematic review"[Title/Abstract] OR "meta-analysis"[Title/Abstract])',
  // Expanded queries
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND ("structural dissociation"[Title/Abstract] OR "theory of structural dissociation"[Title/Abstract] OR "polyfragmented"[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (attachment[Title/Abstract] OR "internal working model"[Title/Abstract] OR "disorganized attachment"[Title/Abstract])',
  '(dissociation[Title/Abstract]) AND (trauma[Title/Abstract]) AND (prevalence[Title/Abstract] OR epidemiology[Title/Abstract] OR "population-based"[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (pharmacology[Title/Abstract] OR medication[Title/Abstract] OR psychopharmacolog*[Title/Abstract] OR SSRI[Title/Abstract])',
];

// ── Crossref queries ──
const CROSSREF_QUERIES = [
  "dissociative identity disorder",
  "DID dissociation trauma treatment",
  "dissociative identity disorder neuroimaging",
  "depersonalization derealization disorder",
  "dissociative disorder childhood trauma",
  "dissociative identity disorder therapy",
  "structural dissociation personality",
  "dissociation PTSD comorbidity",
];

// ── Semantic Scholar queries ──
const SEMANTIC_QUERIES = [
  "dissociative identity disorder treatment",
  "dissociative identity disorder neuroimaging fMRI",
  "pathological dissociation trauma",
  "depersonalization derealization",
];

// ── CLI args ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 14, maxPapers: 80, output: "papers.json", history: null, updateHistory: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--days": opts.days = parseInt(args[++i]); break;
      case "--max-papers": opts.maxPapers = parseInt(args[++i]); break;
      case "--output": opts.output = args[++i]; break;
      case "--history": opts.history = args[++i]; break;
      case "--update-history": opts.updateHistory = args[++i]; break;
    }
  }
  return opts;
}

// ── Date helpers ──
function getDateTaipei() {
  const now = new Date(Date.now() + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

function getLookbackDate(days) {
  const d = new Date(Date.now() - days * 86400000 + 8 * 3600000);
  return d.toISOString().slice(0, 10).replace(/-/g, "/");
}

// ── History helpers ──
function loadHistory(path) {
  if (!path || !existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set(data.pmids || []);
  } catch { return new Set(); }
}

function saveHistory(path, pmids) {
  if (!path) return;
  const existing = loadHistory(path);
  const all = [...new Set([...existing, ...pmids])];
  writeFileSync(path, JSON.stringify({ pmids: all, updated: new Date().toISOString() }, null, 2));
}

// ── DOI history for cross-source dedup ──
function loadDoiHistory() {
  const f = join(DOCS_DIR, "doi_history.json");
  if (!existsSync(f)) return new Set();
  try {
    const data = JSON.parse(readFileSync(f, "utf8"));
    return new Set((data.dois || []).map(d => d.toLowerCase()));
  } catch { return new Set(); }
}

function saveDoiHistory(dois) {
  const f = join(DOCS_DIR, "doi_history.json");
  let existing = [];
  if (existsSync(f)) {
    try { existing = JSON.parse(readFileSync(f, "utf8")).dois || []; } catch {}
  }
  const all = [...new Set([...existing, ...dois])];
  writeFileSync(f, JSON.stringify({ dois: all, updated: new Date().toISOString() }, null, 2));
}

// ── PubMed search ──
async function searchPapers(query, retmax = 100) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return data?.esearchresult?.idlist || [];
    } catch (e) {
      console.error(`[ERROR] PubMed search: ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return [];
}

// ── XML parsing ──
function extractXmlBlock(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function extractFirst(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function parseXmlPapers(xml) {
  const papers = [];
  const articles = xml.split(/<PubmedArticle>/).slice(1);
  for (const raw of articles) {
    const block = raw.split(/<\/PubmedArticle>/)[0];
    const pmid = extractFirst(block, "PMID");
    const title = extractFirst(block, "ArticleTitle");
    const abstractParts = [];
    const absRe = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let am;
    while ((am = absRe.exec(block)) !== null) {
      const labelM = am[0].match(/Label="([^"]+)"/);
      const label = labelM ? labelM[1] : "";
      const text = am[1].replace(/<[^>]+>/g, "").trim();
      if (label && text) abstractParts.push(`${label}: ${text}`);
      else if (text) abstractParts.push(text);
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);
    const journal = extractFirst(block, "Title");
    const year = extractFirst(block, "Year");
    const month = extractFirst(block, "Month");
    const day = extractFirst(block, "Day");
    const dateStr = [year, month, day].filter(Boolean).join(" ");
    const doiM = block.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/);
    const doi = doiM ? doiM[1].trim() : "";
    const keywords = [];
    const kwRe = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let km;
    while ((km = kwRe.exec(block)) !== null) {
      if (km[1].trim()) keywords.push(km[1].trim());
    }
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";
    papers.push({ pmid, doi, title, journal, date: dateStr, abstract, url, keywords, source: "PubMed" });
  }
  return papers;
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(",")}&retmode=xml`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      return parseXmlPapers(xml);
    } catch (e) {
      console.error(`[ERROR] PubMed fetch (attempt ${attempt + 1}): ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return [];
}

// ══════════════════════════════════════════
// Crossref search
// ══════════════════════════════════════════
async function searchCrossref(query, rows = 50) {
  const today = new Date(Date.now() + 8 * 3600000);
  const lookback = new Date(today.getTime() - 30 * 86400000);
  const fromDate = lookback.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    query: query,
    filter: `from-pub-date:${fromDate},type:journal-article`,
    rows: rows,
    sort: "published",
    order: "desc",
    select: "DOI,title,author,published-print,published-online,abstract,URL,container-title",
  });
  try {
    const resp = await fetch(`${CROSSREF_API}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data?.message?.items || []).map(item => ({
      doi: item.DOI || "",
      title: (item.title || []).join(" ").slice(0, 500),
      journal: (item["container-title"] || []).join(", "),
      date: item["published-print"]?.["date-parts"]?.[0]?.join("-") || item["published-online"]?.["date-parts"]?.[0]?.join("-") || "",
      abstract: (item.abstract || "").replace(/<[^>]+>/g, "").slice(0, 2000),
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ""),
      keywords: [],
      source: "Crossref",
      pmid: "",
    }));
  } catch (e) {
    console.error(`[ERROR] Crossref "${query}": ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════
// Semantic Scholar search
// ══════════════════════════════════════════
async function searchSemanticScholar(query, limit = 50) {
  const lookback = new Date(Date.now() - 60 * 86400000);
  const params = new URLSearchParams({
    query: query,
    limit: limit,
    fields: "paperId,externalIds,title,abstract,journal,publicationDate,url,isOpenAccess",
    year: `${lookback.getFullYear()}-`,
  });
  try {
    const resp = await fetch(`${SEMANTIC_SCHOLAR_API}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data?.data || []).map(item => ({
      doi: item.externalIds?.DOI || "",
      pmid: item.externalIds?.PubMed || "",
      title: (item.title || "").slice(0, 500),
      journal: item.journal?.name || "",
      date: item.publicationDate || "",
      abstract: (item.abstract || "").slice(0, 2000),
      url: item.url || (item.externalIds?.DOI ? `https://doi.org/${item.externalIds.DOI}` : ""),
      keywords: [],
      source: "SemanticScholar",
    }));
  } catch (e) {
    console.error(`[ERROR] Semantic Scholar "${query}": ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════
// Main
// ══════════════════════════════════════════
async function main() {
  const opts = parseArgs();

  // Handle --update-history mode
  if (opts.updateHistory) {
    if (opts.history && existsSync(opts.updateHistory)) {
      const data = JSON.parse(readFileSync(opts.updateHistory, "utf8"));
      const pmids = (data.papers || []).map(p => p.pmid).filter(Boolean);
      saveHistory(opts.history, pmids);
      const dois = (data.papers || []).map(p => p.doi).filter(Boolean);
      saveDoiHistory(dois);
      console.error(`[INFO] Updated history: ${pmids.length} PMIDs, ${dois.length} DOIs`);
    }
    return;
  }

  const today = getDateTaipei();
  const dateFilter = `"${getLookbackDate(opts.days)}"[Date - Publication] : "3000"[Date - Publication]`;

  // Dedup sets
  const historyPmids = loadHistory(opts.history);
  const historyDois = loadDoiHistory();
  const seenPmids = new Set(historyPmids);
  const seenDois = new Set(historyDois);

  const allPapers = [];

  // ── Source 1: PubMed ──
  console.error(`\n[Source 1] PubMed — ${PUBMED_QUERIES.length} queries, ${opts.days}-day window`);
  const allPmids = new Set();
  for (let i = 0; i < PUBMED_QUERIES.length; i++) {
    const query = PUBMED_QUERIES[i];
    try {
      const fullQuery = `(${query}) AND ${dateFilter}`;
      const pmids = await searchPapers(fullQuery, 100);
      pmids.forEach(id => allPmids.add(id));
      console.error(`  [Q${i + 1}] ${pmids.length} PMIDs`);
    } catch (e) {
      console.error(`  [Q${i + 1}] FAILED: ${e.message}`);
    }
  }
  console.error(`  PubMed unique: ${allPmids.size}`);
  const newPmids = [...allPmids].filter(id => !seenPmids.has(id));
  console.error(`  After dedup: ${newPmids.length} new`);
  const pubmedPapers = await fetchDetails(newPmids.slice(0, opts.maxPapers));
  for (const p of pubmedPapers) {
    seenPmids.add(p.pmid);
    if (p.doi) seenDois.add(p.doi.toLowerCase());
    allPapers.push(p);
  }
  console.error(`  PubMed added: ${pubmedPapers.length}`);

  // ── Source 2: Crossref ──
  console.error(`\n[Source 2] Crossref — ${CROSSREF_QUERIES.length} queries`);
  for (const q of CROSSREF_QUERIES) {
    const cr = await searchCrossref(q, 50);
    let added = 0;
    for (const p of cr) {
      const doiKey = p.doi?.toLowerCase();
      if (doiKey && seenDois.has(doiKey)) continue;
      if (!p.title || p.title.length < 20) continue;
      const tLower = p.title.toLowerCase();
      if (!tLower.includes("dissociat") && !tLower.includes("depersonal") && !tLower.includes("derealiz") && !tLower.includes("did") && !tLower.includes("identity disorder")) continue;
      if (doiKey) seenDois.add(doiKey);
      allPapers.push(p);
      added++;
    }
    console.error(`  [${q}] ${added} new`);
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Source 3: Semantic Scholar ──
  console.error(`\n[Source 3] Semantic Scholar — ${SEMANTIC_QUERIES.length} queries`);
  for (const q of SEMANTIC_QUERIES) {
    const ss = await searchSemanticScholar(q, 50);
    let added = 0;
    for (const p of ss) {
      const doiKey = p.doi?.toLowerCase();
      if (doiKey && seenDois.has(doiKey)) continue;
      if (p.pmid && seenPmids.has(p.pmid)) continue;
      if (!p.title || p.title.length < 20) continue;
      const tLower = p.title.toLowerCase();
      if (!tLower.includes("dissociat") && !tLower.includes("depersonal") && !tLower.includes("derealiz") && !tLower.includes("identity disorder")) continue;
      if (doiKey) seenDois.add(doiKey);
      if (p.pmid) seenPmids.add(p.pmid);
      allPapers.push(p);
      added++;
    }
    console.error(`  [${q}] ${added} new`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Fallback: expand to 90-day window ──
  if (allPapers.length === 0) {
    console.error(`\n[FALLBACK] No papers found. Expanding to 90-day window...`);
    const broadQuery = PUBMED_QUERIES[0];
    const lookback90 = new Date(Date.now() - 90 * 86400000 + 8 * 3600000);
    const start90 = lookback90.toISOString().slice(0, 10).replace(/-/g, "/");
    const dateFilter90 = `"${start90}"[Date - Publication] : "3000"[Date - Publication]`;
    const ids = await searchPapers(`(${broadQuery}) AND ${dateFilter90}`, 200);
    const newIds = ids.filter(id => !seenPmids.has(id));
    console.error(`  Fallback: ${newIds.length} candidates from 90-day window`);
    const fbPapers = await fetchDetails(newIds.slice(0, 30));
    for (const p of fbPapers) {
      seenPmids.add(p.pmid);
      if (p.doi) seenDois.add(p.doi.toLowerCase());
      allPapers.push(p);
    }
    console.error(`  Fallback added: ${fbPapers.length}`);
  }

  // ── Output ──
  const limited = allPapers.slice(0, opts.maxPapers);
  writeFileSync(opts.output, JSON.stringify({ date: today, count: limited.length, papers: limited }, null, 2));
  console.error(`\n[RESULT] Total: ${allPapers.length}, output: ${limited.length}`);
  console.error(`[INFO] Saved to ${opts.output}`);

  // Save history
  if (limited.length > 0) {
    if (opts.history) {
      const newPmidsList = limited.map(p => p.pmid).filter(Boolean);
      saveHistory(opts.history, newPmidsList);
      const newDoisList = limited.map(p => p.doi).filter(Boolean);
      saveDoiHistory(newDoisList);
      console.error(`[INFO] Updated history files`);
    }
  }
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
});
