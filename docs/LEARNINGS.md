---
id: "learnings"
type: "error-log"
version: 1
created: 2026-04-12
owner: "saqib"
---

# LEARNINGS — Mistakes, Dead Ends, and Fixes

This file is a living log of things that were tried and failed, misunderstandings that wasted time, and corrections that resolved them. Read at the start of each session. Add to it immediately when a mistake is identified — do not wait until the end of a session.

Format: what was tried → what happened → what the correct approach is → date.

---

## Pipeline Architecture

### Parallel extractors are not a safety net against shared bias
**Tried:** Assuming two parallel Gemini extractors provide independent validation.
**What happened:** Both extractors use the same model family, receive identical input, and ran identical prompts. On ambiguous papers — where multiple plausible values exist — they consistently pick the same wrong one. The adjudicator then confirms consensus. The output looks clean and has passed all structural validation, but the extracted value is wrong.
**The correct mental model:** Parallel extraction prevents random noise, not correlated bias. Agreement on ambiguous papers is a risk signal, not a quality signal.
**Fix:** Split extractor prompts to create genuinely different extraction priorities (A = adjusted/ITT priority; B = first-reported/results-section priority). Add source citations to surface source disagreement even when values agree.
**Date:** 2026-04-12

### Adjudicator passive framing resolves disagreement but ignores suspicious agreement
**Tried:** Adjudicator prompt: "Compare two reports, resolve discrepancies, favour more specific values."
**What happened:** When extractors agree, the adjudicator does nothing. It has no instruction to check whether the agreed value is actually correct or whether an alternative exists in the paper.
**Fix:** Adversarial adjudicator framing: explicitly check agreement cases for (a) whether the same source is cited, (b) whether an alternative value exists in the paper that was not extracted. Flag as SUSPICIOUS_AGREEMENT when both agree but multiple candidates exist.
**Date:** 2026-04-12

---

## Deployment

### `API_BASE_URL` must always be `/api` (relative)
**Tried:** Hardcoding the production Vercel URL in `public/index.html` during development.
**What happened:** Works locally but breaks in production when the URL changes or in preview deployments. Also leaks the production URL into the source.
**Fix:** Always use `/api` (relative). The `generate-env.js` script injects this at build time. Check with `grep "API_BASE_URL" public/index.html` before every push.
**Date:** Pre-April 2026

### Multiple `<style>` tags in `public/index.html` break Vercel build
**Tried:** Adding inline styles directly during development.
**What happened:** Vercel build processes the file and additional style tags cause conflicts.
**Fix:** Always check `grep -c "<style>" public/index.html` = 1 before pushing.
**Date:** Pre-April 2026

### ESM import syntax in Vercel serverless functions
**Tried:** Using CommonJS `require()` in api/ files.
**What happened:** All api/ files use ESM (`import`). Mixing CommonJS causes runtime errors in Vercel.
**Fix:** Always use `import` / `export` in api/ and lib/ files. Verify with `node -e "import('./lib/pipeline.js')"`.
**Date:** Pre-April 2026

---

## Node 4 / Commentary

### HALT-IT DOI has parentheses that break resolution
**What happens:** The HALT-IT DOI contains parentheses that confuse the DOI-to-PMID resolver. Caused `pmid_unresolved` silently.
**Fix:** Lancet parentheses fix applied in `_resolvePmidFromDoi`. Verify after every deploy with the console log check.
**Date:** Pre-April 2026

### `[postProcess] expertContext status: error` is not always a bug
**What happens:** This log appears when Node 4 times out (45s). Root cause is usually slow PubMed esummary on papers with large PMID lists, not a code bug.
**Fix:** Acceptable for now. Do not chase this until the timeout causes unacceptable UX.
**Date:** Pre-April 2026

### Institution acronyms (FNCLCC, FFCD, EORTC) cause name search noise
**Tried:** Running name search for all trial identifiers.
**What happened:** Federation acronyms return large volumes of irrelevant results.
**Fix:** Institution blocklist in commentary.js. These skip name search but citation items still render correctly.
**Date:** Pre-April 2026

---

## Supabase Schema

### Current `schema-study.sql` does not match the Phase 0 validation study spec
**Tried:** Assuming the existing `supabase/schema-study.sql` was the correct schema for the validation study.
**What happened:** The file has 5-point Likert grading (`pico_accuracy`, `statistical_accuracy` etc.) and `study_outputs` (not `study_extractions`) — it is an earlier, superseded design. The pilot papers in the SQL file (CRASH-2, SPRINT, CheckMate 214, etc.) are also different from the agreed Phase 0 list.
**Fix:** Full schema rebuild required per HANDOVER.md Section 4 spec.
**Date:** 2026-04-12

---

## Code Review

### LLM code review without project context produces generic and often wrong critique
**Tried:** Passing only source files to an LLM code reviewer without HANDOVER.md and LEARNINGS.md context.
**What happened (Medefer project lesson, applicable here):** Reviewer flagged deliberate design decisions as bugs, missed actual issues, recommended implementing features that were already built. Wasted significant session time.
**Fix:** Any LLM adversarial review of OutcomeLogic must include HANDOVER.md and LEARNINGS.md as context. Without them, the reviewer has no frame to distinguish intentional architecture from bugs.
**Date:** 2026-04-12

---

## Process

### Asking questions answerable from the codebase
**Tried:** Asking about pipeline architecture before reading pipeline.js.
**Fix:** Always read available source files before asking questions that could be answered from the project itself. Reserve clarifying questions for genuine ambiguities: domain knowledge, business logic, or information that cannot be derived from the files.
**Rule:** If the answer is in the codebase, find it. Don't ask.
**Date:** 2026-04-12

### Phase 0 papers differ between handover and schema
**Tried:** Assuming the 10 papers in `schema-study.sql` (CRASH-2, SPRINT, etc.) were the agreed Phase 0 list.
**What happened:** The April 2026 handover specifies a different list (ORBITA, HIP ATTACK, SPORT, etc. — surgical RCTs). The SQL papers were chosen for pipeline stress-testing; the handover list covers surgical RCTs matching OutcomeLogic's primary user base.
**Resolution (2026-04-12):** Schema rebuilt with the agreed surgical RCT list, plus OPTIMAS (2024, PMID 39491870) substituted for EXCEL (highly cited, likely in training data). Final set: 9 landmark surgical RCTs + 1 post-training-cutoff paper. Each paper chosen to stress a specific pipeline failure mode.
**Date:** 2026-04-12

---

---

## Gemini API — Systematic 503 Failures (2026-04-13)

### Both `@google/generative-ai` and `@google/genai` SDKs cause systematic 503 errors
**Tried:** Migrating from `@google/generative-ai` to `@google/genai` to fix 503s. Both SDKs cause identical 503 failures.
**What happened:** The 503 errors look like "high demand / overloaded" but are not. They occur on the first call, consistently, regardless of time of day, even with tiny payloads — if a large system instruction is present.
**Root cause confirmed via curl:** Identical payloads sent as raw `fetch()` succeed; sent via either SDK, 503. The SDKs add something to the request construction that the API rejects with a misleading 503.
**Fix:** Remove ALL SDK dependencies. Use raw `fetch()` to the v1beta REST endpoint directly. Pattern already existed in `api/search.js`. Now used in all Gemini calls across the project.
**Date:** 2026-04-13

### `thinkingBudget: 0` causes 503 on `gemini-2.5-flash` (not a 400 — genuinely misleading)
**Tried:** Setting `thinkingBudget: 0` to disable thinking and reduce latency.
**What happened:** Returns 503 "This model is currently experiencing high demand" — NOT a 400 INVALID_ARGUMENT. Completely misleading error. Wastes hours chasing a capacity problem that doesn't exist.
**Correct behaviour:** `gemini-2.5-flash` does not support `thinkingBudget: 0`. `gemini-2.5-flash-lite` minimum is 512. `gemini-2.5-pro` requires thinking (0 returns 400).
**Fix:** Always set `thinkingBudget: 512`. This satisfies all models and caps TPM consumption.
**Date:** 2026-04-13

### `gemini-2.5-flash` has persistent 503 errors even with correct configuration
**Tried:** Using `gemini-2.5-flash` as the primary pipeline model.
**What happened:** ~50% per-call 503 rate even outside US peak hours, on a paid tier, with correct thinkingBudget, single sequential requests. Not transient.
**Root cause:** TPM (tokens per minute) throttling. The large extractor system instructions (~4000 tokens) + paper text + thinking tokens exceed per-minute quota on flash.
**Fix:** Use `gemini-2.5-flash-lite` as primary. Same 1M token input limit, same output quality for extraction tasks, reliably available. Full flash reserved for escalation.
**Date:** 2026-04-13

### Parallel extractor calls trigger per-second concurrency 503s
**Tried:** Running Extractor A and Extractor B via `Promise.all` (simultaneously).
**Confirmed via curl:** Two simultaneous requests from same API key → one 503s, every time. Single sequential requests work.
**Fix:** Sequential: Extractor A → await → Extractor B → await → Adjudicator. Adds ~5-15s per run, stays within 60s Vercel timeout.
**Date:** 2026-04-13

### Model availability varies unexpectedly by account
**Tried:** `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-flash-latest` as fallback models.
**What happened:** All return 404 "no longer available to new users" despite appearing in documentation. `gemini-2.5-pro` as fallback returns 503 and then times out Vercel at 60s (thinking mode too slow).
**Fix:** Before using any model name in code, verify with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=KEY" | jq '.models[].name'`. Available on this account: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-2.0-flash-001`.
**Date:** 2026-04-13

### Vercel build cache serves stale `node_modules` after `package.json` changes
**Tried:** Changing `package.json` dependencies and pushing — build shows "up to date in 3s" and uses old packages.
**What happened:** Vercel restores `node_modules` from cache before `npm install` runs. If the lock file hasn't changed or is missing, npm sees everything as satisfied.
**Fix:** Commit `package-lock.json` with every `package.json` change. If still stale: Vercel → Deployments → "..." → Redeploy → uncheck "Use existing Build Cache".
**Date:** 2026-04-13

---

## Session 2 Fixes (2026-04-12)

### `buildSourceContext()` must be the single source-of-truth for pipeline input formatting
**Tried:** Inline `[SOURCE:][PMID:]` prefix construction in `api/analyze.js` independent of `lib/pipeline.js`.
**What happened:** Duplicate implementations diverge silently over time. If `buildSourceContext()` evolves, `analyze.js` produces different input than `study-run.js`.
**Fix:** Exported `buildSourceContext` from `pipeline.js`. Both `analyze.js` and `study-run.js` now import and call it.
**Date:** 2026-04-12

### `verifySource()` keyword filter was too permissive
**Tried:** `w.length > 3`, threshold `>= 0.35`.
**What happened:** Short words ('and', 'for', 'with') inflated match counts. Almost any document passed 35%, making verification decorative.
**Fix:** `w.length > 5`, threshold `>= 0.50`. Short function words excluded; match threshold is meaningful.
**Date:** 2026-04-12

### API key in URL in `api/search.js` `callGemini()`
**Tried:** `fetch(url + '?key=' + GEMINI_API_KEY)` — raw REST call.
**What happened:** API key appears in server-side logs on the server side (Vercel function logs). Acceptable in serverless context as logs are private to the project owner, but was flagged as inconsistent.
**Fix (2026-04-12):** Refactored to SDK temporarily. **Reverted (2026-04-13):** All Gemini calls now use raw `fetch()` with key in URL — this is now the deliberate architecture for all files, not a bug. The key is only ever in server-side logs, never sent to the client. This is the correct approach given SDK instability.
**Date:** 2026-04-12 / updated 2026-04-13

### `_scoreCitation()` excluded follow-up RCTs and meta-analyses
**Tried:** Title-keyword-only scoring.
**What happened:** Follow-up RCTs don't contain 'comment'/'editorial' in titles. Scored 0. Excluded before the `MEANINGFUL_THRESHOLD` gate — high-value follow-up evidence silently dropped.
**Fix:** Added pubType signal scoring (meta-analysis: +3, systematic review: +3, RCT: +2, clinical trial: +1, guideline: +3).
**Date:** 2026-04-12
