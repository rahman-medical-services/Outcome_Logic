// config/constants.js
// Single source of truth for all configuration values.
// Backend (Node/Vercel): import directly.
// Frontend (browser): values are inlined at build time or read from window.ENV.

// ─────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────
export const APP_VERSION  = '4.0.0';
export const APP_NAME     = 'OutcomeLogic';
export const APP_TAGLINE  = 'Clinical Trial Evidence Engine';

// ─────────────────────────────────────────────
// API
// Backend: reads from process.env (Vercel environment variables)
// Frontend: reads from window.ENV injected by index.html, or falls back
//           to the hardcoded dev values below for local development only.
// ─────────────────────────────────────────────
function env(key, fallback = '') {
  // Node / Vercel serverless
  if (typeof process !== 'undefined' && process.env?.[key]) {
    return process.env[key];
  }
  // Browser — values injected by the HTML shell
  if (typeof window !== 'undefined' && window.ENV?.[key]) {
    return window.ENV[key];
  }
  return fallback;
}

// Internal handshake token — never expose the real value in source control
export const INTERNAL_API_TOKEN = env('INTERNAL_API_TOKEN', 'surgeon-secure-key-99');

// API base URL — points to Vercel deployment
// In development: http://localhost:3000/api
// In production:  https://app.rahmanmedical.co.uk/api
export const API_BASE_URL = env('API_BASE_URL', 'https://app.rahmanmedical.co.uk/api');

// ─────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────
export const SUPABASE_URL      = env('SUPABASE_URL');
export const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');

// Service role key — ONLY used in serverless functions, never in the browser
export const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');

// ─────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────
export const GEMINI_API_KEY = env('GEMINI_API_KEY');
export const GEMINI_MODEL   = 'gemini-2.5-flash';
export const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─────────────────────────────────────────────
// NCBI / PUBMED
// ─────────────────────────────────────────────
export const NCBI_TOOL  = 'rahmanmedical-trial-visualiser';
export const NCBI_EMAIL = 'saqib@rahmanmedical.co.uk';
export const NCBI_BASE  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
// Upstash sliding window — 100 individual API calls per IP per 24h
// At ~5 calls per full pipeline run, this allows ~20 full analyses per day
export const RATE_LIMIT_CALLS    = 100;
export const RATE_LIMIT_WINDOW   = '24 h';
export const RATE_LIMIT_PREFIX   = 'trial-visualiser';

// Batch processing — delay between sequential PDF jobs (ms)
// Keeps Gemini call rate well within limits
export const BATCH_JOB_DELAY_MS  = 3000;

// Maximum PDFs in a single batch upload
export const BATCH_MAX_FILES     = 20;

// ─────────────────────────────────────────────
// ANALYSE PIPELINE
// ─────────────────────────────────────────────
// Soft cap on extractor output — runaway guard only (Gemini 2.5 Flash = 1M token context)
export const EXTRACTOR_OUTPUT_CAP = 40000;

// Minimum character counts for source tier acceptance
export const MIN_CHARS = {
  FULLTEXT: 2000,
  ABSTRACT: 200,
  JINA:     1000,
};

// Source type labels — used in UI badges and Supabase source_type field
export const SOURCE_TYPES = {
  'full-text-pmc':  'Full Text (PMC)',
  'full-text-jina': 'Full Text (Web)',
  'full-text-pdf':  'Full Text (PDF)',
  'abstract-only':  'Abstract Only',
  'pasted-text':    'Pasted Text',
  'url':            'URL',
};

// ─────────────────────────────────────────────
// LIBRARY
// ─────────────────────────────────────────────
export const LIBRARY_TABLE = 'trials';

// ─────────────────────────────────────────────
// FEATURE FLAGS
// Flip these to enable/disable features without code changes.
// When paid tiers are introduced, these will be driven by user.tier.
// ─────────────────────────────────────────────
export const FEATURES = {
  library:       true,   // Save to / browse library
  batch:         true,   // Batch PDF upload
  export:        true,   // JSON + PDF export
  validation:    true,   // Validation queue
  paidTier:      false,  // Paid tier gating (not yet implemented)
};