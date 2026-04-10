// api/study-output.js
// Returns the full output_json for a single study output.
// Admin-only: requires INTERNAL_API_TOKEN + admin-tier JWT.
//
// GET /api/study-output?id=<output_uuid>

import { createClient } from '@supabase/supabase-js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const user = await requireAdmin(req, res);
  if (!user) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id query param required.' });

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('study_outputs')
    .select('id, paper_id, version, output_json, source_type, generated_at')
    .eq('id', id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Output not found.' });

  return res.status(200).json({ output: data });
}
