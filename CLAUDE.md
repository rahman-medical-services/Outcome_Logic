# OutcomeLogic — Session Instructions

## Read these files immediately at the start of every session, in this order, before doing anything else:

1. `docs/SOUL.md` — who Saqib is and how to work with him
2. `docs/HANDOVER.md` — current project state, architecture, known gotchas, priority order
3. `docs/LEARNINGS.md` — mistakes already made and fixed; do not repeat them
4. `docs/FEATURES.md` — feature backlog and priority order

Do not ask for a task until you have read all four. Do not summarise what you have read unless asked.

## Project in one sentence

OutcomeLogic is a full-stack AI-powered clinical trial analysis engine: users supply a PDF or DOI/PMID and receive a structured extraction dashboard (PICO, outcomes, risk of bias, GRADE, subgroups, adverse events, expert context). A 3-node Gemini pipeline extracts and adjudicates; a Phase 0 validation study is in progress to identify and fix systematic extraction errors before scaling.

## Tech stack

- **Frontend:** Vanilla JS SPA (`public/index.html` + modules), Tailwind CSS CDN, Chart.js, Supabase JS client
- **Backend:** Vercel serverless functions (`api/` directory, ESM)
- **AI:** Google Gemini API — gemini-2.5-flash (extractors), gemini-2.5-pro (adjudicator)
- **DB:** Supabase (Postgres + auth)
- **Rate limiting:** Upstash Redis (100 calls/24 hr per IP)
- **PDF parsing:** pdf-parse
- **Deployment:** Vercel (outputDirectory: `public`, buildCommand: `node scripts/generate-env.js`)

## Key source files (read on demand, not upfront)

- `lib/pipeline.js` — 3-node extraction pipeline: Extractor A + B (parallel), Adjudicator. Read when working on prompts or pipeline logic.
- `lib/commentary.js` — Node 4: Europe PMC / PubMed Entrez expert context. Read when working on commentary.
- `api/analyze.js` — Main analysis endpoint (rate-limited, PDF/DOI fetch, pipeline call).
- `public/index.html` — Main SPA (~1300 lines). Read specific sections on demand.
- `supabase/schema-study.sql` — Validation study schema. Read when working on study infrastructure.
- `docs/PIPELINE_SPEC.md` — Full technical specification for the pipeline and Phase 0 study.

## Critical deployment checks (before every push to main)

```bash
grep "API_BASE_URL" public/index.html          # must show /api (never a hardcoded URL)
grep -c "<style>" public/index.html            # must show 1
node -e "import('./lib/pipeline.js')"          # syntax check
node -e "import('./lib/commentary.js')"        # syntax check
```

## To close a session

Type `/outcomelogic-close` to run the session close procedure. This updates HANDOVER.md, FEATURES.md, LEARNINGS.md, and memory files to reflect what was done.
