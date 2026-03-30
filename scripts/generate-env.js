// scripts/generate-env.js
// Run by Vercel at build time to generate public/env.js from environment variables.
// Never committed — public/env.js is in .gitignore.

import { writeFileSync } from 'fs';

const env = {
  SUPABASE_URL:      process.env.SUPABASE_URL      || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  API_BASE_URL:      process.env.API_BASE_URL       || '/api',
  INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || '',  
};

const content = `// Auto-generated at build time by scripts/generate-env.js — do not commit.
window.ENV = ${JSON.stringify(env, null, 2)};
`;

writeFileSync('public/env.js', content);
console.log('[generate-env] public/env.js written');