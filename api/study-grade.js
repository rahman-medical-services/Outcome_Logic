// api/study-grade.js
// Per-field grade persistence for the Phase 0 pilot grading interface.
// Admin-only: requires INTERNAL_API_TOKEN + admin-tier JWT.
//
// GET  /api/study-grade?output_id=<uuid>
//   Returns all grades for a given output_id.
//   Used by pilot.html to restore in-progress grading sessions.
//
// POST /api/study-grade
//   Upserts a single field grade (conflict on output_id + field_name).

import { createClient } from '@supabase/supabase-js';

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
  const tier = user.user_metadata?.tier || 'free';
  if (tier !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return user;
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAdmin(req, res);
  if (!user) return;

  const supabase = getAdminClient();

  // ── GET: fetch all grades for an output ──────────────────────────────────
  if (req.method === 'GET') {
    const { output_id } = req.query;
    if (!output_id) {
      return res.status(400).json({ error: 'output_id query parameter required.' });
    }

    const { data, error } = await supabase
      .from('study_grades')
      .select([
        'id',
        'field_name',
        'match_status',
        'error_taxonomy',
        'harm_severity',
        'pipeline_section',
        'correction_text',
        'reference_standard_value',
        'suspicious_agreement',
        'suspicious_agreement_note',
        'graded_at',
      ].join(', '))
      .eq('output_id', output_id)
      .order('graded_at', { ascending: true });

    if (error) {
      console.error('[study-grade GET] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ grades: data || [] });
  }

  // ── POST: upsert a single field grade ────────────────────────────────────
  if (req.method === 'POST') {
    const {
      output_id,
      field_name,
      match_status,
      error_taxonomy,
      harm_severity,
      pipeline_section,
      correction_text,
      reference_standard_value,
      suspicious_agreement,
      suspicious_agreement_note,
    } = req.body || {};

    // Validation
    if (!output_id) {
      return res.status(400).json({ error: 'output_id is required.' });
    }
    if (!field_name) {
      return res.status(400).json({ error: 'field_name is required.' });
    }
    const validMatchStatuses = ['exact_match', 'partial_match', 'fail', 'hallucinated'];
    if (match_status && !validMatchStatuses.includes(match_status)) {
      return res.status(400).json({ error: `match_status must be one of: ${validMatchStatuses.join(', ')}` });
    }
    const validTaxonomies = ['omission', 'misclassification', 'formatting_syntax', 'semantic'];
    if (error_taxonomy && !validTaxonomies.includes(error_taxonomy)) {
      return res.status(400).json({ error: `error_taxonomy must be one of: ${validTaxonomies.join(', ')}` });
    }
    if (harm_severity !== null && harm_severity !== undefined) {
      const sev = Number(harm_severity);
      if (!Number.isInteger(sev) || sev < 1 || sev > 5) {
        return res.status(400).json({ error: 'harm_severity must be an integer between 1 and 5.' });
      }
    }
    const validSections = ['extractor', 'adjudicator', 'post_processing'];
    if (pipeline_section && !validSections.includes(pipeline_section)) {
      return res.status(400).json({ error: `pipeline_section must be one of: ${validSections.join(', ')}` });
    }

    // Verify the output exists
    const { data: outputCheck, error: outputErr } = await supabase
      .from('study_outputs')
      .select('id')
      .eq('id', output_id)
      .maybeSingle();

    if (outputErr) {
      return res.status(500).json({ error: outputErr.message });
    }
    if (!outputCheck) {
      return res.status(404).json({ error: `No study_output found with id: ${output_id}` });
    }

    // Build upsert payload
    const payload = {
      output_id,
      field_name,
      graded_at: new Date().toISOString(),
    };
    if (match_status           !== undefined) payload.match_status            = match_status;
    if (error_taxonomy         !== undefined) payload.error_taxonomy          = error_taxonomy;
    if (harm_severity          !== undefined) payload.harm_severity           = harm_severity !== null ? Number(harm_severity) : null;
    if (pipeline_section       !== undefined) payload.pipeline_section        = pipeline_section;
    if (correction_text        !== undefined) payload.correction_text         = correction_text;
    if (reference_standard_value !== undefined) payload.reference_standard_value = reference_standard_value;
    if (suspicious_agreement   !== undefined) payload.suspicious_agreement    = Boolean(suspicious_agreement);
    if (suspicious_agreement_note !== undefined) payload.suspicious_agreement_note = suspicious_agreement_note;

    const { data, error } = await supabase
      .from('study_grades')
      .upsert(payload, { onConflict: 'output_id,field_name' })
      .select('id')
      .single();

    if (error) {
      console.error('[study-grade POST] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, id: data.id });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
