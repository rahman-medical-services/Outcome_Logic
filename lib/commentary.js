// lib/commentary.js
// Node 4: Expert Context & Commentary Search
//
// Runs in parallel with Node 3 (adjudicator). Never throws — all failures
// return a graceful status object so the main pipeline is never affected.
//
// Flow:
//   Step 0  — ID mini-call (PDF inputs only): extract trial identity from reportA
//   Step 1  — PMID resolution via Europe PMC (skipped if PMID already known)
//   Step 2  — Citations fetch from Europe PMC citations API
//   Step 3  — Score, gate, filter, fetch abstracts in parallel
//   Step 4  — Synthesis call (only fires if gate passes)

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI       = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = 'gemini-2.5-flash-lite';  // lightweight model for Node 4 synthesis calls
const EPMC_BASE    = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

// Gate constants — tune these if scoring needs adjustment
const MEANINGFUL_THRESHOLD        = 3;  // minimum score for citation items
const MEANINGFUL_THRESHOLD_NAMED  = 1;  // lower threshold for name-search items (inherently relevant)
const MIN_ITEMS_FOR_SYNTHESIS = 2;  // need at least this many qualifying items
const MAX_ITEMS_TO_FETCH      = 15; // abstract fetch cap — increased to capture more commentary
const ABSTRACT_CHAR_CAP       = 1200;
const CITATIONS_PAGE_SIZE     = 100;
const NODE4_TIMEOUT_MS        = 45000;

// ─────────────────────────────────────────────
// MAIN EXPORT
// Wraps the full Node 4 flow with a hard timeout and top-level catch.
// Called from pipeline.js in parallel with the adjudicator.
// ─────────────────────────────────────────────
export async function fetchExpertContext(sourceMeta, reportA) {
  const result = await Promise.race([
    _runCommentaryFlow(sourceMeta, reportA),
    new Promise(resolve =>
      setTimeout(() => resolve({ status: 'error', reason: 'timeout' }), NODE4_TIMEOUT_MS)
    ),
  ]).catch(err => {
    console.warn('[Node 4] Uncaught error:', err.message);
    return { status: 'error', reason: err.message };
  });

  return result;
}

// ─────────────────────────────────────────────
// INTERNAL FLOW ORCHESTRATOR
// ─────────────────────────────────────────────
async function _runCommentaryFlow(sourceMeta, reportA) {

  // ── Step 0: resolve PMID ─────────────────────────────────────────────────
  let pmid        = sourceMeta.pmid  || null;
  let doi         = sourceMeta.doi   || null;
  let searchBasis = 'known_pmid';

  if (!pmid && !doi && sourceMeta.sourceType === 'full-text-pdf') {
    const identity = _extractIdentityFromReport(reportA);
    if (identity?.pmid) {
      pmid        = identity.pmid;
      searchBasis = 'resolved_from_pdf';
      console.log(`[Node 4] Using PMID from report text: ${pmid}`);
    } else if (identity?.doi) {
      doi         = identity.doi;
      searchBasis = 'doi_resolved';
      console.log(`[Node 4] Using DOI from report text: ${doi}`);
    } else if (identity?.trial_name && identity?.year) {
      pmid = await _resolvePmidViaPubMed(identity.trial_name, identity.year);
      if (pmid) {
        searchBasis = 'resolved_from_pubmed';
        console.log(`[Node 4] PMID resolved via PubMed Entrez: ${pmid}`);
      } else {
        console.log('[Node 4] PubMed resolution failed — returning pmid_unresolved');
        return { status: 'pmid_unresolved' };
      }
    } else {
      console.log('[Node 4] No identifier found — returning pmid_unresolved');
      return { status: 'pmid_unresolved' };
    }
    // Store full title for web synthesis if available
    if (identity?.full_title) sourceMeta = { ...sourceMeta, trialTitle: identity.full_title };
    if (identity?.trial_name) sourceMeta = { ...sourceMeta, trialName: identity.trial_name };
  }

  // If we have a DOI but no PMID, resolve PMID from DOI
  if (!pmid && doi) {
    pmid = await _resolvePmidFromDoi(doi);
    if (!pmid) {
      console.log('[Node 4] DOI resolution failed — returning pmid_unresolved');
      return { status: 'pmid_unresolved' };
    }
    searchBasis = 'doi_resolved';
  }

  if (!pmid) {
    return { status: 'pmid_unresolved' };
  }

  // ── Step 2: fetch citations AND supplementary name search in parallel ────────
  // Citations: papers that formally cite this trial (good for established papers)
  // Name search: papers that mention the trial by name (catches concurrent
  //   editorials, invited commentaries, and letters published in same issue
  //   which never formally cite the paper they respond to)
  const trialName = _extractTrialName(sourceMeta, reportA);

  const [{ hitCount, citations }, nameResults, pubmedResults] = await Promise.all([
    _fetchCitations(pmid),
    trialName ? _searchByTrialName(trialName, pmid) : Promise.resolve([]),
    trialName ? _searchPubMed(trialName, pmid)      : Promise.resolve([]),
  ]);

  if (!citations || citations.length === 0) {
    const recencyNote = _isVeryRecent(sourceMeta);
    console.log(`[Node 4] No citations found for PMID ${pmid}`);
    return {
      status:                  'not_found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount || 0,
      items_reviewed:          0,
      items:                   [],
      synthesis:               null,
      recency_note:            recencyNote,
    };
  }

  // Merge name search and PubMed results — deduplicate by PMID
  const seenPmids = new Set(citations.map(c => c.id || c.pmid));
  const merged = [...citations];

  for (const r of [...nameResults, ...pubmedResults]) {
    const id = r.id || r.pmid;
    if (id && !seenPmids.has(String(id))) {
      merged.push({ ...r, _from_name_search: true });
      seenPmids.add(String(id));
    }
  }

  if (nameResults.length > 0 || pubmedResults.length > 0) {
    console.log(`[Node 4] Supplementary search added ${merged.length - citations.length} new items (Europe PMC name: ${nameResults.length}, PubMed: ${pubmedResults.length})`);
  }

  // ── Step 3: score, gate, fetch abstracts ─────────────────────────────────
  const scored = merged
    .map(c => ({ ...c, _score: _scoreCitation(c) }))
    .filter(c => c._from_name_search
      ? c._score >= MEANINGFUL_THRESHOLD_NAMED   // name-search items: lower bar, already relevant
      : c._score >= MEANINGFUL_THRESHOLD          // citation items: normal threshold
    )
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_ITEMS_TO_FETCH);

  if (scored.length < MIN_ITEMS_FOR_SYNTHESIS) {
    const recencyNote = _isVeryRecent(sourceMeta);
    console.log(`[Node 4] Gate not passed — only ${scored.length} meaningful items (need ${MIN_ITEMS_FOR_SYNTHESIS})`);
    return {
      status:                  'not_found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount,
      items_reviewed:          0,
      items:                   [],
      synthesis:               null,
      recency_note:            recencyNote,
    };
  }

  // Fetch abstracts for all qualifying items in parallel
  const withAbstracts = await Promise.all(
    scored.map(c => _fetchAbstract(c.id || c.pmid).then(abstract => ({ ...c, abstract })))
  );

  // ── Relevance filter ─────────────────────────────────────────────────────
  // For well-cited trials (>200 citations), most citing papers mention the trial
  // only as a background reference. Filter to papers whose abstract actually
  // discusses the trial specifically — by trial name or first author surname.
  // This prevents MATTERHORN commentary appearing in an FNCLCC report.
  const trialNameForFilter = sourceMeta.trialName || _extractTrialName(sourceMeta, reportA);
  const firstAuthor        = _extractFirstAuthorSurname(reportA);

  let relevantItems = withAbstracts;
  if (hitCount > 200 && (trialNameForFilter || firstAuthor)) {
    const keywords = [
      trialNameForFilter?.toLowerCase(),
      firstAuthor?.toLowerCase(),
    ].filter(Boolean);

    const filtered = withAbstracts.filter(item => {
      // Always keep name-search items — they were found by trial name search
      if (item._from_name_search) return true;
      // Keep if abstract or title contains a trial-specific keyword
      const haystack = `${(item.title || '')} ${(item.abstract || '')}`.toLowerCase();
      return keywords.some(kw => haystack.includes(kw));
    });

    console.log(`[Node 4] Relevance filter (${hitCount} citations): ${withAbstracts.length} → ${filtered.length} items mention the trial`);
    relevantItems = filtered.length >= MIN_ITEMS_FOR_SYNTHESIS ? filtered : withAbstracts;
  }

  // ── Step 4: synthesis call ────────────────────────────────────────────────
  // Build the best trial identifier we have for web search grounding.
  // Priority: full title from sourceMeta > extracted trial name > null
  const trialTitle      = sourceMeta.trialTitle || null;
  const trialIdentifier = trialTitle
    ? `${trialNameForFilter ? trialNameForFilter + ' — ' : ''}${trialTitle}`
    : trialNameForFilter || null;

  const synthesisResult = await _runSynthesis(relevantItems, trialNameForFilter, trialIdentifier);

  if (!synthesisResult) {
    // Synthesis Gemini call failed to parse — return items without synthesis
    return {
      status:                  'found',
      pmid_used:               pmid,
      search_basis:            searchBasis,
      total_citations_indexed: hitCount,
      items_reviewed:          withAbstracts.length,
      items:                   [],
      synthesis:               null,
      recency_note:            false,
    };
  }

  console.log(`[Node 4] Complete — ${synthesisResult.items?.length || 0} items, synthesis: ${synthesisResult.synthesis ? 'yes' : 'null'}`);

  return {
    status:                  'found',
    pmid_used:               pmid,
    search_basis:            searchBasis,
    total_citations_indexed: hitCount,
    items_reviewed:          withAbstracts.length,
    items:                   synthesisResult.items   || [],
    synthesis:               synthesisResult.synthesis || null,
    recency_note:            false,
  };
}

// ─────────────────────────────────────────────
// STEP 0: ID EXTRACTION FROM EXTRACTOR OUTPUT
// Parses trial identity directly from reportA using regex.
// No Gemini call — the extractor output has predictable structure.
// Returns null if nothing useful found.
// ─────────────────────────────────────────────
function _extractIdentityFromReport(reportA) {
  if (!reportA) return null;

  try {
    const text = reportA.slice(0, 4000);

    // ── PMID — look for explicit "PMID:" or "PubMed ID:" patterns ──────────
    const pmidMatch = text.match(/(?:PMID|PubMed\s*ID)\s*[:\-]?\s*(\d{7,8})/i);
    const pmid      = pmidMatch?.[1] || null;

    // ── DOI — allow parentheses for Lancet-style DOIs e.g. S0140-6736(20)31444-6
    const doiMatch = text.match(/(?:DOI|doi)\s*[:\-]?\s*(10\.\d{4,}\/\S+)/i)
                  || text.match(/https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/i)
                  || text.match(/\b(10\.\d{4,}\/[^\s,;"']{4,})/);
    const doi      = doiMatch?.[1]?.replace(/[,\.\]"'>]+$/, '') || null;

    // ── Trial name — match bullet-format extractor output ──────────────────
    // Extractor writes bullets like:
    //   - Full trial name and acronym: HALT-IT (...)
    //   - Full trial name: HALT-IT
    // Also catches inline "HALT-IT trial" patterns in the text
    let trial_name = null;
    const FALSE_POSITIVES = new Set([
      'NOT', 'NULL', 'NONE', 'UNKNOWN', 'TRIAL', 'STUDY', 'GROUP',
      'RESULTS', 'METHODS', 'PATIENTS', 'DESIGN', 'ABSTRACT', 'PURPOSE',
      'BACKGROUND', 'CONCLUSION', 'INTRODUCTION', 'DISCUSSION', 'TABLE',
      'FIGURE', 'APPENDIX', 'FUNDING', 'AUTHORS', 'ETHICS', 'DATA',
    ]);

    const namePatterns = [
      /[-–]\s*(?:full\s+trial\s+name(?:\s+and\s+acronym)?|trial\s+name(?:\s+and\s+acronym)?)\s*[:\-]\s*([^\n]{3,80})/i,
      /(?:trial\s+name|acronym)\s*[:\-]\s*([^\n]{3,60})/i,
      /\b([A-Z][A-Z0-9\-]{2,15}(?:-[A-Z0-9]+)?)\b(?=\s+trial|\s+Trial)/,  // "HALT-IT trial" not just "TRIAL"
    ];
    for (const re of namePatterns) {
      const m = text.match(re);
      const candidate = m?.[1]?.trim().replace(/\.$/, '');
      if (candidate && !FALSE_POSITIVES.has(candidate.toUpperCase())) {
        trial_name = candidate;
        break;
      }
    }

    // ── First author surname ────────────────────────────────────────────────
    // Extractor writes: "- Authors: Surname INITIALS, Surname INITIALS et al."
    let first_author_surname = null;
    const authorMatch = text.match(/[-–]\s*Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i)
                     || text.match(/Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i);
    if (authorMatch?.[1]) first_author_surname = authorMatch[1].trim();

    // ── Year ────────────────────────────────────────────────────────────────
    // Look for "Year: YYYY", "published: YYYY", or any 20XX near journal context
    let year = null;
    const yearMatch = text.match(/[-–]\s*(?:year|published|publication\s*year)\s*[:\-]?\s*(\b20[0-2]\d\b)/i)
                   || text.match(/(?:year|published|publication)\s*[:\-]?\s*(\b20[0-2]\d\b)/i)
                   || text.match(/\b(20[0-2]\d)\b/);
    if (yearMatch?.[1]) year = yearMatch[1];

    // Strip literal "null" strings the extractor sometimes writes
    const clean = v => (v === 'null' || v === 'Not reported' || v === 'N/A') ? null : v;

    const cleanPmid = clean(pmid);
    const cleanDoi  = clean(doi);
    const cleanName = clean(trial_name);
    const cleanAuth = clean(first_author_surname);
    const cleanYear = clean(year);

    // Return null if nothing useful
    if (!cleanName && !cleanPmid && !cleanDoi) {
      console.log('[Node 4] ID extraction: nothing found in reportA');
      return null;
    }

    // ── Full title — extract for web search grounding ───────────────────────
    // The extractor writes the full paper title early in output
    let full_title = null;
    const titleMatch = text.match(/[-–]\s*(?:full\s+(?:paper\s+)?title|paper\s+title)\s*[:\-]\s*([^\n]{10,200})/i)
                    || text.match(/^(?:title|paper)\s*[:\-]\s*([^\n]{10,200})/im);
    if (titleMatch?.[1]?.trim()) {
      full_title = titleMatch[1].trim().replace(/\.$/, '');
    }

    console.log(`[Node 4] ID extraction: trial="${cleanName}", author="${cleanAuth}", year="${cleanYear}", pmid="${cleanPmid}", doi="${cleanDoi}"`);
    return { trial_name: cleanName, first_author_surname: cleanAuth, year: cleanYear, pmid: cleanPmid, doi: cleanDoi, full_title };

  } catch (err) {
    console.warn('[Node 4] ID extraction failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 1b: RESOLVE PMID FROM DOI
// ─────────────────────────────────────────────
async function _resolvePmidFromDoi(doi) {
  try {
    // Try direct DOI query first
    const url = `${EPMC_BASE}/search?query=DOI:"${encodeURIComponent(doi)}"&resultType=core&pageSize=3&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC DOI search HTTP ${res.status}`);

    const data = await res.json();
    let pmid   = data.resultList?.result?.[0]?.pmid || null;

    // Fallback: strip parenthetical version suffix common in Lancet DOIs
    // e.g. S1470-2045(25)00027-0 → try without the (25) part
    if (!pmid && doi.includes('(')) {
      const stripped = doi.replace(/\(\d{2}\)/g, '');
      const url2     = `${EPMC_BASE}/search?query=DOI:"${encodeURIComponent(stripped)}"&resultType=core&pageSize=3&format=json`;
      const res2     = await fetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        pmid = data2.resultList?.result?.[0]?.pmid || null;
      }
    }

    if (pmid) console.log(`[Node 4] PMID resolved from DOI: ${pmid}`);
    return pmid;

  } catch (err) {
    console.warn('[Node 4] PMID resolution from DOI failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 1c: RESOLVE PMID VIA PUBMED ENTREZ
// Used when trial name + year known but no DOI/PMID in PDF text.
// Searches Title/Abstract field — reliable for named trials.
// Validates result against year to avoid returning wrong paper.
// ─────────────────────────────────────────────
async function _resolvePmidViaPubMed(trialName, year) {
  try {
    const ENTREZ_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

    // Search by trial name in title/abstract + publication year
    const term = `"${trialName}"[Title/Abstract] AND ${year}[PDAT]`;
    const searchUrl = `${ENTREZ_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=5&sort=relevance&retmode=json`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const pmids = searchData.esearchresult?.idlist || [];
    if (pmids.length === 0) return null;

    // Take first result — sorted by relevance, and year-constrained
    // so false positives are very unlikely for named trials
    const pmid = pmids[0];
    console.log(`[Node 4] PubMed Entrez resolved "${trialName}" (${year}) → PMID ${pmid} (${pmids.length} candidates)`);
    return pmid;

  } catch (err) {
    console.warn('[Node 4] PubMed Entrez resolution failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 2: FETCH CITATIONS
// Uses Europe PMC citations endpoint.
// Returns { hitCount, citations[] } or { hitCount: 0, citations: [] } on failure.
// ─────────────────────────────────────────────
async function _fetchCitations(pmid) {
  try {
    const url = `${EPMC_BASE}/MED/${pmid}/citations?page=1&pageSize=${CITATIONS_PAGE_SIZE}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Europe PMC citations HTTP ${res.status}`);

    const data      = await res.json();
    const hitCount  = data.hitCount || 0;
    const citations = data.citationList?.citation || [];

    console.log(`[Node 4] Citations for PMID ${pmid}: ${hitCount} total, ${citations.length} fetched`);
    return { hitCount, citations };

  } catch (err) {
    console.warn('[Node 4] Citations fetch failed:', err.message);
    return { hitCount: 0, citations: [] };
  }
}

// ─────────────────────────────────────────────
// STEP 2b: EXTRACT TRIAL NAME FOR NAME SEARCH
// Gets the trial acronym/name from sourceMeta or reportA.
// Used to find concurrent editorials that don't formally cite the paper.
// ─────────────────────────────────────────────
function _extractTrialName(sourceMeta, reportA) {
  if (reportA) {
    const identity = _extractIdentityFromReport(reportA);
    const name = identity?.trial_name;
    if (name && name !== 'null' && name.length >= 3 && name.length <= 40) {
      // Skip if it looks like an institution/federation name rather than a trial acronym.
      // Institution acronyms tend to be all-caps with no hyphen and often expand to
      // organisation names in the paper text. Simple heuristic: if the name contains
      // common institution suffixes or is known to be one, skip it.
      const institutionPatterns = /^(FNCLCC|FFCD|EORTC|ESMO|ASCO|NICE|NCCN|ECOG|SWOG|RTOG|NCI|NCIC|MRC|NSABP)$/i;
      if (institutionPatterns.test(name.trim())) {
        console.log(`[Node 4] Skipping name search — "${name}" is an institution, not a trial acronym`);
        return null;
      }
      return name;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// STEP 2c: SUPPLEMENTARY NAME SEARCH
// Searches Europe PMC for papers mentioning the trial by name.
// Catches editorials, letters, and invited commentaries published
// in the same journal issue that never formally cite the paper.
// Returns array of result objects (same shape as citation objects).
// ─────────────────────────────────────────────
async function _searchByTrialName(trialName, pmid) {
  try {
    const currentYear = new Date().getFullYear();
    const fromYear    = currentYear - 3;

    // Full-text search for the phrase "SANO trial" — finds papers that mention
    // the trial in body text, not just title. More permissive than TITLE: but
    // specific enough when combined with the trial name + "trial" suffix.
    const phrase = trialName.toLowerCase().includes('trial')
      ? `"${trialName}"`
      : `"${trialName} trial"`;
    const query = `${phrase} AND FIRST_PDATE:[${fromYear} TO ${currentYear}]`;
    const url = `${EPMC_BASE}/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=50&format=json`;
    const res   = await fetch(url);
    if (!res.ok) return [];

    const data    = await res.json();
    const results = data.resultList?.result || [];

    // Filter out the trial paper itself
    const filtered = results.filter(r =>
      r.pmid &&
      r.pmid !== pmid &&
      r.pmid !== String(pmid)
    );

    console.log(`[Node 4] Name search ${phrase}: ${results.length} results, ${filtered.length} usable`);
    return filtered;

  } catch (err) {
    console.warn('[Node 4] Name search failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// STEP 2d: PUBMED ENTREZ SEARCH
// PubMed indexes faster than Europe PMC citation graphs.
// Searches for the trial name in Title/Abstract, returns PMIDs,
// converts to stub objects for scoring + abstract fetching.
// ─────────────────────────────────────────────
async function _searchPubMed(trialName, pmid) {
  try {
    const ENTREZ_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

    const phrase = trialName.toLowerCase().includes('trial')
      ? `"${trialName}"`
      : `"${trialName} trial"`;
    const term = `${phrase}[Title/Abstract]`;

    const searchUrl = `${ENTREZ_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=25&sort=relevance&retmode=json`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json();
    const pmids = (searchData.esearchresult?.idlist || [])
      .filter(id => id !== String(pmid));

    if (pmids.length === 0) return [];
    console.log(`[Node 4] PubMed search ${phrase}: found ${pmids.length} PMIDs`);

    // Fetch summaries for all PMIDs in one call
    const summaryUrl = `${ENTREZ_BASE}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`;
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) return [];

    const summaryData = await summaryRes.json();
    const uids = summaryData.result?.uids || [];

    return uids.map(uid => {
      const r = summaryData.result[uid];
      if (!r) return null;

      const authors = (r.authors || [])
        .slice(0, 3).map(a => a.name).join(', ')
        + (r.authors?.length > 3 ? ' et al.' : '');

      return {
        id:                  uid,
        pmid:                uid,
        title:               r.title || '',
        authorString:        authors,
        journalAbbreviation: r.fulljournalname || r.source || '',
        pubYear:             r.pubdate ? r.pubdate.slice(0, 4) : null,
        pubType:             r.pubtype?.[0] || '',
      };
    }).filter(Boolean);

  } catch (err) {
    console.warn('[Node 4] PubMed search failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// Returns a numeric score 0–14. Items scoring below MEANINGFUL_THRESHOLD
// are excluded before the gate check.
// ─────────────────────────────────────────────
function _scoreCitation(citation) {
  let score = 0;
  const title   = (citation.title || '').toLowerCase();
  const pubType = (citation.pubType || citation.pubTypeList?.pubType || '').toString().toLowerCase();

  // High-value commentary signals in title
  if (title.includes('comment')     || title.includes('commentary'))   score += 4;
  if (title.includes('editorial'))                                      score += 4;
  if (title.includes('critique')    || title.includes('critical'))     score += 4;
  if (title.includes('reanalysis')  || title.includes('re-analysis'))  score += 4;
  if (title.includes('letter'))                                         score += 3;
  if (title.includes('meta-analysis') || title.includes('systematic')) score += 3;
  if (title.includes('guideline')   || title.includes('consensus'))    score += 3;
  if (title.includes('response')    || title.includes('reply'))        score += 2;
  if (title.includes('review'))                                         score += 2;
  if (title.includes('update')      || title.includes('revisit'))      score += 2;

  // pubType signal — primary research papers score 0 on title signals but are
  // still high-value follow-up evidence; prevent them being excluded at the gate.
  // Meta-analyses and systematic reviews get an extra boost even without title keywords.
  if (pubType.includes('meta-analysis'))                               score += 3;
  if (pubType.includes('systematic review'))                           score += 3;
  if (pubType.includes('randomized controlled trial') ||
      pubType.includes('randomised controlled trial'))                  score += 2;
  if (pubType.includes('clinical trial'))                              score += 1;
  if (pubType.includes('practice guideline'))                          score += 3;

  // Recency bonus
  const age = new Date().getFullYear() - parseInt(citation.pubYear || '2000');
  if (age <= 2) score += 3;
  else if (age <= 5) score += 1;

  return score;
}

// ─────────────────────────────────────────────
// STEP 3b: FETCH ABSTRACT FOR A SINGLE PMID
// Returns abstract string (capped) or null.
// ─────────────────────────────────────────────
async function _fetchAbstract(pmid) {
  if (!pmid) return null;
  try {
    const url = `${EPMC_BASE}/search?query=ext_id:${pmid}&resultType=core&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data     = await res.json();
    const article  = data.resultList?.result?.[0];
    if (!article)  return null;

    const raw = (article.abstractText || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return raw.length > 0 ? raw.slice(0, ABSTRACT_CHAR_CAP) : null;

  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 4a: CATEGORISE ITEMS
// Uses Europe PMC abstracts to classify each citing paper.
// Returns array of typed items or null on failure.
// ─────────────────────────────────────────────
async function _categoriseItems(itemsWithAbstracts) {
  try {
    const model = genAI.getGenerativeModel({
      model:             GEMINI_MODEL,
      systemInstruction: `You are an expert clinical appraiser. Categorise each citing paper.
Always respond with valid JSON only. No preamble, no explanation, no markdown fences.`,
    });

    const citingPapersText = itemsWithAbstracts.map(item => [
      '---',
      `PMID: ${item.id || item.pmid || 'unknown'}`,
      `Authors: ${item.authorString || 'Unknown'}`,
      `Journal: ${item.journalAbbreviation || item.journal || 'Unknown'} (${item.pubYear || 'Unknown'})`,
      `Title: ${item.title || 'Unknown'}`,
      `Abstract: ${item.abstract || 'Not available'}`,
    ].join('\n')).join('\n\n');

    const prompt = `Categorise each of the following papers that cite a clinical trial.

CITING PAPERS:
${citingPapersText}

Return ONLY this JSON, no preamble, no markdown:
{
  "items": [
    {
      "pmid": "string",
      "authors": "Surname A, Surname B et al.",
      "journal": "string",
      "year": "string",
      "type": "critique | supporting_commentary | related_trial | meta_analysis | guideline_citation | reanalysis | other",
      "title": "string",
      "summary": "One sentence — the single most important point this paper makes about the trial. If abstract is not available, describe what the paper likely addresses based on its title."
    }
  ]
}

RULES FOR type:
- "critique": invited commentaries, editorials, letters questioning or critically appraising the trial
- "supporting_commentary": commentaries endorsing or contextualising the trial
- "meta_analysis": systematic reviews or meta-analyses including this trial
- "guideline_citation": clinical guidelines or consensus statements citing this trial
- "related_trial": subsequent trials testing similar interventions
- "reanalysis": papers re-analysing the original trial data
- If abstract unavailable, classify from title. "Invited Commentary" = critique. "Comment"/"Letter" = critique.`;

    const result = await model.generateContent({
      contents:         [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, thinkingConfig: { thinkingBudget: 0 } },
    });

    const text  = result.response.text();
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed?.items) return null;

    const validTypes = new Set([
      'critique', 'supporting_commentary', 'related_trial',
      'meta_analysis', 'guideline_citation', 'reanalysis', 'other',
    ]);
    parsed.items = parsed.items.map(item => ({
      ...item,
      type: validTypes.has(item.type) ? item.type : 'other',
    }));

    return parsed.items;

  } catch (err) {
    console.warn('[Node 4] Item categorisation failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 4b: WEB-SEARCH SYNTHESIS
// Uses Gemini's native Google Search grounding to write a synthesis
// paragraph. Gemini searches for the trial by full title and name,
// grounding its output in real web results rather than parametric memory.
// Returns synthesis string or null on failure.
// ─────────────────────────────────────────────
async function _runWebSearchSynthesis(trialName, trialTitle, itemsWithAbstracts) {
  try {
    // Build identifier for the search — use full title if we have it
    const searchIdentifier = trialTitle || trialName || 'this clinical trial';

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      tools: [{ googleSearch: {} }],
      systemInstruction: `You are an expert clinical academic writing a concise evidence context paragraph 
for a clinical trial database. You have access to Google Search — use it to find post-publication 
commentary, critiques, meta-analyses, and guideline citations for the trial.

CRITICAL RULES:
- Search for the trial by name and full title to find real published responses
- Only state what you can verify from your search results
- Attribute specific criticisms or endorsements to named authors and their publications
- Do NOT restate what the trial itself found — focus on how others have responded to it
- Do NOT hallucinate statistics, author names, or journal names
- Write in plain clinical English, past tense, 3-5 sentences
- If search results are sparse, write fewer sentences rather than speculating`,
    });

    // Also provide the Europe PMC items as additional context
    const abstractContext = itemsWithAbstracts
      .filter(i => i.abstract)
      .slice(0, 5)
      .map(i => `- ${i.authorString || 'Unknown'} (${i.pubYear || ''}): ${i.title}`)
      .join('\n');

    const prompt = `Write a 3-5 sentence evidence context paragraph for the following specific clinical trial:

TRIAL NAME/ACRONYM: ${trialName || 'unknown'}
FULL TITLE: ${searchIdentifier}

CRITICAL: You must search for and write ONLY about THIS specific trial — not any other trial.
If your search returns results about a different trial, ignore them entirely.

Use Google Search to find post-publication commentary, critiques, and guidelines citing this trial.
Also consider these known citing papers for additional context:
${abstractContext || '(none available)'}

Write ONLY the synthesis paragraph — no JSON, no headers, no preamble.
Start directly with the content, e.g. "The [trial name] has been..."
If you cannot find reliable information specifically about this trial, write: "Post-publication commentary for this trial is not yet available in indexed sources."`;

    const result = await model.generateContent({
      contents:         [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
    });

    const synthesis = result.response.text()?.trim();
    if (!synthesis || synthesis.length < 50) return null;

    console.log('[Node 4] Web-search synthesis complete');
    return synthesis;

  } catch (err) {
    console.warn('[Node 4] Web-search synthesis failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 4: SYNTHESIS — combines item categorisation + web synthesis
// ─────────────────────────────────────────────
async function _runSynthesis(itemsWithAbstracts, trialName, trialTitle) {
  // Run item categorisation and web synthesis in parallel
  const [items, synthesis] = await Promise.all([
    _categoriseItems(itemsWithAbstracts),
    _runWebSearchSynthesis(trialName, trialTitle, itemsWithAbstracts),
  ]);

  if (!items) return null;

  return {
    items,
    synthesis: synthesis || null,
  };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Returns true if trial was published within the last 12 months.
function _isVeryRecent(sourceMeta) {
  const year = parseInt(sourceMeta.year || '0');
  if (!year) return false;
  return (new Date().getFullYear() - year) < 1;
}

// Extracts first author surname from extractor output for relevance filtering.
function _extractFirstAuthorSurname(reportA) {
  if (!reportA) return null;
  const text = reportA.slice(0, 3000);
  const m = text.match(/[-–]\s*Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i)
         || text.match(/Authors?\s*[:\-]\s*([A-Z][a-züöäßé\-']{1,30})/i);
  return m?.[1]?.trim() || null;
}