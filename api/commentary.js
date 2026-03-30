// api/commentary.js
// On-demand Node 4: Expert Context / Evidence Commentary.
// Called by the frontend AFTER analysis when the user clicks "Load Expert Commentary".
// Node 4 no longer fires automatically on every analysis run.

import { Ratelimit }     from '@upstash/ratelimit';
import { Redis }         from '@upstash/redis';
import { fetchExpertContext } from '../lib/commentary.js';

export const config = {
  api:         { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 60,
};

// Separate, lighter rate limit for commentary — 30 per IP per 24h
const ratelimit = new Ratelimit({
  redis:     Redis.fromEnv(),
  limiter:   Ratelimit.slidingWindow(30, '24 h'),
  analytics: true,
  prefix:    'commentary',
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  // Auth
  const authToken = req.headers['x-api-token'];
  if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1';
  const { success } = await ratelimit.limit(ip);
  if (!success) {
    return res.status(429).json({ error: 'Commentary rate limit reached. Please try again later.' });
  }

  const { pmid, pmcid, doi, trial_name, year, full_title } = req.body || {};

  if (!pmid && !pmcid && !doi && !trial_name) {
    return res.status(400).json({
      error: 'At least one identifier required (pmid, pmcid, doi, or trial_name).',
    });
  }

  try {
    console.log(`[Commentary] On-demand — pmid:${pmid} trial:"${trial_name}"`);

    // Construct sourceMeta from the identifiers the frontend already has
    // from the completed analysis. Pass empty string for reportA — PMID
    // resolution falls through to sourceMeta directly.
    const sourceMeta = {
      pmid:       pmid                      || null,
      pmcid:      pmcid                     || null,
      doi:        doi                       || null,
      trialName:  trial_name               || null,  // commentary.js reads sourceMeta.trialName
      trialTitle: full_title || trial_name || null,  // commentary.js reads sourceMeta.trialTitle
      year:       year                      || null,
      sourceType: 'on-demand',
    };

    const result = await fetchExpertContext(sourceMeta, '');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Commentary] Error:', err.message);
    return res.status(500).json({
      status:    'error',
      error:     err.message,
      synthesis: null,
      items:     [],
    });
  }
}