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
