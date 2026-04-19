#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const SEARCH_QUERIES = [
  '("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR "multiple personality disorder"[Title/Abstract])',
  '(("Dissociative Disorders"[Mesh] OR dissociative disorder*[Title/Abstract] OR pathological dissociation[Title/Abstract]))',
  '("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR "multiple personality disorder"[Title/Abstract]) AND (trauma[Title/Abstract] OR "childhood trauma"[Title/Abstract] OR PTSD[Title/Abstract] OR "complex PTSD"[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (diagnos*[Title/Abstract] OR assessment[Title/Abstract] OR screening[Title/Abstract] OR prevalence[Title/Abstract] OR misdiagnos*[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (treatment[Title/Abstract] OR psychotherapy[Title/Abstract] OR "phase-oriented"[Title/Abstract] OR EMDR[Title/Abstract] OR "schema therapy"[Title/Abstract] OR DBT[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR pathological dissociation[Title/Abstract])) AND (neuroimaging[Title/Abstract] OR fMRI[Title/Abstract] OR EEG[Title/Abstract] OR biomarker*[Title/Abstract] OR "functional connectivity"[Title/Abstract])',
  '(depersonalization[Title/Abstract] OR derealization[Title/Abstract] OR "somatoform dissociation"[Title/Abstract] OR "identity alteration"[Title/Abstract] OR switching[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR dissociative disorder*[Title/Abstract])) AND ("childhood trauma"[Title/Abstract] OR "childhood abuse"[Title/Abstract] OR maltreatment[Title/Abstract] OR neglect[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (comorbidity[Title/Abstract] OR borderline[Title/Abstract] OR PTSD[Title/Abstract] OR psychosis[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract] OR dissociative disorder*[Title/Abstract])) AND ("self-injury"[Title/Abstract] OR suicid*[Title/Abstract] OR self-harm[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (memory[Title/Abstract] OR autobiographical[Title/Abstract] OR identity[Title/Abstract] OR self-state*[Title/Abstract])',
  '(("dissociative identity disorder"[Title/Abstract] OR DID[Title/Abstract])) AND (review[Publication Type] OR "systematic review"[Title/Abstract] OR "meta-analysis"[Title/Abstract])',
];

const HEADERS = { 'User-Agent': 'DIDBrainBot/1.0 (research aggregator)' };

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: 'papers.json', history: null, updateHistory: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days': opts.days = parseInt(args[++i]); break;
      case '--max-papers': opts.maxPapers = parseInt(args[++i]); break;
      case '--output': opts.output = args[++i]; break;
      case '--history': opts.history = args[++i]; break;
      case '--update-history': opts.updateHistory = args[++i]; break;
    }
  }
  return opts;
}

async function searchPapers(query, retmax = 40) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`PubMed search failed: ${resp.status}`);
  const data = await resp.json();
  return data.esearchresult?.idlist || [];
}

function extractXmlBlock(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function extractFirst(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function parseXmlPapers(xml) {
  const papers = [];
  const articles = xml.split(/<PubmedArticle>/).slice(1);
  for (const raw of articles) {
    const block = raw.split(/<\/PubmedArticle>/)[0];

    const pmid = extractFirst(block, 'PMID');
    const title = extractFirst(block, 'ArticleTitle');

    const abstractParts = [];
    const absRe = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let am;
    while ((am = absRe.exec(block)) !== null) {
      const labelM = am[0].match(/Label="([^"]+)"/);
      const label = labelM ? labelM[1] : '';
      const text = am[1].replace(/<[^>]+>/g, '').trim();
      if (label && text) abstractParts.push(`${label}: ${text}`);
      else if (text) abstractParts.push(text);
    }
    const abstract = abstractParts.join(' ').slice(0, 2000);

    const journal = extractFirst(block, 'Title');

    const year = extractFirst(block, 'Year');
    const month = extractFirst(block, 'Month');
    const day = extractFirst(block, 'Day');
    const dateStr = [year, month, day].filter(Boolean).join(' ');

    const keywords = [];
    const kwRe = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let km;
    while ((km = kwRe.exec(block)) !== null) {
      if (km[1].trim()) keywords.push(km[1].trim());
    }

    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';
    papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
  }
  return papers;
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
  const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`PubMed fetch failed: ${resp.status}`);
  const xml = await resp.text();
  return parseXmlPapers(xml);
}

function loadHistory(path) {
  if (!path || !existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(data.pmids || []);
  } catch {
    return new Set();
  }
}

function saveHistory(path, pmids) {
  if (!path) return;
  const existing = loadHistory(path);
  const all = [...new Set([...existing, ...pmids])];
  writeFileSync(path, JSON.stringify({ pmids: all, updated: new Date().toISOString() }, null, 2));
}

function getDateTaipei() {
  const now = new Date(Date.now() + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

function getLookbackDate(days) {
  const d = new Date(Date.now() - days * 86400000 + 8 * 3600000);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

async function main() {
  const opts = parseArgs();

  if (opts.updateHistory) {
    if (opts.history && existsSync(opts.updateHistory)) {
      const data = JSON.parse(readFileSync(opts.updateHistory, 'utf8'));
      const pmids = (data.papers || []).map(p => p.pmid).filter(Boolean);
      saveHistory(opts.history, pmids);
      console.error(`[INFO] Updated history with ${pmids.length} PMIDs`);
    }
    return;
  }

  console.error(`[INFO] Searching PubMed for DID papers from last ${opts.days} days...`);

  const lookback = getLookbackDate(opts.days);
  const dateFilter = `"${lookback}"[Date - Publication] : "3000"[Date - Publication]`;

  const allPmids = new Set();
  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    const query = SEARCH_QUERIES[i];
    try {
      const fullQuery = `(${query}) AND ${dateFilter}`;
      const pmids = await searchPapers(fullQuery, opts.maxPapers);
      pmids.forEach(id => allPmids.add(id));
      console.error(`[INFO] Query ${i + 1}/${SEARCH_QUERIES.length}: ${pmids.length} PMIDs (total unique: ${allPmids.size})`);
    } catch (e) {
      console.error(`[WARN] Query ${i + 1} failed: ${e.message}`);
    }
  }

  console.error(`[INFO] Found ${allPmids.size} unique PMIDs total`);

  const history = loadHistory(opts.history);
  const newPmids = [...allPmids].filter(id => !history.has(id));
  console.error(`[INFO] After dedup: ${newPmids.length} new papers (history: ${history.size})`);

  if (!newPmids.length) {
    console.error('[INFO] No new papers found');
    writeFileSync(opts.output, JSON.stringify({ date: getDateTaipei(), count: 0, papers: [] }, null, 2));
    return;
  }

  const limited = newPmids.slice(0, opts.maxPapers);
  const papers = await fetchDetails(limited);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  writeFileSync(opts.output, JSON.stringify({ date: getDateTaipei(), count: papers.length, papers }, null, 2));
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
});
