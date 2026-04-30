// api/validation.js
//
// Validation study API — Phase 1a (manual blinded MA extraction).
// Phase 2a/2b and Phase 3 actions will be added in subsequent sessions.
//
// Auth model:
//   - x-api-token  header must equal INTERNAL_API_TOKEN (CSRF gate, same
//                  pattern as api/study.js / api/study-grade.js).
//   - x-rater-id and x-rater-passphrase headers identify the rater.
//     Validated against validation_raters table on every request.
//     Stateless; no JWT, no Supabase auth — closed 6-rater study.
//
// Blinding:
//   - phase1a_extractions and phase1a_sessions reads are filtered to
//     the calling rater's own rows by default.
//   - The "view other rater" action is only allowed once both raters
//     for the paper have submitted (locked = true).
//
// Endpoints (all action-dispatched via ?action=…):
//   GET  ?action=fields                          → MA_FIELDS list (public to logged-in raters)
//   POST ?action=login                           → validate passphrase, return rater info
//   GET  ?action=papers                          → papers assigned to this rater for Phase 1a
//   GET  ?action=session&paper_id=…              → fetch/create Phase 1a session + own extractions
//   POST ?action=field_save                      → upsert one field; sets started_at on first write
//   POST ?action=session_submit                  → lock session, compute time_seconds
//   GET  ?action=other_rater&paper_id=…          → other rater's extractions (only if both locked)
//
// All POST bodies are JSON.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
  MA_FIELDS, MA_FIELD_IDS,
  NON_MA_FIELDS, NON_MA_FIELD_IDS,
  MATCH_STATUSES, TAXONOMY, PIPELINE_SECTIONS, ROOT_CAUSE_STAGES,
  extractPipelineValues, stripInternalFields,
} from '../lib/validation-fields.js';
import { buildMergedJson, buildPhase3FieldRows } from '../lib/validation-merge.js';
import { runPipelineV4 } from '../lib/pipeline-v4.js';
import { buildSourceContext } from '../lib/pipeline.js';
import pdfParse from 'pdf-parse';

// 12 MB cap accommodates PDFs up to ~9 MB raw after base64 inflation.
// For larger PDFs, paste an external URL into pdf_url instead.
export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } }
};

const PDF_BUCKET = 'validation-pdfs';

// ─────────────────────────────────────────────
// Supabase client (service role — bypasses RLS)
// ─────────────────────────────────────────────
function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase env not configured.');
  return createClient(url, svcKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────
function requireApiToken(req, res) {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken || apiToken !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorised — invalid API token.' });
    return false;
  }
  return true;
}

async function authenticateRater(req, res, supabase) {
  const raterId     = req.headers['x-rater-id'];
  const passphrase  = req.headers['x-rater-passphrase'];
  if (!raterId || !passphrase) {
    res.status(401).json({ error: 'Missing rater credentials.' });
    return null;
  }
  const { data, error } = await supabase
    .from('validation_raters')
    .select('rater_id, display_name, pair, role, is_active, passphrase')
    .eq('rater_id', raterId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!data || !data.is_active || data.passphrase !== passphrase) {
    res.status(401).json({ error: 'Invalid rater credentials.' });
    return null;
  }
  return {
    rater_id:     data.rater_id,
    display_name: data.display_name,
    pair:         data.pair,
    roles:        (data.role || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

function raterHasRole(rater, role) {
  return rater.roles.includes(role);
}

// ─────────────────────────────────────────────
// Crossover logic — which papers does this rater see for Phase 1a?
// ─────────────────────────────────────────────
//   crossover_assignment = 'a_phase1a' → Pair A does Phase 1a on this paper
//   crossover_assignment = 'a_phase2a' → Pair B does Phase 1a on this paper
//   is_preliminary = true              → both pairs see it (rehearsal set)
function paperVisibleForPhase1a(paper, rater) {
  if (!paper.is_active) return false;
  if (paper.is_preliminary) return true;
  if (!rater.pair) return false;
  if (paper.crossover_assignment === 'a_phase1a' && rater.pair === 'A') return true;
  if (paper.crossover_assignment === 'a_phase2a' && rater.pair === 'B') return true;
  return false;
}

// Phase 2 visibility = inverse of Phase 1a for non-preliminary papers.
//   crossover_assignment='a_phase1a' → Pair A did Phase 1a → Pair B does Phase 2
//   crossover_assignment='a_phase2a' → Pair B did Phase 1a → Pair A does Phase 2
//   is_preliminary=true              → both pairs see it (rehearsal)
function paperVisibleForPhase2(paper, rater) {
  if (!paper.is_active) return false;
  if (paper.is_preliminary) return true;
  if (!rater.pair) return false;
  if (paper.crossover_assignment === 'a_phase1a' && rater.pair === 'B') return true;
  if (paper.crossover_assignment === 'a_phase2a' && rater.pair === 'A') return true;
  return false;
}

// Pull the V4 extraction record's output_json for a given paper.
// Returns null if no V4 run is linked yet.
async function loadV4Output(supabase, paper) {
  if (!paper.v4_extraction_id) return null;
  const { data, error } = await supabase
    .from('study_extractions')
    .select('id, output_json, generated_at, version')
    .eq('id', paper.v4_extraction_id)
    .maybeSingle();
  if (error) throw new Error('study_extractions: ' + error.message);
  return data || null;
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, x-rater-id, x-rater-passphrase');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireApiToken(req, res)) return;

  const action = (req.query?.action || '').toString();
  if (!action) return res.status(400).json({ error: 'Missing ?action= parameter.' });

  const supabase = getAdminClient();

  // Public action: field list + grading enums (still requires API token).
  // phase1a.html consumes only `fields`; phase2.html consumes everything.
  if (action === 'fields' && req.method === 'GET') {
    return res.status(200).json({
      fields:            MA_FIELDS,
      non_ma_fields:     NON_MA_FIELDS,
      match_statuses:    MATCH_STATUSES,
      taxonomy:          TAXONOMY,
      pipeline_sections: PIPELINE_SECTIONS,
      root_cause_stages: ROOT_CAUSE_STAGES,
    });
  }

  // Login: validate passphrase, return rater info (no session token — client
  // re-sends headers on every call).
  if (action === 'login' && req.method === 'POST') {
    const { rater_id, passphrase } = req.body || {};
    if (!rater_id || !passphrase) {
      return res.status(400).json({ error: 'rater_id and passphrase required.' });
    }
    const { data, error } = await supabase
      .from('validation_raters')
      .select('rater_id, display_name, pair, role, is_active, passphrase')
      .eq('rater_id', rater_id)
      .maybeSingle();
    if (error)               return res.status(500).json({ error: error.message });
    if (!data)               return res.status(401).json({ error: 'Unknown rater.' });
    if (!data.is_active)     return res.status(401).json({ error: 'Rater is deactivated.' });
    if (data.passphrase !== passphrase) return res.status(401).json({ error: 'Wrong passphrase.' });
    return res.status(200).json({
      rater_id:     data.rater_id,
      display_name: data.display_name,
      pair:         data.pair,
      roles:        (data.role || '').split(',').map(s => s.trim()).filter(Boolean),
    });
  }

  // All other actions require rater auth
  const rater = await authenticateRater(req, res, supabase);
  if (!rater) return;

  // ── papers: list Phase 1a papers visible to this rater ────────────────
  if (action === 'papers' && req.method === 'GET') {
    if (!raterHasRole(rater, 'phase1a')) {
      return res.status(403).json({ error: 'Rater does not have Phase 1a role.' });
    }
    const { data: papers, error } = await supabase
      .from('validation_papers')
      .select('id, paper_number, short_label, title, pmid, doi, pdf_url, pdf_filename, is_preliminary, crossover_assignment, phase1a_locked, is_active')
      .order('is_preliminary', { ascending: false })
      .order('paper_number',   { ascending: true, nullsFirst: false });
    if (error) return res.status(500).json({ error: error.message });

    const visible = (papers || []).filter(p => paperVisibleForPhase1a(p, rater));

    // Attach this rater's session status per paper
    const ids = visible.map(p => p.id);
    let sessions = [];
    if (ids.length) {
      const { data: sess, error: sErr } = await supabase
        .from('phase1a_sessions')
        .select('paper_id, started_at, submitted_at, time_seconds, locked')
        .eq('rater_id', rater.rater_id)
        .in('paper_id', ids);
      if (sErr) return res.status(500).json({ error: sErr.message });
      sessions = sess || [];
    }
    const byPaper = Object.fromEntries(sessions.map(s => [s.paper_id, s]));

    return res.status(200).json({
      rater,
      papers: visible.map(p => ({
        ...p,
        my_session: byPaper[p.id] || null,
      })),
    });
  }

  // ── session: fetch (or create) the rater's Phase 1a session for a paper,
  //             plus their existing extractions
  if (action === 'session' && req.method === 'GET') {
    if (!raterHasRole(rater, 'phase1a')) {
      return res.status(403).json({ error: 'Rater does not have Phase 1a role.' });
    }
    const paperId = req.query.paper_id;
    if (!paperId) return res.status(400).json({ error: 'paper_id required.' });

    // Verify paper visibility for this rater
    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('id, paper_number, short_label, title, pmid, doi, pdf_url, pdf_filename, is_preliminary, crossover_assignment, phase1a_locked, is_active')
      .eq('id', paperId)
      .maybeSingle();
    if (pErr)    return res.status(500).json({ error: pErr.message });
    if (!paper)  return res.status(404).json({ error: 'Paper not found.' });
    if (!paperVisibleForPhase1a(paper, rater)) {
      return res.status(403).json({ error: 'Paper not assigned to this rater for Phase 1a.' });
    }

    // Upsert (idempotent get-or-create) the session row
    const { data: existing, error: getErr } = await supabase
      .from('phase1a_sessions')
      .select('*')
      .eq('paper_id', paperId)
      .eq('rater_id', rater.rater_id)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });

    let session = existing;
    if (!session) {
      const { data: created, error: createErr } = await supabase
        .from('phase1a_sessions')
        .insert({ paper_id: paperId, rater_id: rater.rater_id })
        .select('*')
        .single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      session = created;
    }

    // Fetch this rater's existing extractions
    const { data: extractions, error: eErr } = await supabase
      .from('phase1a_extractions')
      .select('field_name, extracted_value, cannot_determine, uncertain, notes, updated_at')
      .eq('paper_id', paperId)
      .eq('rater_id', rater.rater_id);
    if (eErr) return res.status(500).json({ error: eErr.message });

    return res.status(200).json({ paper, session, extractions: extractions || [] });
  }

  // ── field_save: upsert one field; set started_at on first write ────────
  if (action === 'field_save' && req.method === 'POST') {
    if (!raterHasRole(rater, 'phase1a')) {
      return res.status(403).json({ error: 'Rater does not have Phase 1a role.' });
    }
    const { paper_id, field_name, extracted_value, cannot_determine, uncertain, notes } = req.body || {};
    if (!paper_id || !field_name) {
      return res.status(400).json({ error: 'paper_id and field_name required.' });
    }
    if (!MA_FIELD_IDS.includes(field_name)) {
      return res.status(400).json({ error: `Unknown field_name: ${field_name}` });
    }

    // Verify paper visibility
    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('id, is_active, is_preliminary, crossover_assignment')
      .eq('id', paper_id)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (!paperVisibleForPhase1a(paper, rater)) {
      return res.status(403).json({ error: 'Paper not assigned to this rater for Phase 1a.' });
    }

    // Get session — must exist, must not be locked
    const { data: session, error: sErr } = await supabase
      .from('phase1a_sessions')
      .select('id, started_at, locked')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id)
      .maybeSingle();
    if (sErr)     return res.status(500).json({ error: sErr.message });
    if (!session) return res.status(400).json({ error: 'No active session — call ?action=session first.' });
    if (session.locked) return res.status(400).json({ error: 'Session already submitted.' });

    // Set started_at on first field write
    if (!session.started_at) {
      const { error: startErr } = await supabase
        .from('phase1a_sessions')
        .update({ started_at: new Date().toISOString() })
        .eq('id', session.id);
      if (startErr) return res.status(500).json({ error: startErr.message });
    }

    // Upsert the field
    const payload = {
      paper_id,
      rater_id:        rater.rater_id,
      field_name,
      extracted_value: extracted_value ?? null,
      cannot_determine: Boolean(cannot_determine),
      uncertain:       Boolean(uncertain),
      notes:           notes ?? null,
    };
    const { error: upsertErr } = await supabase
      .from('phase1a_extractions')
      .upsert(payload, { onConflict: 'paper_id,rater_id,field_name' });
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });

    return res.status(200).json({ ok: true });
  }

  // ── session_submit: lock session, compute time_seconds ─────────────────
  if (action === 'session_submit' && req.method === 'POST') {
    if (!raterHasRole(rater, 'phase1a')) {
      return res.status(403).json({ error: 'Rater does not have Phase 1a role.' });
    }
    const { paper_id } = req.body || {};
    if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });

    const { data: session, error: sErr } = await supabase
      .from('phase1a_sessions')
      .select('id, started_at, locked')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id)
      .maybeSingle();
    if (sErr)     return res.status(500).json({ error: sErr.message });
    if (!session) return res.status(400).json({ error: 'No session to submit.' });
    if (session.locked) return res.status(400).json({ error: 'Session already locked.' });
    if (!session.started_at) return res.status(400).json({ error: 'Session has not been started — fill at least one field first.' });

    // Completeness: every MA field must have a row with extracted_value
    // OR cannot_determine = true.
    const { data: extractions, error: eErr } = await supabase
      .from('phase1a_extractions')
      .select('field_name, extracted_value, cannot_determine')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id);
    if (eErr) return res.status(500).json({ error: eErr.message });

    const have = new Map((extractions || []).map(r => [r.field_name, r]));
    const missing = [];
    for (const fid of MA_FIELD_IDS) {
      const row = have.get(fid);
      const hasValue = row && (row.extracted_value !== null && row.extracted_value !== '' || row.cannot_determine);
      if (!hasValue) missing.push(fid);
    }
    if (missing.length) {
      return res.status(400).json({
        error: 'Cannot submit — incomplete fields.',
        missing_fields: missing,
      });
    }

    const submittedAt = new Date();
    const startedAt   = new Date(session.started_at);
    const timeSeconds = Math.max(0, Math.round((submittedAt - startedAt) / 1000));

    const { error: lockErr } = await supabase
      .from('phase1a_sessions')
      .update({
        submitted_at: submittedAt.toISOString(),
        time_seconds: timeSeconds,
        locked:       true,
      })
      .eq('id', session.id);
    if (lockErr) return res.status(500).json({ error: lockErr.message });

    return res.status(200).json({ ok: true, time_seconds: timeSeconds });
  }

  // ── other_rater: only released after both raters have submitted ────────
  if (action === 'other_rater' && req.method === 'GET') {
    if (!raterHasRole(rater, 'phase1a') && !raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Not allowed to read other rater data.' });
    }
    const paperId = req.query.paper_id;
    if (!paperId) return res.status(400).json({ error: 'paper_id required.' });

    const { data: sessions, error: sErr } = await supabase
      .from('phase1a_sessions')
      .select('rater_id, locked, submitted_at, time_seconds')
      .eq('paper_id', paperId);
    if (sErr) return res.status(500).json({ error: sErr.message });

    const allLocked = (sessions || []).length >= 2 && sessions.every(s => s.locked);
    const isPrivileged = raterHasRole(rater, 'arbitrator') || raterHasRole(rater, 'admin');
    if (!allLocked && !isPrivileged) {
      return res.status(403).json({ error: 'Other rater data is sealed until both raters have submitted.' });
    }

    const otherSessions = (sessions || []).filter(s => s.rater_id !== rater.rater_id);
    if (!otherSessions.length) {
      return res.status(404).json({ error: 'No other rater data found.' });
    }

    const otherIds = otherSessions.map(s => s.rater_id);
    const { data: extractions, error: eErr } = await supabase
      .from('phase1a_extractions')
      .select('rater_id, field_name, extracted_value, cannot_determine, uncertain, notes')
      .eq('paper_id', paperId)
      .in('rater_id', otherIds);
    if (eErr) return res.status(500).json({ error: eErr.message });

    return res.status(200).json({
      sessions: otherSessions,
      extractions: extractions || [],
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 2 ACTIONS (phase2 role required)
  // ─────────────────────────────────────────────────────────────────────

  // ── phase2_papers: list of papers visible to this rater for Phase 2,
  //                   plus their 2a/2b session status.
  if (action === 'phase2_papers' && req.method === 'GET') {
    if (!raterHasRole(rater, 'phase2')) {
      return res.status(403).json({ error: 'Rater does not have Phase 2 role.' });
    }
    const { data: papers, error } = await supabase
      .from('validation_papers')
      .select('id, paper_number, short_label, title, pmid, doi, pdf_url, pdf_filename, is_preliminary, crossover_assignment, v4_extraction_id, is_active')
      .order('is_preliminary', { ascending: false })
      .order('paper_number',   { ascending: true, nullsFirst: false });
    if (error) return res.status(500).json({ error: error.message });

    const visible = (papers || []).filter(p => paperVisibleForPhase2(p, rater));
    const ids = visible.map(p => p.id);
    let sessions = [];
    if (ids.length) {
      const { data: sess, error: sErr } = await supabase
        .from('phase2_sessions')
        .select('paper_id, phase, started_at, submitted_at, time_seconds, locked')
        .eq('rater_id', rater.rater_id)
        .in('paper_id', ids);
      if (sErr) return res.status(500).json({ error: sErr.message });
      sessions = sess || [];
    }
    const byPaper = {};
    for (const s of sessions) {
      byPaper[s.paper_id] = byPaper[s.paper_id] || {};
      byPaper[s.paper_id][s.phase] = s;
    }
    return res.status(200).json({
      rater,
      papers: visible.map(p => ({
        ...p,
        my_phase2a: byPaper[p.id]?.['2a'] || null,
        my_phase2b: byPaper[p.id]?.['2b'] || null,
        pipeline_run: !!p.v4_extraction_id,
      })),
    });
  }

  // ── phase2_session: fetch/create session for (paper, rater, phase),
  //                    return paper, fields, pipeline_values, existing grades
  if (action === 'phase2_session' && req.method === 'GET') {
    if (!raterHasRole(rater, 'phase2')) {
      return res.status(403).json({ error: 'Rater does not have Phase 2 role.' });
    }
    const paperId = req.query.paper_id;
    const phase   = req.query.phase;
    if (!paperId || !phase) return res.status(400).json({ error: 'paper_id and phase required.' });
    if (phase !== '2a' && phase !== '2b') return res.status(400).json({ error: 'phase must be 2a or 2b.' });

    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('id, paper_number, short_label, title, pmid, doi, pdf_url, pdf_filename, is_preliminary, crossover_assignment, v4_extraction_id, is_active')
      .eq('id', paperId)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (!paperVisibleForPhase2(paper, rater)) {
      return res.status(403).json({ error: 'Paper not assigned to this rater for Phase 2.' });
    }
    if (!paper.v4_extraction_id) {
      return res.status(409).json({ error: 'Pipeline has not run on this paper yet — cannot start Phase 2.' });
    }

    // Phase 2b gating: 2a must be locked first for this rater
    if (phase === '2b') {
      const { data: priorA, error: gErr } = await supabase
        .from('phase2_sessions')
        .select('locked')
        .eq('paper_id', paperId)
        .eq('rater_id', rater.rater_id)
        .eq('phase', '2a')
        .maybeSingle();
      if (gErr) return res.status(500).json({ error: gErr.message });
      if (!priorA || !priorA.locked) {
        return res.status(409).json({ error: 'Phase 2b is locked until you submit Phase 2a for this paper.' });
      }
    }

    // Get-or-create the session row
    const { data: existing, error: getErr } = await supabase
      .from('phase2_sessions')
      .select('*')
      .eq('paper_id', paperId)
      .eq('rater_id', rater.rater_id)
      .eq('phase', phase)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });

    let session = existing;
    if (!session) {
      const { data: created, error: cErr } = await supabase
        .from('phase2_sessions')
        .insert({
          paper_id:      paperId,
          rater_id:      rater.rater_id,
          phase,
          extraction_id: paper.v4_extraction_id,
        })
        .select('*')
        .single();
      if (cErr) return res.status(500).json({ error: cErr.message });
      session = created;
    }

    // Load V4 output, strip _critic / provenance
    let v4Output = null;
    try {
      const v4 = await loadV4Output(supabase, paper);
      if (v4 && v4.output_json) v4Output = stripInternalFields(v4.output_json);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Build the field set for this phase + extracted pipeline values
    const fields = phase === '2a' ? MA_FIELDS : NON_MA_FIELDS;
    const pipelineValues = extractPipelineValues(v4Output, fields);

    // Existing grades for this rater + phase
    const { data: grades, error: grErr } = await supabase
      .from('phase2_grades')
      .select('field_name, v4_value, match_status, correction_value, harm_severity, error_taxonomy, pipeline_section, root_cause_stage, notes')
      .eq('paper_id', paperId)
      .eq('rater_id', rater.rater_id)
      .eq('phase', phase);
    if (grErr) return res.status(500).json({ error: grErr.message });

    return res.status(200).json({
      paper,
      session,
      phase,
      fields,
      pipeline_values: pipelineValues,
      grades: grades || [],
    });
  }

  // ── phase2_field_save: upsert one grade; sets started_at on first save
  if (action === 'phase2_field_save' && req.method === 'POST') {
    if (!raterHasRole(rater, 'phase2')) {
      return res.status(403).json({ error: 'Rater does not have Phase 2 role.' });
    }
    const {
      paper_id, phase, field_name,
      v4_value,
      match_status, correction_value,
      harm_severity, error_taxonomy,
      pipeline_section, root_cause_stage,
      notes,
    } = req.body || {};
    if (!paper_id || !phase || !field_name) {
      return res.status(400).json({ error: 'paper_id, phase, field_name required.' });
    }
    if (phase !== '2a' && phase !== '2b') {
      return res.status(400).json({ error: 'phase must be 2a or 2b.' });
    }
    const validFieldIds = phase === '2a' ? MA_FIELD_IDS : NON_MA_FIELD_IDS;
    if (!validFieldIds.includes(field_name)) {
      return res.status(400).json({ error: `Unknown field_name for ${phase}: ${field_name}` });
    }

    // Verify session exists, not locked
    const { data: session, error: sErr } = await supabase
      .from('phase2_sessions')
      .select('id, started_at, locked')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id)
      .eq('phase', phase)
      .maybeSingle();
    if (sErr)     return res.status(500).json({ error: sErr.message });
    if (!session) return res.status(400).json({ error: 'No active session — open the paper first.' });
    if (session.locked) return res.status(400).json({ error: 'Session already submitted.' });

    if (!session.started_at) {
      const { error: stErr } = await supabase
        .from('phase2_sessions')
        .update({ started_at: new Date().toISOString() })
        .eq('id', session.id);
      if (stErr) return res.status(500).json({ error: stErr.message });
    }

    const v4Snapshot = (v4_value === undefined || v4_value === null)
      ? null
      : (typeof v4_value === 'string' ? v4_value : JSON.stringify(v4_value));

    const payload = {
      paper_id,
      rater_id:         rater.rater_id,
      phase,
      field_name,
      v4_value:         v4Snapshot,
      match_status:     match_status || null,
      correction_value: correction_value ?? null,
      harm_severity:    harm_severity == null ? null : Number(harm_severity),
      error_taxonomy:   error_taxonomy || null,
      pipeline_section: pipeline_section || null,
      root_cause_stage: root_cause_stage || null,
      notes:            notes ?? null,
    };
    const { error: upErr } = await supabase
      .from('phase2_grades')
      .upsert(payload, { onConflict: 'paper_id,rater_id,phase,field_name' });
    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({ ok: true });
  }

  // ── phase2_session_submit: lock session, compute time_seconds.
  //    For 2a: requires every MA field to have a match_status set.
  //    For 2b: requires every NON_MA field to have a match_status set,
  //    AND requires phase 2a to be locked already (re-checked here even
  //    though session_session blocks 2b creation pre-2a).
  if (action === 'phase2_session_submit' && req.method === 'POST') {
    if (!raterHasRole(rater, 'phase2')) {
      return res.status(403).json({ error: 'Rater does not have Phase 2 role.' });
    }
    const { paper_id, phase } = req.body || {};
    if (!paper_id || !phase) return res.status(400).json({ error: 'paper_id and phase required.' });
    if (phase !== '2a' && phase !== '2b') return res.status(400).json({ error: 'phase must be 2a or 2b.' });

    if (phase === '2b') {
      const { data: prior, error: pErr } = await supabase
        .from('phase2_sessions')
        .select('locked')
        .eq('paper_id', paper_id)
        .eq('rater_id', rater.rater_id)
        .eq('phase', '2a')
        .maybeSingle();
      if (pErr) return res.status(500).json({ error: pErr.message });
      if (!prior || !prior.locked) {
        return res.status(409).json({ error: 'Phase 2a must be submitted before Phase 2b can be locked.' });
      }
    }

    const { data: session, error: sErr } = await supabase
      .from('phase2_sessions')
      .select('id, started_at, locked')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id)
      .eq('phase', phase)
      .maybeSingle();
    if (sErr)     return res.status(500).json({ error: sErr.message });
    if (!session) return res.status(400).json({ error: 'No session to submit.' });
    if (session.locked) return res.status(400).json({ error: 'Session already locked.' });
    if (!session.started_at) return res.status(400).json({ error: 'Session has not been started.' });

    const fieldIds = phase === '2a' ? MA_FIELD_IDS : NON_MA_FIELD_IDS;
    const { data: grades, error: gErr } = await supabase
      .from('phase2_grades')
      .select('field_name, match_status')
      .eq('paper_id', paper_id)
      .eq('rater_id', rater.rater_id)
      .eq('phase', phase);
    if (gErr) return res.status(500).json({ error: gErr.message });
    const have = new Map((grades || []).map(g => [g.field_name, g]));
    const missing = [];
    for (const fid of fieldIds) {
      const g = have.get(fid);
      if (!g || !g.match_status) missing.push(fid);
    }
    if (missing.length) {
      return res.status(400).json({
        error: 'Cannot submit — incomplete fields.',
        missing_fields: missing,
      });
    }

    const submittedAt = new Date();
    const startedAt   = new Date(session.started_at);
    const timeSeconds = Math.max(0, Math.round((submittedAt - startedAt) / 1000));

    const { error: lockErr } = await supabase
      .from('phase2_sessions')
      .update({
        submitted_at: submittedAt.toISOString(),
        time_seconds: timeSeconds,
        locked:       true,
      })
      .eq('id', session.id);
    if (lockErr) return res.status(500).json({ error: lockErr.message });

    return res.status(200).json({ ok: true, time_seconds: timeSeconds });
  }

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 3 ACTIONS (arbitrator or admin role required)
  // ─────────────────────────────────────────────────────────────────────

  // ── phase3_papers: list papers ready for arbitration. A paper is
  //    "ready" when its V4 has been run AND at least the Phase 1a pair
  //    OR the Phase 2a pair has both members locked. (We don't gate on
  //    full 1a+2a completeness — preliminary papers and the PI's solo
  //    smoke-test should still surface here.) For each paper, returns
  //    progress counts so the UI can sort by readiness.
  if (action === 'phase3_papers' && req.method === 'GET') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const { data, error } = await supabase
      .from('validation_paper_progress')
      .select('*')
      .order('is_preliminary', { ascending: false })
      .order('paper_number',   { ascending: true,  nullsFirst: false });
    if (error) return res.status(500).json({ error: error.message });

    // Pull the source paper rows for fields not in the view (pdf_url, etc.)
    const ids = (data || []).map(r => r.paper_id);
    let papers = [];
    if (ids.length) {
      const { data: pp, error: pErr } = await supabase
        .from('validation_papers')
        .select('id, pdf_url, pdf_filename, pmid, doi, v4_extraction_id, phase3_locked, library_trial_id, merged_at')
        .in('id', ids);
      if (pErr) return res.status(500).json({ error: pErr.message });
      papers = pp || [];
    }
    const byId = Object.fromEntries(papers.map(p => [p.id, p]));
    const rows = (data || []).map(r => ({ ...r, ...byId[r.paper_id] }));
    return res.status(200).json({ papers: rows });
  }

  // ── phase3_session: load discrepancy view for one paper.
  //    Returns: paper, V4 output (stripped), MA rows + non-MA rows
  //    (each with pipeline value, rater A & B inputs, and any existing
  //    arbitration), paper rating, completeness flags.
  if (action === 'phase3_session' && req.method === 'GET') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const paperId = req.query.paper_id;
    if (!paperId) return res.status(400).json({ error: 'paper_id required.' });

    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('*')
      .eq('id', paperId)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    // V4 output
    let v4Output = null;
    try {
      const v4 = await loadV4Output(supabase, paper);
      if (v4 && v4.output_json) v4Output = v4.output_json;
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Phase 1a extractions, both raters (only if both submitted to
    // preserve PROTOCOL §2.3 blinding — but arbitrators are exempt).
    const { data: phase1a, error: e1 } = await supabase
      .from('phase1a_extractions')
      .select('rater_id, field_name, extracted_value, cannot_determine, uncertain, notes')
      .eq('paper_id', paperId);
    if (e1) return res.status(500).json({ error: e1.message });

    const { data: phase2g, error: e2 } = await supabase
      .from('phase2_grades')
      .select('rater_id, phase, field_name, match_status, correction_value, harm_severity, error_taxonomy, pipeline_section, root_cause_stage, notes, v4_value')
      .eq('paper_id', paperId);
    if (e2) return res.status(500).json({ error: e2.message });

    const { data: arbitrations, error: e3 } = await supabase
      .from('phase3_arbitrations')
      .select('*')
      .eq('paper_id', paperId);
    if (e3) return res.status(500).json({ error: e3.message });

    const { data: rating, error: e4 } = await supabase
      .from('phase3_paper_ratings')
      .select('*')
      .eq('paper_id', paperId)
      .eq('arbitrator_id', rater.rater_id)
      .maybeSingle();
    if (e4) return res.status(500).json({ error: e4.message });

    // Identify rater pair for each rater_id (best-effort — the pair is
    // not stored on each row). Look up validation_raters once.
    const allRaterIds = [...new Set((phase1a || []).concat(phase2g || []).map(r => r.rater_id))];
    let raterMeta = [];
    if (allRaterIds.length) {
      const { data: rm } = await supabase
        .from('validation_raters')
        .select('rater_id, pair, display_name')
        .in('rater_id', allRaterIds);
      raterMeta = rm || [];
    }
    const pairOf = Object.fromEntries(raterMeta.map(r => [r.rater_id, r.pair]));
    const nameOf = Object.fromEntries(raterMeta.map(r => [r.rater_id, r.display_name || r.rater_id]));

    function splitByPair(rows, phaseFilter) {
      const subset = phaseFilter ? rows.filter(r => r.phase === phaseFilter) : rows;
      return {
        a: subset.filter(r => pairOf[r.rater_id] === 'A'),
        b: subset.filter(r => pairOf[r.rater_id] === 'B'),
        unpaired: subset.filter(r => !pairOf[r.rater_id]),
      };
    }
    const p1 = splitByPair(phase1a || []);
    const p2a = splitByPair(phase2g || [], '2a');
    const p2b = splitByPair(phase2g || [], '2b');

    // For preliminary / smoke-test papers a single PI may grade as both
    // pairs. If pair-A bucket is empty but pair-B has data, fall back to
    // unpaired so the UI still has something to show.
    function preferOrUnpaired(bucket) {
      const a = bucket.a.length ? bucket.a : bucket.unpaired;
      const b = bucket.b.length ? bucket.b : (a === bucket.unpaired ? [] : bucket.unpaired);
      return { a, b };
    }
    const phase1aPair = preferOrUnpaired(p1);
    const phase2aPair = preferOrUnpaired(p2a);
    const phase2bPair = preferOrUnpaired(p2b);

    const { maRows, nonMaRows } = buildPhase3FieldRows({
      v4Json: v4Output,
      phase1aA: phase1aPair.a, phase1aB: phase1aPair.b,
      phase2aA: phase2aPair.a, phase2aB: phase2aPair.b,
      phase2bA: phase2bPair.a, phase2bB: phase2bPair.b,
      arbitrations,
    });

    function raterIdOf(rows) { return rows[0]?.rater_id || null; }
    const raterIds = {
      phase1a_a: raterIdOf(phase1aPair.a),
      phase1a_b: raterIdOf(phase1aPair.b),
      phase2a_a: raterIdOf(phase2aPair.a),
      phase2a_b: raterIdOf(phase2aPair.b),
      phase2b_a: raterIdOf(phase2bPair.a),
      phase2b_b: raterIdOf(phase2bPair.b),
    };

    return res.status(200).json({
      paper,
      v4_output:        v4Output ? stripInternalFields(v4Output) : null,
      ma_rows:          maRows,
      non_ma_rows:      nonMaRows,
      arbitrations:     arbitrations || [],
      paper_rating:     rating || null,
      rater_ids:        raterIds,
      rater_names:      nameOf,
    });
  }

  // ── phase3_field_save: upsert one phase3_arbitrations row ─────────────
  if (action === 'phase3_field_save' && req.method === 'POST') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const {
      paper_id, field_name,
      v4_value, v1_value,
      rater_a_id, rater_b_id,
      rater_a_correction, rater_b_correction,
      rater_a_match_status, rater_b_match_status,
      arbitrated_value, arbitrator_decision, arbitrator_notes,
    } = req.body || {};
    if (!paper_id || !field_name) {
      return res.status(400).json({ error: 'paper_id and field_name required.' });
    }
    const allFieldIds = [...MA_FIELD_IDS, ...NON_MA_FIELD_IDS];
    if (!allFieldIds.includes(field_name)) {
      return res.status(400).json({ error: `Unknown field_name: ${field_name}` });
    }

    // Block edits once paper is locked
    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('phase3_locked')
      .eq('id', paper_id)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (paper.phase3_locked) {
      return res.status(409).json({ error: 'Paper is locked — arbitration cannot be edited.' });
    }

    const payload = {
      paper_id,
      field_name,
      v4_value:              v4_value ?? null,
      v1_value:              v1_value ?? null,
      rater_a_id:            rater_a_id || null,
      rater_b_id:            rater_b_id || null,
      rater_a_correction:    rater_a_correction ?? null,
      rater_b_correction:    rater_b_correction ?? null,
      rater_a_match_status:  rater_a_match_status || null,
      rater_b_match_status:  rater_b_match_status || null,
      arbitrator_id:         rater.rater_id,
      arbitrated_value:      arbitrated_value ?? null,
      arbitrator_decision:   arbitrator_decision || null,
      arbitrator_notes:      arbitrator_notes ?? null,
      arbitrated_at:         arbitrator_decision ? new Date().toISOString() : null,
    };
    const { error: upErr } = await supabase
      .from('phase3_arbitrations')
      .upsert(payload, { onConflict: 'paper_id,field_name' });
    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({ ok: true });
  }

  // ── phase3_paper_rating_save: upsert phase3_paper_ratings ────────────
  if (action === 'phase3_paper_rating_save' && req.method === 'POST') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const { paper_id, quality_rating, usability_rating, notes } = req.body || {};
    if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });

    const payload = {
      paper_id,
      arbitrator_id:    rater.rater_id,
      quality_rating:   quality_rating == null ? null : Number(quality_rating),
      usability_rating: usability_rating == null ? null : Number(usability_rating),
      notes:            notes ?? null,
    };
    const { error } = await supabase
      .from('phase3_paper_ratings')
      .upsert(payload, { onConflict: 'paper_id,arbitrator_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── phase3_paper_submit: completeness check, lock arbitrations, build
  //    merged JSON, write to validation_papers.merged_json. Optionally
  //    save to the trials library if `save_to_library` is true.
  if (action === 'phase3_paper_submit' && req.method === 'POST') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const { paper_id, save_to_library, library_meta, confirm_overwrite } = req.body || {};
    if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });

    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('*')
      .eq('id', paper_id)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (!paper.v4_extraction_id) {
      return res.status(409).json({ error: 'Paper has no V4 pipeline run — cannot finalise.' });
    }

    // Completeness: every MA field must have an arbitration with a decision.
    // Non-MA fields are optional (arbitrator may skip if both raters
    // exact_match'd and there's nothing to decide).
    const { data: arbitrations, error: aErr } = await supabase
      .from('phase3_arbitrations')
      .select('*')
      .eq('paper_id', paper_id);
    if (aErr) return res.status(500).json({ error: aErr.message });

    const have = new Map((arbitrations || []).map(a => [a.field_name, a]));
    const missing = [];
    for (const fid of MA_FIELD_IDS) {
      const a = have.get(fid);
      if (!a || !a.arbitrator_decision) missing.push(fid);
    }
    if (missing.length) {
      return res.status(400).json({ error: 'Cannot finalise — incomplete MA fields.', missing_fields: missing });
    }

    // Build the merged JSON.
    const v4 = await loadV4Output(supabase, paper);
    if (!v4 || !v4.output_json) {
      return res.status(500).json({ error: 'V4 output_json missing for linked extraction.' });
    }
    const merged = buildMergedJson(v4.output_json, arbitrations || []);

    // Persist merged_json + lock the paper.
    const updatePayload = {
      merged_json:   merged,
      merged_at:     new Date().toISOString(),
      phase3_locked: true,
    };

    // Optional: write to the validated trials library.
    let libraryResult = null;
    if (save_to_library) {
      // Source identifiers prefer paper-level pmid/doi (admin-curated)
      // over the V4 reportMeta fields.
      const reportMeta = merged?.reportMeta || {};
      const pmid = paper.pmid || reportMeta.pubmed_id || null;
      const doi  = paper.doi  || reportMeta.doi       || null;

      // library_meta from request body; fall back to V4's own library_meta
      // if the arbitrator didn't override.
      const lm = library_meta || merged?.library_meta || null;
      if (!lm || !lm.domain || !lm.specialty || !lm.display_title) {
        return res.status(400).json({
          error: 'save_to_library requires library_meta with at least domain, specialty, display_title.',
        });
      }

      // Duplicate detection — same logic as api/library-save.js
      let supersede_ids = [];
      if (pmid || doi) {
        let dq = supabase.from('trials').select('id, display_title, saved_at, validated, version').is('superseded_by', null);
        if (pmid && doi)      dq = dq.or(`pmid.eq.${pmid},doi.eq.${doi}`);
        else if (pmid)        dq = dq.eq('pmid', pmid);
        else                  dq = dq.eq('doi', doi);
        const { data: dups, error: dErr } = await dq;
        if (dErr) return res.status(500).json({ error: dErr.message });
        if (dups && dups.length && !confirm_overwrite) {
          return res.status(409).json({
            error: 'duplicate',
            message: 'A trial with this PMID or DOI already exists. Re-submit with confirm_overwrite=true to supersede.',
            duplicates: dups,
          });
        }
        if (dups && dups.length && confirm_overwrite) supersede_ids = dups.map(d => d.id);
      }

      let version = 1;
      if (supersede_ids.length) {
        const { data: maxRow } = await supabase
          .from('trials').select('version').is('superseded_by', null)
          .or(pmid ? `pmid.eq.${pmid}` : `doi.eq.${doi}`)
          .order('version', { ascending: false }).limit(1).maybeSingle();
        version = ((maxRow?.version) || 0) + 1;
      }

      const now = new Date().toISOString();
      const trialRecord = {
        pmid,
        pmcid:            reportMeta.pmc_id || null,
        doi,
        authors:          reportMeta.authors || null,
        domain:           lm.domain,
        specialty:        lm.specialty,
        subspecialty:     lm.subspecialty   || null,
        tags:             lm.tags           || [],
        landmark_year:    lm.landmark_year  || null,
        display_title:    lm.display_title,
        analysis_json:    merged,
        source_type:      reportMeta.source_type || null,
        saved_by:         null,                                     // no Supabase user — server-issued via validation auth
        saved_at:         now,
        validated:        true,
        validated_by_name: rater.display_name || rater.rater_id,
        validated_at:     now,
        validation_notes: `Phase 3 arbitration — paper ${paper.short_label || paper.paper_number || paper_id}`,
        version,
        superseded_by:    null,
      };

      const { data: inserted, error: insErr } = await supabase
        .from('trials').insert(trialRecord).select().single();
      if (insErr) return res.status(500).json({ error: 'trials insert failed: ' + insErr.message });

      if (supersede_ids.length) {
        await supabase.from('trials').update({ superseded_by: inserted.id }).in('id', supersede_ids);
      }

      updatePayload.library_trial_id = inserted.id;
      libraryResult = { trial_id: inserted.id, version, superseded: supersede_ids.length };
    }

    // Lock all phase3_arbitrations rows for the paper
    await supabase.from('phase3_arbitrations').update({ locked: true }).eq('paper_id', paper_id);

    const { error: upErr } = await supabase
      .from('validation_papers').update(updatePayload).eq('id', paper_id);
    if (upErr) return res.status(500).json({ error: 'validation_papers update failed: ' + upErr.message });

    return res.status(200).json({
      ok: true,
      merged_at: updatePayload.merged_at,
      library: libraryResult,
    });
  }

  // ── phase3_unlock: admin-only safety valve to reopen arbitration ─────
  if (action === 'phase3_unlock' && req.method === 'POST') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const { paper_id } = req.body || {};
    if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });
    await supabase.from('phase3_arbitrations').update({ locked: false }).eq('paper_id', paper_id);
    const { error } = await supabase
      .from('validation_papers')
      .update({ phase3_locked: false })
      .eq('id', paper_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── phase3_merged_json: fetch the merged JSON for rendering ──────────
  if (action === 'phase3_merged_json' && req.method === 'GET') {
    if (!raterHasRole(rater, 'arbitrator') && !raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Arbitrator or admin role required.' });
    }
    const paperId = req.query.paper_id;
    if (!paperId) return res.status(400).json({ error: 'paper_id required.' });
    const { data, error } = await supabase
      .from('validation_papers')
      .select('id, short_label, title, pmid, doi, merged_json, merged_at, phase3_locked, library_trial_id')
      .eq('id', paperId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Paper not found.' });
    return res.status(200).json(data);
  }

  // ─────────────────────────────────────────────────────────────────────
  // ADMIN ACTIONS (admin role required)
  // ─────────────────────────────────────────────────────────────────────

  // ── admin_papers_list: full table including inactive ────────────────
  if (action === 'admin_papers_list' && req.method === 'GET') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const { data, error } = await supabase
      .from('validation_papers')
      .select('*')
      .order('is_preliminary', { ascending: false })
      .order('paper_number',   { ascending: true,  nullsFirst: false })
      .order('created_at',     { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ papers: data || [] });
  }

  // ── admin_papers_upsert: create (no id) or update (with id) ─────────
  if (action === 'admin_papers_upsert' && req.method === 'POST') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const allowed = [
      'id', 'paper_number', 'short_label', 'title', 'pmid', 'doi',
      'pdf_url', 'pdf_filename', 'pdf_sha256',
      'is_preliminary', 'is_active', 'crossover_assignment',
      'phase1a_locked', 'phase2a_locked', 'phase3_locked',
      'v4_extraction_id', 'v4_runtime_seconds', 'notes',
    ];
    const payload = {};
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        payload[k] = req.body[k] === '' ? null : req.body[k];
      }
    }
    if (!payload.title) return res.status(400).json({ error: 'title is required.' });

    let result;
    if (payload.id) {
      const id = payload.id;
      delete payload.id;
      result = await supabase
        .from('validation_papers')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();
    } else {
      result = await supabase
        .from('validation_papers')
        .insert(payload)
        .select('*')
        .single();
    }
    if (result.error) return res.status(500).json({ error: result.error.message });
    return res.status(200).json({ paper: result.data });
  }

  // ── admin_papers_delete: hard delete (CASCADE wipes phase1a/2/3 data)
  if (action === 'admin_papers_delete' && (req.method === 'DELETE' || req.method === 'POST')) {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const id = req.query.id || req.body?.id;
    if (!id) return res.status(400).json({ error: 'id required.' });

    // Best-effort: remove the paper's PDF folder from storage. Ignore errors
    // (the paper row delete is the source of truth).
    try {
      const { data: list } = await supabase.storage.from(PDF_BUCKET).list(id);
      if (list && list.length) {
        const paths = list.map(f => `${id}/${f.name}`);
        await supabase.storage.from(PDF_BUCKET).remove(paths);
      }
    } catch (_) { /* swallow */ }

    const { error } = await supabase.from('validation_papers').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── admin_pdf_upload: base64 PDF → Storage; updates pdf_url on the row
  if (action === 'admin_pdf_upload' && req.method === 'POST') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const { paper_id, filename, content_base64 } = req.body || {};
    if (!paper_id || !filename || !content_base64) {
      return res.status(400).json({ error: 'paper_id, filename, content_base64 required.' });
    }
    let buffer;
    try {
      buffer = Buffer.from(content_base64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 content.' });
    }
    if (buffer.length === 0) return res.status(400).json({ error: 'Empty file.' });
    if (buffer.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'File exceeds 20 MB bucket limit.' });

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    // Sanitise filename — keep extension, replace anything else
    const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
    const storagePath = `${paper_id}/${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(PDF_BUCKET)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (upErr) {
      return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message });
    }

    const { data: urlData } = supabase.storage.from(PDF_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) return res.status(500).json({ error: 'Could not resolve public URL.' });

    const { error: updErr } = await supabase
      .from('validation_papers')
      .update({ pdf_url: publicUrl, pdf_filename: safeName, pdf_sha256: sha256 })
      .eq('id', paper_id);
    if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });

    return res.status(200).json({
      pdf_url:      publicUrl,
      pdf_filename: safeName,
      pdf_sha256:   sha256,
      bytes:        buffer.length,
    });
  }

  // ── admin_run_v4: download the paper's PDF, run the V4 pipeline,
  //    save the extraction, and link it to the validation paper.
  //    Replaces the manual study.html → copy-id → paste shuffle.
  if (action === 'admin_run_v4' && req.method === 'POST') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const { paper_id, force = false } = req.body || {};
    if (!paper_id) return res.status(400).json({ error: 'paper_id required.' });

    const { data: paper, error: pErr } = await supabase
      .from('validation_papers')
      .select('id, title, pmid, doi, pdf_url, pdf_filename, v4_extraction_id')
      .eq('id', paper_id)
      .maybeSingle();
    if (pErr)   return res.status(500).json({ error: pErr.message });
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (!paper.pdf_url) {
      return res.status(400).json({ error: 'Paper has no pdf_url. Upload a PDF or paste an external URL first.' });
    }
    if (paper.v4_extraction_id && !force) {
      return res.status(409).json({
        error: 'V4 extraction already linked. Pass force:true to re-run and overwrite.',
        v4_extraction_id: paper.v4_extraction_id,
      });
    }

    // Fetch PDF bytes
    let buffer;
    try {
      const r = await fetch(paper.pdf_url);
      if (!r.ok) throw new Error(`PDF fetch failed: HTTP ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      return res.status(502).json({ error: 'Could not fetch PDF: ' + e.message });
    }

    // Parse → text
    let pdfText;
    try {
      const data = await pdfParse(buffer);
      pdfText = data.text;
      if (!pdfText || pdfText.length < 500) {
        throw new Error('PDF text extraction returned <500 chars (likely image-only or empty).');
      }
    } catch (e) {
      return res.status(422).json({ error: 'PDF parse failed: ' + e.message });
    }

    // Run V4
    const sourceMeta = {
      sourceType: 'full-text-pdf',
      pmid:       paper.pmid || null,
      pmcid:      null,
      doi:        paper.doi  || null,
      authors:    null,
    };
    let v4Output, v1Output, runtimeSeconds;
    try {
      const ctx = buildSourceContext(pdfText, sourceMeta);
      const start = Date.now();
      const result = await runPipelineV4(ctx, sourceMeta);
      runtimeSeconds = Math.round((Date.now() - start) / 1000);
      result.v4._runtime_seconds = runtimeSeconds;
      v4Output = result.v4;
      v1Output = result.v1;
    } catch (e) {
      console.error('[validation admin_run_v4] pipeline error:', e.message);
      if ((e.message || '').startsWith('GEMINI_UNAVAILABLE')) {
        return res.status(503).json({ error: e.message });
      }
      return res.status(500).json({ error: 'Pipeline failed: ' + e.message });
    }

    // Persist to study_extractions. study_papers requires a row, so we
    // mirror api/study.js Mode B and synthesise one if none exists.
    // We key the bridge paper by validation_paper_id stored in notes.
    const reportMeta  = v4Output?.reportMeta   || {};
    const libraryMeta = v4Output?.library_meta || {};

    // Reuse existing bridge paper if we already created one for this validation_paper
    let studyPaperId = null;
    if (paper.v4_extraction_id) {
      const { data: prior } = await supabase
        .from('study_extractions')
        .select('paper_id')
        .eq('id', paper.v4_extraction_id)
        .maybeSingle();
      studyPaperId = prior?.paper_id || null;
    }
    if (!studyPaperId) {
      const { data: newPaper, error: cpErr } = await supabase
        .from('study_papers')
        .insert({
          pmid:      paper.pmid || reportMeta.pubmed_id    || null,
          title:     libraryMeta.display_title || reportMeta.trial_identification || paper.title || 'Validation paper',
          authors:   reportMeta.authors      || null,
          journal:   reportMeta.journal      || null,
          year:      reportMeta.year         || null,
          specialty: libraryMeta.specialty   || null,
          phase:     0,
          is_pilot:  false,
          notes:     `validation_paper_id=${paper.id}`,
        })
        .select()
        .single();
      if (cpErr) return res.status(500).json({ error: 'study_papers insert failed: ' + cpErr.message });
      studyPaperId = newPaper.id;
    }

    const now = new Date().toISOString();
    const { data: v4Saved, error: e1 } = await supabase
      .from('study_extractions')
      .upsert({
        paper_id:     studyPaperId,
        version:      'v4',
        output_json:  v4Output,
        source_type:  'full-text-pdf',
        generated_at: now,
      }, { onConflict: 'paper_id,version' })
      .select('id, generated_at')
      .single();
    if (e1) return res.status(500).json({ error: 'V4 extraction save failed: ' + e1.message });

    // Save V1 byproduct (non-fatal if it fails)
    if (v1Output) {
      await supabase
        .from('study_extractions')
        .upsert({
          paper_id:     studyPaperId,
          version:      'v1',
          output_json:  v1Output,
          source_type:  'full-text-pdf',
          generated_at: now,
        }, { onConflict: 'paper_id,version' });
    }

    // Link back onto the validation paper
    const { error: linkErr } = await supabase
      .from('validation_papers')
      .update({
        v4_extraction_id:   v4Saved.id,
        v4_runtime_seconds: runtimeSeconds,
      })
      .eq('id', paper.id);
    if (linkErr) return res.status(500).json({ error: 'Linking failed: ' + linkErr.message });

    return res.status(200).json({
      ok:                 true,
      v4_extraction_id:   v4Saved.id,
      v4_runtime_seconds: runtimeSeconds,
      study_paper_id:     studyPaperId,
      generated_at:       v4Saved.generated_at,
    });
  }

  // ── admin_raters_list ───────────────────────────────────────────────
  if (action === 'admin_raters_list' && req.method === 'GET') {
    if (!raterHasRole(rater, 'admin')) {
      return res.status(403).json({ error: 'Admin role required.' });
    }
    const { data, error } = await supabase
      .from('validation_raters')
      .select('id, rater_id, display_name, pair, role, is_active, notes, created_at')
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ raters: data || [] });
  }

  return res.status(404).json({ error: `Unknown or unsupported action: ${action}` });
}
