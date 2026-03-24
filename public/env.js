// public/env.js
// Runtime environment configuration.
// This file is NEVER replaced during deployment — it is the safe home for
// all browser-facing config values. index.html loads it before any module code.
//
// SECURITY NOTE:
//   SUPABASE_URL and SUPABASE_ANON_KEY  — safe to expose (RLS enforced)
//   INTERNAL_API_TOKEN                  — low-risk (server also validates JWT)
//   SUPABASE_SERVICE_ROLE_KEY           — NEVER put here, server-side only

window.ENV = {
  SUPABASE_URL:       'https://qsaxtelxrvfelinafult.supabase.co',
  SUPABASE_ANON_KEY:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzYXh0ZWx4cnZmZWxpbmFmdWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNzY5ODgsImV4cCI6MjA4OTY1Mjk4OH0.KpMIMeZwn033IwWICEpb3Ye89hX5KwvJJmf_ZTEWhYE',
  API_BASE_URL:       'https://app.rahmanmedical.co.uk/api',
  INTERNAL_API_TOKEN: 'surgeon-secure-key-99',
};