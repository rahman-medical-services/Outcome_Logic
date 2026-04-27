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

---

## Session 5 (2026-04-14)

### Branches created from main may not include hotfixes committed to feature branches
**Tried:** Assuming `claude/sweet-mccarthy` (branched from main) had the Session 4 SDK fixes because HANDOVER.md described them as complete.
**What happened:** The Session 4 SDK removal was committed to `claude/competent-borg` and merged to main *after* `sweet-mccarthy` was branched. The `sweet-mccarthy` worktree still had `@google/generative-ai` SDK, `gemini-2.5-flash`, and `Promise.all` parallel extractors. The HANDOVER described the work as complete, which it was — but on a different branch.
**Fix:** Always check `grep "generative-ai\|GEMINI_MODEL\|Promise.all" lib/pipeline.js` at session start when switching branches to verify the Session 4 state.
**Date:** 2026-04-14

### Adjudicator cannot detect errors it has no candidates for — `candidate_values` is the structural fix
**Tried:** Relying on adjudicator adversarial framing ("check for alternative values in the paper") to surface extraction errors.
**What happened:** Two independent critiques (Gemini, GPT) identified the same root problem: the adjudicator can only rank candidates it has been given. If both extractors converge on the same wrong value and surface no alternatives, the adversarial framing fires vacuously — it sees no competing candidates and confirms consensus. The most dangerous failure mode (correlated misread of ambiguous table) is structurally undetectable without candidates.
**Fix:** Extractors now required to output a `candidate_values` list (max 3) for every primary endpoint extraction, covering all plausible alternatives. Adjudicator compiles these into `primary_endpoint_candidates` and ranks. The adjudication problem is now ranking over a provided set, not open-ended search. This eliminates 5 of 8 GPT failure cases.
**Limitation:** Correlated table misread (both extractors misread the same table identically) still produces a single candidate and remains undetectable. This is the residual failure mode for Phase 0.
**Date:** 2026-04-14

### Source citations may be partially synthetic (undetectable, tolerated)
**Tried:** Assuming `source_citation` fields contain verbatim text from the paper.
**What happened:** ChatGPT critique (2026-04-14) identified that when no clean 30-word snippet exists in a messy table, extractors produce citations that look valid but are not verbatim. These synthetic citations are used by the adjudicator for ranking context.
**Why tolerated:** Citations are used internally for ranking, not displayed verbatim to users. Partial synthetics are better than no citations. Structurally unfixable without OCR-level grounding.
**Risk:** If both extractors produce similar synthetic citations for the same wrong value, the adjudicator may treat this as source confirmation. Flag during Phase 0 PI review by manually checking cited locations.
**Date:** 2026-04-14

### `Promise.all` in Node 4 drops all partial results on single API failure
**Tried:** Running EPMC citations, name search, and PubMed Entrez in `Promise.all`.
**What happened:** Gemini critique correctly identified that if PubMed Entrez hangs past the 45s timeout, all three API results are discarded. EPMC data that completed in 2s is lost. Same problem applied to abstract batch fetching and `_runSynthesis`.
**Fix:** All four `Promise.all` calls in `commentary.js` replaced with `Promise.allSettled` + graceful per-result fallback. Partial Node 4 output now salvageable.
**Date:** 2026-04-14

---

## Session 6 (2026-04-15)

### `gpt-5-mini` (and o-series reasoning models) do not support temperature or standard token limits
**Tried:** Using `gpt-5-mini` as Extractor B candidate. Test curl with `max_tokens` and `temperature: 0.05`.
**What happened:**
1. `max_tokens` → 400 error "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
2. After fix: `temperature: 0.05` → 400 error "temperature does not support 0.05 with this model".
**Root cause:** `gpt-5-mini` is a reasoning model (like o1/o3 family) — internal reasoning tokens, no temperature control, very slow on large inputs (~30s on tiny payload).
**Fix:** Use `gpt-4o-mini` instead. Supports temperature, `max_completion_tokens`, responds in ~3–10s, no internal reasoning tokens. Do NOT use reasoning models for extraction.
**Date:** 2026-04-15

### OpenAI API requires `max_completion_tokens` not `max_tokens` on recent models
**Tried:** `max_tokens: 8000` in OpenAI request body.
**What happened:** 400 error "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." Applies to `gpt-4o-mini`, `gpt-5-mini`, and all models released after a certain point.
**Fix:** Always use `max_completion_tokens` in `callOpenAI()`. `max_tokens` is legacy.
**Date:** 2026-04-15

### Parallel extractors are safe when running on different API providers
**Previous learning (Session 4):** `Promise.all` on two simultaneous Gemini calls from the same key → one 503s every time. Parallel requires sequential for Gemini.
**New finding (Session 6):** `Promise.all([callGemini(...), callOpenAI(...)])` is safe — different providers, different keys, no shared concurrency limit. Confirmed in HIP ATTACK run at ~47s total.
**Rule:** Parallel is safe only when different providers. Same-key same-provider = sequential.
**Date:** 2026-04-15

### Vercel `maxDuration` defaults to 10s for Hobby plan — must be explicitly set
**Tried:** Assuming 60s (the previous explicit setting) covered the parallel extractor run.
**What happened:** Sequential Gemini A (~24s) + Gemini B (~26s) + Adjudicator (~10s) = ~60s before parallel. After parallel switch, ~47s, but the explicit setting provides safety margin. Must be set in `vercel.json` per function.
**Fix:** `api/analyze.js` is set to `maxDuration: 120` in `vercel.json`. Hobby plan hard max is 60s — this requires Pro plan. Confirmed Pro plan in use.
**Date:** 2026-04-15

---

## Session 10 (2026-04-17) — Phase 1 Paper Running Findings

### V3 extractor prompts are systematically inferior to V1 — root cause identified
**Tried:** Assuming V3's multi-node adjudicated pipeline would outperform V1's single-pass extraction.
**What happened (DEDICATE Phase 1 run):**
- V3 AE table: 13 entries including AF (12.4%/30.8%), LBBB (23%/17.5%), stroke (2.9%/4.7%), pacemaker (11.8%/6.7%) — all trial endpoints, not complications.
- V3 subgroups: zero (despite 13 pre-specified subgroups in the paper). V1: all 13 correctly extracted.
- V3 chart: blank page (no bar chart, no forest plot). V1: bar chart (TAVI 5.4% vs SAVR 10%) + forest plot.
- V3 primary outcome NI framing: "95% CI did not exclude this margin (CI upper bound 0.79)" — factually inverted. V1: correct.
**Root cause:** `_EXTRACTOR_SHARED_SECTIONS` was written independently of V1 and has weaker, more hedged language, no explicit AE endpoint-exclusion rule, vague chart instructions (y=0 placeholder), and conditional subgroup language where V1 uses imperatives.
**Key insight:** The adjudicator can only compile what the extractors surface. AE misclassification and subgroup omissions were generated at the extractor level. Adjudicator-only fixes are insufficient — the rules must be at the extractor level.
**Fix:** Full rebuild of `_EXTRACTOR_SHARED_SECTIONS` on V1 foundations planned — see HANDOVER.md Session 11 priority. V3 architecture (dual extractors + adjudicator) remains correct; the extractor prompt body is what needs to be V1-quality.
**Date:** 2026-04-17

### Adjudicator-only rules cannot fix extractor-level correlated errors
**Tried:** Adding AE classification rule and subgroup completeness instruction to adjudicator only.
**What happened:** Both fixes had no effect on V3 output because both Extractor A and Extractor B were generating the same error (endpoints in AE table, zero subgroups). The adjudicator receives two reports that both contain the error, treats them as agreement, and produces the error in output. This is the "suspicious agreement" failure mode — both models agree on the wrong thing.
**Correct model:** Rules that prevent correlated extraction errors must live in `_EXTRACTOR_SHARED_SECTIONS` (both extractors) not in the adjudicator. The adjudicator handles discrepancies between extractors; it cannot fix errors they both share.
**Date:** 2026-04-17

### NI margin CI interpretation can be inverted by LLMs — explicit direction rule required
**Tried:** Adjudicator prompt saying "state whether the 95% CI excludes the NI margin".
**What happened (DEDICATE):** Adjudicator output stated "95% CI did not exclude this margin (CI upper bound 0.79)" when the NI margin was 1.14. CI upper 0.79 < NI margin 1.14 means the CI DOES exclude the margin — NI is demonstrated. The adjudicator inverted the logic.
**Root cause:** "Excludes" is ambiguous. The LLM may interpret "CI excludes the margin" as "the CI does not contain the margin value within its range" or the opposite.
**Fix:** Explicit directional rule: "CI upper bound < NI margin → CI excludes margin → NI demonstrated. CI upper bound > NI margin → CI includes margin → NI not demonstrated." Added to both adjudicator and extractor shared sections.
**Date:** 2026-04-17

### V3 chart blank because adjudicator was not told what y-values represent
**Tried:** Expecting adjudicator to populate `arms[].data_points[].y` with per-arm event rates.
**What happened:** The adjudicator schema showed `"y": 0` as a placeholder. No instruction on what y should be. The adjudicator left y=0, producing blank charts. V1 works because the V1 prompt explicitly states "y values are percentages as raw numbers (74 means 74%, not 0.74)."
**Fix:** Adjudicator schema comment updated: "y = per-arm OBSERVED EVENT RATE as raw percentage (5.4 for 5.4%, NOT 0.054). Use arm_a_value for intervention arm, arm_b_value for control arm. Must be populated — null or 0 produces blank chart."
**Rule:** Any schema field with a numeric placeholder must include an explicit instruction on what the number represents and where it comes from. Placeholders alone are not sufficient.
**Date:** 2026-04-17

### Too many null-interaction subgroups degrades output quality
**Tried:** Extracting ALL pre-specified subgroups regardless of interaction significance (V1 approach).
**What happened (DEDICATE V1):** 13 pre-specified subgroups all with "Interaction null" — 3 pages of subgroup cards, all showing HR ~0.5 across every category. Clinically uninformative and visually overwhelming.
**Fix (Option C):** Tiered extraction rule:
- Significant/borderline (p < 0.10): extract ALL pre-specified subgroups
- Null (p ≥ 0.10): extract maximum 4, clinical priority order: (1) Age, (2) Sex, (3) Disease severity measure, (4) Key domain comorbidity
- Post-hoc: only if p < 0.05
- Hard cap: 8 subgroups total
**To implement:** In `_EXTRACTOR_SHARED_SECTIONS` rebuild (Session 11).
**Date:** 2026-04-17

---

## Session 11 (2026-04-19) — 20-Paper V1 vs V3 Review

### Tight JSON schema is the primary anti-hallucination mechanism, not the 3-node architecture
**Finding:** After reviewing all 20 Phase 0/1 papers in both versions: V1 and V3 score essentially identically on the 25-point rubric (23.4 vs 23.2 average). Primary outcomes are 20/20 clean in both. Residual errors (AE contamination, subgroup grouping) appear in both.
**Implication:** The dominant anti-hallucination mechanism is `responseMimeType: 'application/json'` (forcing structured output), not the dual-extractor + adjudicator architecture. The architecture adds value on specific paper types (competing table values, subgroup completeness cross-check) but does not produce a general accuracy advantage over a well-prompted single-pass extraction.
**Decision framework:** Run upgraded V1 on same papers. If V1 upgraded matches V3, ship V1 as production — lower cost, lower latency, simpler architecture. The comparison study remains publishable either way.
**Date:** 2026-04-19

### Subgroup GROUPING RULE: each variable must produce one item with ≥2 arms, never one item per stratum
**What happened:** V1 (prior to upgrade) and V3 both produced subgroup outputs where age <75 and age ≥75 were two separate items, each with one arm. This is structurally invalid — a subgroup analysis compares strata within a variable and must be grouped as arms of a single item.
**Fix:** Explicit GROUPING RULE added to `_EXTRACTOR_SHARED_SECTIONS`, adjudicator subgroup instructions, and `V1_PROMPT_PREFIX` (V1 upgrade): "All arms belonging to the same variable MUST be grouped under ONE item. An item with only one arm is invalid."
**Date:** 2026-04-19

### AE cross-reference rule must explicitly cover single-event primaries, not just composites
**What happened:** CREST's primary outcome is a single named event. The AE cross-reference rule said "exclude composite components" — which the model interpreted as only applying to composite primaries. It then included the single primary event in the AE table.
**Fix:** Rule rewritten to explicitly state: "if the primary is a SINGLE event (e.g. 'death from any cause'), that single event is also excluded. IMPORTANT: if the primary outcome is a COMPOSITE, ALL individual components are also excluded."
**Date:** 2026-04-19

### isFieldComplete() must enforce correction_text for fail/hallucinated, not just taxonomy+severity
**Tried:** `isFieldComplete` returned true once harm_severity, error_taxonomy, and pipeline_section were set.
**What happened:** A grader could mark a field as `fail`, complete the dropdowns, and navigate away — but leave the correction text blank. This silently dropped the "what is the correct value?" data from the grade record.
**Fix:** For `fail` and `hallucinated` status: `isFieldComplete()` now also checks that `corr-{fieldId}` textarea is non-empty. `oninput` added to textarea so card state and incomplete banner update as the grader types.
**Date:** 2026-04-19

---

## Session 13 (2026-04-23) — Critic Regression Patterns

### LLM critics will apply heuristics globally even when scoped to specific conditions
**Tried:** Added a scale guard to Rule 1 to prevent PARTNER 3's RD CI (-10.8 to -2.5) from being applied to the HR candidate. Guard text said: "HR/OR/RR: CI values MUST be positive numbers close to 1 (typically 0.3–3.0). Negative CI values or values >10 are wrong for this scale."
**What happened:** ORBITA (effect_measure=MD, ci_lower=-8.9) and PROFHER (effect_measure=MD, ci_lower=-1.33) both had their CI nulled out by the critic. The guard was scoped to HR/OR/RR in the prompt but the "negative = wrong" heuristic leaked across outcome types. The critic generated patches with `corrected_value: null` even though the reason text correctly stated the CI values.
**Root cause:** LLMs anchor on surface heuristics. "Negative CI values are wrong" was read globally, not scoped to ratio measures.
**Fix:** Remove all range-based heuristics from Rule 1. Use structural logic only: "match CI to its own candidate row; do not transplant between candidates; if uncertain, do not patch."
**Secondary fix:** Add explicit null-guard: "Only patch if current value is null." Without this, the critic generates patches on correct values, and applyPatches() applies them, overwriting good data.
**Date:** 2026-04-23

### `corrected_value: null` patch + applyPatches() = silent data deletion
**What happened:** When the gpt-4o-mini critic generates a patch with `corrected_value: null`, `applyPatches()` faithfully applies it and sets the field to null. There is no guard in applyPatches() against null writes. This is the mechanism behind regressive patches: critic says the correct value is null (wrong) → patch applied → field cleared.
**Rule:** Any Rule that says "only patch if null" MUST be stated explicitly in the prompt. applyPatches() does not know whether a patch is regressive — it just applies whatever corrected_value the critic provides. The LLM is the last line of defence.
**Date:** 2026-04-23

### Rule 12: "arm_a_events is populated → binary" fires after Rule 8 back-calculation
**Tried:** Rule 12 (outcome type) contained: "binary — effect_measure is OR, RR, or RD; or arm_a_events is populated."
**What happened:** Rule 8 (meta-analysis completeness) back-calculates and patches arm_a_events for HR candidates (e.g. CORONARY: HR, but arm_a_events=233 derived from arm_n × arm_value). Rule 12 then sees arm_a_events populated and reclassifies the candidate as binary. CORONARY and HIP ATTACK outcome_type changed from time_to_event to binary.
**Root cause:** The rules are evaluated sequentially in the LLM's one-pass output, but the patches are applied in order. The model may see the arm_a_events patch from Rule 8 in its working context and use it in Rule 12.
**Fix:** Remove "or arm_a_events is populated" from the binary definition in Rule 12. Outcome type must be determined from effect_measure only. "HR ALWAYS = time-to-event regardless of other fields."
**Date:** 2026-04-23

### stripForCritic: structured abstract headings can prematurely trigger section stripping
**Tried:** Used regex `/\n(Discussion|DISCUSSION|Conclusions|CONCLUSIONS|...)\s*\n/` to find the post-Results section boundary for stripping.
**What happened:** Structured abstracts (JAMA, NEJM style) contain explicit sub-headings like "Conclusions" within the abstract at position ~3000–5000 chars. This matched the regex and stripped everything after the abstract — Methods, Results, and all body text — leaving the critic with 3671 chars of a 56717-char paper (PARTNER 3 confirmed).
**Fix:** `MIN_DISC_POSITION = 15000` — only treat a heading as a genuine section break if it appears past 15000 chars. Anything before that is inside the abstract preamble. Log "likely structured abstract" if heading found below threshold.
**Date:** 2026-04-23

### Fixing a prompt rule without re-running all papers risks introducing new regressions
**Tried:** Implemented 4 fixes (Rule 1 scale guard, Rule 2 primary-only, Rule 6 mandatory, Rule 12) and ran the full 20-paper batch.
**What happened:** The fixes introduced new regressions (ORBITA/PROFHER CI nulled, CORONARY/HIP ATTACK outcome_type wrong) that made the mean rubric score worse than before the fixes.
**Rule:** Before committing a batch of prompt changes, mentally trace each change through 2–3 known paper cases (especially papers with confirmed correct V1 values). Ask: "does this rule change fire on a paper that was already correct?"
**Date:** 2026-04-23

---

## Session 14/15 (2026-04-24) — Post-Processing and Stability Findings

### backCalculateEvents must NOT overwrite direct extraction — priority order is mandatory
**Tried:** `backCalculateEvents()` calculated `arm_a_events = round(arm_n × rate / 100)` and wrote it unconditionally.
**What happened:** BITA had `events_arm_a=140` (correct, directly extracted by V1). Back-calc produced `round(1487 × 9 / 100) = 134`. The function overwrote the correct value with an arithmetic approximation. SYNTAX same: `events_arm_a=205` overwritten with `round(953 × 26.6 / 100) = 253`.
**Root cause:** V1 uses the legacy field name `events_arm_a`; V4 writes to `arm_a_events`. Both exist in the candidate object. The function back-calculated from `arm_n × arm_value` even when `events_arm_a` already had the answer.
**Fix:** Priority 1 = copy `events_arm_a` → `arm_a_events` (direct extraction). Priority 2 = back-calc only when both are null. Tag with `_arm_a_events_source: "extracted" | "back-calculated"` for provenance.
**Rule:** Any arithmetic back-calculation must check for an existing direct extraction first. Back-calc is a fallback, not a default.
**Date:** 2026-04-24

### SD plausibility threshold must be set below the actual contamination ratio, not above it
**Tried:** Initial `backCalculateSD()` plausibility guard used a 2.0× ratio threshold to detect contaminated SD values.
**What happened:** ORBITA had `arm_a_sd=178.7` (baseline exercise time SD, contamination from adjacent table row). Correct value via CI back-calc ≈ 90.2. Ratio = 178.7/90.2 = 1.98. The 2.0 threshold would NOT have triggered — ORBITA would have slipped through.
**Fix:** Lower threshold to 1.75×. Verified against all clean papers: legitimate ratios stay below 1.75. ORBITA (1.98) correctly fires. Gap between clean papers and contamination is large enough that 1.75 is a safe boundary.
**Rule:** When setting a plausibility guard threshold, verify it against the actual known-bad cases, not just intuition. A threshold set at 2.0 "feels safe" but misses real contamination at 1.98.
**Date:** 2026-04-24

### Rule 9 array replacement silently drops fields from the primary candidate
**Tried:** Rule 9 (secondary endpoint completeness) replaces the entire `primary_endpoint_candidates` array when adding new secondary endpoint entries. The critic reconstructs the primary candidate from scratch.
**What happened:** SCOT-HEART primary candidate had `value=0.59` (correct, from V1). After Rule 9 fired, `value` was null in V4 output. The critic's reconstructed primary candidate didn't re-extract the `value` field — it only included fields it saw in its own reasoning pass.
**Root cause:** The critic does not have access to all V1 candidate fields when it reconstructs the array. It only re-populates fields it actively reasons about.
**Fix 1 (prompt):** Rule 9 explicit CRITICAL instruction: "DO NOT reconstruct or omit existing entries — copy ALL fields from the existing primary candidate exactly as supplied."
**Fix 2 (JS guard):** `restoreDroppedCandidateFields()` runs immediately after `applyPatches()`. It snapshots V1 before patches and re-merges any non-null V1 fields that are null post-patch. Belt-and-braces.
**Rule:** Any Rule that replaces an entire array must include an explicit instruction to copy-preserve all existing fields. JS fallback is always needed because LLMs don't reliably copy-preserve.
**Date:** 2026-04-24

### Outcome type naming inconsistency between V1 and critic — normalise post-patch
**Tried:** V1 uses `time_to_event` (underscores). Critic patches use `time-to-event` (hyphens). These are treated as different strings in all equality checks and schema validators.
**What happened:** After critic patches applied `time-to-event`, downstream JS functions (auditMetaAnalysisFields, flagAmbiguousSelection) didn't match the value against their expected `time_to_event` string.
**Fix:** `normaliseOutcomeTypes()` runs after `applyPatches()` and converts `time-to-event` → `time_to_event`. One canonical form throughout the pipeline.
**Rule:** Canonical string enum values must be enforced at normalisation time, not relied upon from both prompt and critic to agree.
**Date:** 2026-04-24

### GRADE guard must block upgrades, not all patches — direction matters
**Tried:** UK FASHIoN GRADE `certainty` varied across runs (Moderate / Low). The critic's Rule 5 occasionally downgrades Moderate → Low.
**What happened (without guard):** Run 3 of 5 produced `Low`. This stochasticity means the V4 GRADE field is unreliable — different runs produce different conclusions.
**Analysis:** The critic can legitimately downgrade if it identifies a methodological concern. It should NOT upgrade (higher certainty is a stronger claim — needs human review). GRADE upgrades require systematic evidence of minimal bias that a prompt-level rule cannot verify.
**Fix:** `gradeOrder` hierarchy in `applyPatches()`. Block patches where `patchedLevel > currentLevel`. Downgrades still applied. UK FASHIoN stochasticity gone — GRADE now locked to V1 extraction unless downgraded by critic.
**Rule:** For quality-of-evidence fields (GRADE, RoB), upgrades require human review and must be blocked programmatically. Downgrades are conservative and may be allowed.
**Date:** 2026-04-24

### coerceNumericFields is required because V1 outputs integers as strings
**Tried:** Running arithmetic on V1 candidate fields directly (arm_n × rate).
**What happened:** V1 JSON output contains integers as quoted strings ("602" not 602). `602 * 0.09 = NaN` when the left operand is a string in JS (no, actually `"602" * 0.09 = 54.18` — JS coerces silently in multiplication but `null` comparisons fail). More importantly: `c.arm_a_n == null` is true when `arm_a_n = "602"` if an explicit null-check is used. Type coercion bugs are silent and hard to spot.
**Fix:** `coerceNumericFields()` runs before all arithmetic. Converts all numeric candidate fields from string to Number if `!isNaN(value)`. Explicit and auditable rather than relying on JS implicit coercion.
**Rule:** Normalise types at the boundary. Don't assume numeric fields from LLM output are numeric primitives — they may be strings.
**Date:** 2026-04-24

### External LLM analysis of pipeline JSON output must be verified against primary data
**Tried:** Reviewing ChatGPT and Gemini analyses of the extraction JSON as a cross-check.
**What happened:** ChatGPT claimed EXCEL `ci_lower` was patched to 0 by the critic. Verified against actual JSON: `ci_lower=0.79`, correctly extracted, no such patch applied. ChatGPT was wrong — possibly on a stale or fabricated example, or confusing it with another field.
**Rule:** External LLM analysis of pipeline output is useful for generating hypotheses (many correct observations were made this session). But every claim must be verified against (a) the actual JSON, (b) the source paper if numeric. Act only on verified claims. Do not implement fixes for problems that don't exist.
**Date:** 2026-04-24

### Legacy field names from earlier schema drift cause silent data loss
**Tried:** V1 prompt was iteratively updated to emit canonical field names (`arm_a_n`, `arm_a_events`); downstream V4 code was rewritten to read those canonical names. The legacy names (`n_arm_a`, `n_arm_b`, `events_arm_a`, `events_arm_b`) from the pre-V4 schema were never centrally migrated.
**What happened:** Across the 20-paper export, ~40 candidates had `arm_a_n: null` while `n_arm_a` held the correct value. The V1 LLM continued emitting legacy keys on most candidates because the prompt examples and field list still referenced both forms. Downstream `auditMetaAnalysisFields()`, `backCalculateSD()`, and the critic itself were reading only canonical names — so the data appeared missing and the audit reported `arm_a_n` as a coverage failure. This was wrongly diagnosed in HANDOVER.md item 5 as a "fundamental PDF-to-text limitation, not fixable at prompt level". It was a canonicalisation miss, not a data-extraction failure.
**Why it stayed hidden:** When the LLM emits `n_arm_a: 891`, every JSON inspector shows the value — but `c.arm_a_n` reads `undefined`/null. Code paths that defensively used `c.arm_a_n ?? c.n_arm_a` masked the issue locally; paths that didn't use the fallback (most of them) silently lost the value. The bug surfaces only when comparing canonical-key reads to the raw JSON.
**Fix:** `canonicaliseLegacyKeys()` runs once, immediately after V1 returns and BEFORE the critic. Migrates legacy → canonical, deletes legacy keys (so no further code can ever read them again), and handles two adjacent dirty inputs: literal string `'null'` (ART trial) and compound fractions like `"159/891"` (SYNTAX). After this pass the canonical name is the single source of truth.
**Rule:** When schemas evolve, do a one-shot migration pass at the boundary, then *delete the old keys*. Never let two name forms coexist in the live data — every consumer becomes a defensive ?? chain or, worse, a silent data-loss site. Defensive ?? fallbacks scattered across the codebase are not a substitute for canonicalisation; they hide the underlying drift.
**Meta-lesson:** A "structural limitation" diagnosis in HANDOVER.md must be challenged when concrete data is available. Item 5 stood as accepted truth across multiple sessions because no one reopened the JSON to check. Always verify a "not fixable" claim against primary data before deciding to leave it.
**Date:** 2026-04-27

### coerceNumericFields scope was incomplete — caused type oscillation across runs
**Tried:** Original `coerceNumericFields()` covered only `arm_a_n`, `arm_b_n`, `arm_a_events`, `arm_b_events`, and the legacy synonyms. `arm_a_value`, `arm_b_value`, `arm_a_sd`, `arm_b_sd`, `value`, `point_estimate`, `ci_lower`, `ci_upper` were left uncovered.
**What happened:** In the 5×5 stability run, TKR `arm_a_value` came back as `32.5` (number) on three runs and `'32.5'` (string) on the other two — the V1 LLM is not deterministic about whether it quotes a numeric value. Downstream consumers that compare with `===` or use numeric ops on these fields would behave inconsistently across runs even when the underlying extraction was identical.
**Fix:** Extended `coerceNumericFields()` to cover all candidate-level numeric fields including `arm_*_value`, `arm_*_sd`, `value`, `point_estimate`, `ci_lower`, `ci_upper`, `n_randomised_arm_a/b`, `total_events`. Coercion gated on `!isNaN(c[f])` to avoid converting deliberate non-numeric strings.
**Rule:** Type-discipline functions are only as good as their field list. Whenever a new candidate-level numeric field is added to the schema, it must also be added to the coercion list. Treat the field list as part of the schema.
**Date:** 2026-04-27

### MD/SMD per-arm fabrication — Rule 7 most dangerous failure mode
**Tried:** Rule 7 ("per-arm values for chart rendering") instructed the critic to populate `arm_a_value` / `arm_b_value` for any null per-arm value when "a per-arm event rate, mean, or median is stated in Results."
**What happened:** For continuous outcomes where the paper reports only the between-arm mean difference (and not per-arm change scores), the critic occasionally patched one arm to the MD itself and the other arm to 0 — a precisely-wrong per-arm change score that looks valid downstream and would silently corrupt any meta-analysis using arm-level means. This is the worst class of failure: numerically plausible, structurally well-formed, semantically false.
**Fix (defence in depth):**
  1. **Prompt:** Augmented Rule 7 with an explicit MD/SMD GUARD section: only patch if the paper EXPLICITLY states per-arm change scores; never set one arm to 0 unless the paper says "no change"; never derive one arm from the other.
  2. **JS guard:** `guardMDFabrication()` — for `effect_measure ∈ {MD, SMD}`, detects the pattern (one arm === 0, other arm ≈ |between-arm difference| within 5%) and resets both per-arm values to null with `_md_fabrication_blocked` provenance. Runs after `applyPatches()`, before back-calculation.
**Rule:** Prompt-level guards are necessary but never sufficient for high-stakes patches. For any patch that can produce a precisely-wrong-but-plausible value, add a deterministic JS guard that pattern-matches the failure mode and reverts. The cost of a JS guard is small; the cost of a fabricated arm value entering a meta-analysis is large.
**Date:** 2026-04-27

### applyPatches no-op patches conflate verification with correction
**Tried:** Original `applyPatches()` returned `{ applied, skipped }`. Any patch whose `corrected_value` ran was added to `applied` regardless of whether the value actually changed.
**What happened:** External Opus critique highlighted that 48% of patches across 20 papers (62/129) were no-ops — the critic restated values that were already correct. These inflated `_critic.patches_applied` to look like the critic was doing more substantive work than it was, and made it harder to tell which extractions had genuinely been corrected vs merely confirmed.
**Fix:** `applyPatches()` now returns `{ applied, verifications, skipped }`. A patch counts as `applied` only if `JSON.stringify(before) !== JSON.stringify(after)`; otherwise it goes to `verifications`. `_critic` exposes `patches_applied` (substantive) and `verifications_count` separately. The audit trail now distinguishes "the critic changed this" from "the critic looked at this and it was already fine."
**Rule:** Counting-style metrics on LLM output should distinguish action from acknowledgement. A 48% no-op rate is a useful signal about critic prompt redundancy; an inflated "patches applied" count is misleading noise.
**Date:** 2026-04-27

### Critic utility is primarily in quality fields, not coverage fields
**Finding:** Across the full 20-paper run, the +2pp gain (V1=94% → V4=96%) and the +14pp arm_events and +34pp SD gains come almost entirely from the deterministic JS post-processing layer — `backCalculateEvents()`, `backCalculateSD()`, `coerceNumericFields()`. These would work without a critic at all.
**Critic's real contribution:** Quality fields — ROB calibration (Rule 4), GRADE calibration (Rule 5), COI/funding extraction (Rule 6), lay summary direction (Rule 11), NI trial framing (Rule 10). These are not measurable by a presence/absence rubric. They require human review against the source paper to assess whether the critic's patch was correct.
**Implication:** The case for the critic must be made in Phase 0 grading — specifically on those quality fields. Coverage metrics alone do not demonstrate critic value.
**Date:** 2026-04-24

---

### Subgroup interactions p-value meaning is counterintuitive and must be explained explicitly
**What happened:** HIP ATTACK Phase 0 run produced subgroup output where the interaction p-value was visible (p=0.0198) but its clinical meaning was not. The p-value does NOT test individual subgroup significance — it tests whether the treatment effect *varies* across subgroups. All individual subgroup CIs crossed 1 (i.e., no individual subgroup was statistically significant), yet the interaction was significant. This is a legitimate and important finding but was not communicated clearly.
**Fix:** Added `cis_all_cross_one` flag to subgroup schema + UI warning box. Added `interaction_note` free-text field for the adjudicator to explain what the interaction means in plain language. Added `direction_vs_hypothesis` to surface directional consistency. Added `pre_specified` / `post_hoc` flags with colour-coded UI badges. Post-hoc subgroups (like the troponin subgroup in HIP ATTACK) are substantially less credible and must be flagged.
**Date:** 2026-04-15
