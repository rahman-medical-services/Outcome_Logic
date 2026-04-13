// api/study.js
// Consolidated study admin API — replaces study-papers.js, study-output.js, study-run.js.
// Routes via ?resource= query param.
//
// GET    /api/study?resource=papers              → list all papers with extraction status
// POST   /api/study?resource=papers              → add a paper
// PATCH  /api/study?resource=papers&id=<uuid>    → update a paper
// DELETE /api/study?resource=papers&id=<uuid>    → delete a paper
// GET    /api/study?resource=output&id=<uuid>    → get full output_json for one extraction
// POST   /api/study?resource=run                 → run pipeline on a paper

import { createClient } from '@supabase/supabase-js';
import pdfParse         from 'pdf-parse/lib/pdf-parse.js';
import { runPipeline }  from '../lib/pipeline.js';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }  // required for PDF uploads via study-run
};

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase env not configured.');
  return createClient(url, svcKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env not configured.');
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────
async function requireAdmin(req, res) {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken || apiToken !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorised.' });
    return null;
  }
  const bearer = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearer) {
    res.status(401).json({ error: 'No user session.' });
    return null;
  }
  const { data: { user }, error } = await getAnonClient().auth.getUser(bearer);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return null;
  }
  if ((user.user_metadata?.tier || 'free') !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return user;
}

// ─────────────────────────────────────────────
// RESOURCE: papers
// ─────────────────────────────────────────────
async function handlePapers(req, res) {
  const supabase = getAdminClient();
  const { id }   = req.query;

  // GET: list all papers with extraction status
  if (req.method === 'GET') {
    const { data: papers, error } = await supabase
      .from('study_papers')
      .select('*, study_extractions(id, version, source_type, generated_at)')
      .order('phase', { ascending: true })
      .order('added_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const result = (papers || []).map(p => {
      const extractions = p.study_extractions || [];
      return {
        ...p,
        study_extractions: undefined,
        v1_output: extractions.find(o => o.version === 'v1') || null,
        v2_output: extractions.find(o => o.version === 'v2') || null,
      };
    });

    return res.status(200).json({ papers: result });
  }

  // POST: add a paper
  if (req.method === 'POST') {
    const { pmid, title, authors, journal, year, specialty, phase = 0, is_pilot = false } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { data, error } = await supabase
      .from('study_papers')
      .insert({ pmid: pmid || null, title, authors, journal, year, specialty, phase, is_pilot })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ paper: data });
  }

  // PATCH: update a paper (e.g. set/correct PMID)
  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });
    const allowed = ['pmid', 'title', 'authors', 'journal', 'year', 'specialty', 'phase', 'is_pilot', 'status'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });

    const { data, error } = await supabase
      .from('study_papers')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ paper: data });
  }

  // DELETE: remove a paper (cascades to extractions/grades)
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });
    const { error } = await supabase.from('study_papers').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

// ─────────────────────────────────────────────
// RESOURCE: output
// GET /api/study?resource=output&id=<extraction_uuid>
// ─────────────────────────────────────────────
async function handleOutput(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id query param required.' });

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('study_extractions')
    .select('id, paper_id, version, pipeline_version, output_json, source_type, generated_at')
    .eq('id', id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Output not found.' });
  return res.status(200).json({ output: data });
}

// ─────────────────────────────────────────────
// RESOURCE: run
// POST /api/study?resource=run
// Body: { paper_id, version?, force?, pdf_base64? }
// ─────────────────────────────────────────────
const MIN_CHARS = { FULLTEXT: 2000, ABSTRACT: 200 };

async function sourceFromPdf(pdf_base64, paper) {
  const buf  = Buffer.from(pdf_base64, 'base64');
  const data = await pdfParse(buf);
  const text = data.text;
  if (!text || text.length < 500) {
    throw new Error('PDF appears to be empty or image-only — could not extract text.');
  }
  console.log(`[study-run PDF] Extracted ${text.length} chars`);
  return { text, sourceType: 'full-text-pdf', pmid: paper.pmid || null, pmcid: null, doi: null, authors: paper.authors || null };
}

async function fetchFullTextPMC(pmcid, pmid) {
  if (!pmcid) return null;
  try {
    const res  = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml  = await res.text();
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS.FULLTEXT) return null;
    console.log(`[study-run Tier 1] PMC full text: ${text.length} chars`);
    return { text, sourceType: 'full-text-pmc', pmcid, pmid: pmid || null };
  } catch (err) {
    console.log(`[study-run Tier 1] PMC failed: ${err.message}`);
    return null;
  }
}

async function fetchFullTextJina(pmcid) {
  if (!pmcid) return null;
  try {
    const res  = await fetch(`https://r.jina.ai/https://europepmc.org/article/PMC/${pmcid}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.includes('Access Denied') || text.length < 1000) return null;
    console.log(`[study-run Tier 2] Jina/PMC: ${text.length} chars`);
    return { text, sourceType: 'full-text-jina', pmcid };
  } catch (err) {
    console.log(`[study-run Tier 2] Jina failed: ${err.message}`);
    return null;
  }
}

async function fetchAbstract(pmid) {
  try {
    const url     = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`ext_id:${pmid}`)}&resultType=core&format=json`;
    const res     = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data    = await res.json();
    const article = data.resultList?.result?.[0];
    if (!article) return null;
    const abstract = article.abstractText ? article.abstractText.replace(/<[^>]*>?/gm, '') : null;
    if (!abstract || abstract.length < MIN_CHARS.ABSTRACT) return null;
    console.log(`[study-run Tier 4] Abstract: ${abstract.length} chars`);
    const authorList = (article.authorString || '').split(',').map(a => a.trim()).filter(Boolean);
    const authorsStr = authorList.length === 0 ? null
      : authorList.length <= 3 ? authorList.join(', ')
      : authorList.slice(0, 3).join(', ') + ' et al.';
    return {
      text:       `TITLE: ${article.title}\n\n[ABSTRACT ONLY]\n${abstract}`,
      sourceType: 'abstract-only',
      pmid:       article.pmid  || pmid || null,
      pmcid:      article.pmcid || null,
      doi:        article.doi   || null,
      authors:    authorsStr,
    };
  } catch (err) {
    console.log(`[study-run Tier 4] Abstract failed: ${err.message}`);
    return null;
  }
}

async function fetchTrialByPmid(pmid) {
  let meta = { pmid, pmcid: null, doi: null, authors: null };
  try {
    const url  = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`ext_id:${pmid}`)}&resultType=core&format=json`;
    const res  = await fetch(url);
    if (res.ok) {
      const data    = await res.json();
      const article = data.resultList?.result?.[0];
      if (article) {
        const authorList = (article.authorString || '').split(',').map(a => a.trim()).filter(Boolean);
        meta = {
          pmid:    article.pmid  || pmid,
          pmcid:   article.pmcid || null,
          doi:     article.doi   || null,
          authors: authorList.length === 0 ? null
            : authorList.length <= 3 ? authorList.join(', ')
            : authorList.slice(0, 3).join(', ') + ' et al.',
        };
      }
    }
  } catch (err) {
    console.log(`[study-run Meta] ${err.message}`);
  }
  const tier1 = await fetchFullTextPMC(meta.pmcid, meta.pmid);
  if (tier1) return { ...meta, ...tier1 };
  const tier2 = await fetchFullTextJina(meta.pmcid);
  if (tier2) return { ...meta, ...tier2 };
  const tier4 = await fetchAbstract(pmid);
  if (tier4) return { ...meta, ...tier4 };
  return null;
}

async function handleRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { paper_id, version = 'v2', force = false, pdf_base64 } = req.body;
  if (version !== 'v2') return res.status(400).json({ error: 'Only version v2 supported for now.' });
  if (!paper_id && !pdf_base64) return res.status(400).json({ error: 'Provide paper_id or pdf_base64.' });

  const supabase = getAdminClient();
  let paper = null;

  if (paper_id) {
    const { data, error: paperErr } = await supabase
      .from('study_papers')
      .select('*')
      .eq('id', paper_id)
      .single();
    if (paperErr || !data) return res.status(404).json({ error: 'Paper not found.' });
    paper = data;

    if (!pdf_base64 && !paper.pmid) {
      return res.status(400).json({ error: 'No PMID on record. Add a PMID first, or upload a PDF.' });
    }

    if (!force) {
      const { data: existing } = await supabase
        .from('study_extractions')
        .select('id, generated_at, source_type')
        .eq('paper_id', paper_id)
        .eq('version', version)
        .maybeSingle();
      if (existing) {
        return res.status(409).json({
          error: 'Analysis already exists. Pass force: true to overwrite.',
          output_id: existing.id, source_type: existing.source_type, generated_at: existing.generated_at,
        });
      }
    }
  }

  let source;
  if (pdf_base64) {
    console.log(`[study-run] Parsing uploaded PDF`);
    try {
      source = await sourceFromPdf(pdf_base64, paper || {});
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
  } else {
    console.log(`[study-run] Fetching PMID ${paper.pmid}`);
    source = await fetchTrialByPmid(paper.pmid);
    if (!source) {
      return res.status(422).json({
        error: 'Source fetch failed.',
        message: `Could not retrieve content for PMID ${paper.pmid}. Upload a PDF instead.`,
      });
    }
  }

  console.log(`[study-run] Source: ${source.sourceType}, ${source.text.length} chars`);

  let pipelineResult;
  try {
    pipelineResult = await runPipeline(
      source.text,
      {
        sourceType: source.sourceType,
        pmid:       source.pmid    || paper?.pmid    || null,
        pmcid:      source.pmcid   || null,
        doi:        source.doi     || null,
        authors:    source.authors || paper?.authors || null,
      }
    );
  } catch (err) {
    console.error(`[study-run] Pipeline error:`, err.message);
    if ((err.message || '').startsWith('GEMINI_UNAVAILABLE')) {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: `Pipeline failed: ${err.message}` });
  }

  // Mode B: auto-create study_papers row from pipeline output (PDF upload without paper_id)
  if (!paper_id) {
    const rm = pipelineResult.reportMeta   || {};
    const lm = pipelineResult.library_meta || {};
    const { data: newPaper, error: createErr } = await supabase
      .from('study_papers')
      .insert({
        pmid:      rm.pubmed_id    || null,
        title:     lm.display_title || rm.trial_identification || 'Unknown trial',
        authors:   rm.authors      || null,
        journal:   rm.journal      || null,
        year:      rm.year         || null,
        specialty: lm.specialty    || null,
        phase:     0,
        is_pilot:  true,
      })
      .select()
      .single();
    if (createErr) {
      console.error(`[study-run] Paper create error:`, createErr.message);
      return res.status(500).json({ error: `Failed to create paper record: ${createErr.message}` });
    }
    paper = newPaper;
    console.log(`[study-run] Auto-created paper ${paper.id}: ${paper.title}`);
  }

  const { data: output, error: saveErr } = await supabase
    .from('study_extractions')
    .upsert(
      {
        paper_id:     paper.id,
        version,
        output_json:  pipelineResult,
        source_type:  source.sourceType,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'paper_id,version' }
    )
    .select('id, generated_at')
    .single();

  if (saveErr) {
    console.error(`[study-run] Save error:`, saveErr.message);
    return res.status(500).json({ error: `Failed to save output: ${saveErr.message}` });
  }

  console.log(`[study-run] Saved extraction ${output.id} for paper ${paper.id}`);

  return res.status(200).json({
    ok:            true,
    paper_id:      paper.id,
    output_id:     output.id,
    source_type:   source.sourceType,
    display_title: pipelineResult?.library_meta?.display_title || paper.title,
    generated_at:  output.generated_at,
  });
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAdmin(req, res);
  if (!user) return;

  const { resource } = req.query;

  if (resource === 'papers') return handlePapers(req, res);
  if (resource === 'output') return handleOutput(req, res);
  if (resource === 'run')    return handleRun(req, res);

  return res.status(400).json({ error: 'resource param required: papers | output | run' });
}
