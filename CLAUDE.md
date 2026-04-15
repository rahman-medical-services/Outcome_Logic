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
- **AI:** Google Gemini API — **raw fetch() only, NO SDK** — gemini-2.5-flash-lite (all nodes), gemini-2.5-flash (escalation). See LEARNINGS.md "Gemini API — Systematic 503 Failures" before touching any Gemini code.
- **DB:** Supabase (Postgres + auth)
- **Rate limiting:** Upstash Redis (100 calls/24 hr per IP)
- **PDF parsing:** pdf-parse
- **Deployment:** Vercel (outputDirectory: `public`, buildCommand: `node scripts/generate-env.js`)

## Key source files (read on demand, not upfront)

- `lib/pipeline.js` — 3-node extraction pipeline: Extractor A + B (sequential), Adjudicator. Raw fetch, no SDK, thinkingBudget:512. Read when working on prompts or pipeline logic.
- `lib/commentary.js` — Node 4: Europe PMC / PubMed Entrez expert context. Read when working on commentary.
- `api/analyze.js` — Main analysis endpoint (rate-limited, PDF/DOI fetch, pipeline call).
- `public/index.html` — Main SPA (~1300 lines). Read specific sections on demand.
- `supabase/schema-study.sql` — Validation study schema. Read when working on study infrastructure.
- `docs/PIPELINE_SPEC.md` — Full technical specification for the pipeline and Phase 0 study.
- `docs/ERROR_TAXONOMY.md` — 7-class extraction error taxonomy, Phase 0 analysis sheet, phase scope. Read when grading or designing grading infrastructure.

## Critical deployment checks (before every push to main)

```bash
grep "API_BASE_URL" public/index.html          # must show /api (never a hardcoded URL)
grep -c "<style>" public/index.html            # must show 1
node -e "import('./lib/pipeline.js')"          # syntax check
node -e "import('./lib/commentary.js')"        # syntax check
```

Required Vercel environment variables (server-side — never in public/env.js):
- `GEMINI_API_KEY` — Extractor A, Adjudicator, Node 4
- `OPENAI_API_KEY` — Extractor B (gpt-4o-mini). If absent, pipeline falls back to Gemini for both extractors.

## Git workflow

Work directly on a feature branch in the main checkout — do NOT use worktrees.

```bash
# Session start: branch from main
git checkout main && git pull
git checkout -b claude/<short-name>

# Session end: merge to main, push
git checkout main
git merge claude/<short-name> --no-ff
git push origin main
```

Worktrees were used in earlier sessions and caused branch staleness (sweet-mccarthy missed Session 4 changes from competent-borg). Direct branching avoids this.

## To close a session

Type `/outcomelogic-close` to run the session close procedure. This updates HANDOVER.md, FEATURES.md, LEARNINGS.md, and memory files to reflect what was done.
