// config/constants.js
// Browser-safe constants.
// All runtime values read from window.ENV (injected by index.html).
// Server-side code (api/*.js) reads from process.env directly — does not import this file.

// ─────────────────────────────────────────────
// VERSION
// ─────────────────────────────────────────────
export const APP_VERSION = '4.0.0';
export const APP_NAME    = 'OutcomeLogic';

// ─────────────────────────────────────────────
// RUNTIME CONFIG
// Read from window.ENV injected by index.html.
// Fallbacks are for local development only.
// ─────────────────────────────────────────────
export const SUPABASE_URL      = window.ENV?.SUPABASE_URL      || '';
export const SUPABASE_ANON_KEY = window.ENV?.SUPABASE_ANON_KEY || '';
export const API_BASE_URL      = window.ENV?.API_BASE_URL      || 'https://app.rahmanmedical.co.uk/api';
export const INTERNAL_API_TOKEN = window.ENV?.INTERNAL_API_TOKEN || '';

// ─────────────────────────────────────────────
// BATCH
// ─────────────────────────────────────────────
export const BATCH_MAX_FILES    = 20;
export const BATCH_JOB_DELAY_MS = 3000;

// ─────────────────────────────────────────────
// LIBRARY
// ─────────────────────────────────────────────
export const LIBRARY_TABLE = 'trials';

// ─────────────────────────────────────────────
// FEATURE FLAGS
// ─────────────────────────────────────────────
export const FEATURES = {
  library:    true,
  batch:      true,
  export:     true,
  validation: true,
  paidTier:   false,
};