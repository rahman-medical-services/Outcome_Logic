// api/study-papers.js
// CRUD endpoint for validation study papers.
// Admin-only: requires INTERNAL_API_TOKEN + admin-tier JWT.
//
// GET  /api/study-papers              → list all papers with output status
// POST /api/study-papers              → add a paper
// PATCH /api/study-papers?id=<uuid>   → update a paper's PMID/title/etc.
// DELETE /api/study-papers?id=<uuid>  → delete a paper (cascades to outputs/grades)

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
// Returns { user } or sends 401/403 and returns null
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
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAdmin(req, res);
  if (!user) return;

  const supabase = getAdminClient();
  const { id }   = req.query;

  // ── GET: list all papers with output status ───────────────────────────────
  if (req.method === 'GET') {
    const { data: papers, error } = await supabase
      .from('study_papers')
      .select('*, study_outputs(id, version, source_type, generated_at)')
      .order('phase', { ascending: true })
      .order('added_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Reshape: add v1_status, v2_status flags
    const result = (papers || []).map(p => {
      const outputs = p.study_outputs || [];
      return {
        ...p,
        study_outputs: undefined,
        v1_output: outputs.find(o => o.version === 'v1') || null,
        v2_output: outputs.find(o => o.version === 'v2') || null,
      };
    });

    return res.status(200).json({ papers: result });
  }

  // ── POST: add a paper ─────────────────────────────────────────────────────
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

  // ── PATCH: update a paper (e.g. set/correct PMID) ────────────────────────
  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });
    const allowed = ['pmid', 'title', 'authors', 'journal', 'year', 'specialty', 'phase', 'is_pilot'];
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

  // ── DELETE: remove a paper (cascades to outputs/grades) ──────────────────
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id query param required.' });

    const { error } = await supabase.from('study_papers').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
