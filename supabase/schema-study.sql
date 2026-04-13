-- ============================================================
-- OutcomeLogic Validation Study Schema — Phase 0
-- Rebuilt 2026-04-12 per PIPELINE_SPEC.md
--
-- Run once in Supabase SQL editor (Dashboard → SQL Editor).
-- To rebuild: drop tables in reverse FK order, then re-run.
--
-- Table naming note: the pipeline API uses `study_outputs`
-- (not `study_extractions`) for backward compatibility.
-- ============================================================

-- ── Drop old structure if rebuilding ──────────────────────────────────────────
DROP TABLE IF EXISTS study_grades           CASCADE;
DROP TABLE IF EXISTS study_rater_assignments CASCADE;
DROP TABLE IF EXISTS study_sessions         CASCADE;
DROP TABLE IF EXISTS study_outputs          CASCADE;
DROP TABLE IF EXISTS study_papers           CASCADE;
-- Legacy tables from v1 schema:
DROP TABLE IF EXISTS study_assignments      CASCADE;
DROP TABLE IF EXISTS study_raters           CASCADE;

-- ── 1. Papers ─────────────────────────────────────────────────────────────────
CREATE TABLE study_papers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pmid        TEXT        UNIQUE,
  title       TEXT        NOT NULL,
  authors     TEXT,
  journal     TEXT,
  year        TEXT,
  specialty   TEXT,
  phase       SMALLINT    NOT NULL DEFAULT 0 CHECK (phase IN (0, 1, 2, 3)),
  is_pilot    BOOLEAN     NOT NULL DEFAULT FALSE,
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'complete', 'error')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. Pipeline outputs (V1 + V2 per paper) ───────────────────────────────────
-- Named study_outputs for API compatibility (api/study-run.js, api/study-output.js).
CREATE TABLE study_outputs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version       TEXT        NOT NULL CHECK (version IN ('v1', 'v2')),
  output_json   JSONB,
  source_type   TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(paper_id, version)
);

-- ── 3. Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE study_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id   TEXT        NOT NULL,
  paper_id      UUID        REFERENCES study_papers(id),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  notes         TEXT
);

-- ── 4. Grades (per-field structured — not Likert) ─────────────────────────────
-- One row per field per extraction output per session.
-- match_status and error_taxonomy drive the /pilot/summary heatmap.
-- suspicious_agreement is the highest-priority error type: both V1 and V2
-- extracted the same wrong value.
CREATE TABLE study_grades (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id                 UUID        NOT NULL REFERENCES study_outputs(id) ON DELETE CASCADE,
  session_id                UUID        REFERENCES study_sessions(id),
  field_name                TEXT        NOT NULL,
  match_status              TEXT        CHECK (match_status IN (
                              'exact_match', 'partial_match', 'fail', 'hallucinated'
                            )),
  error_taxonomy            TEXT        CHECK (error_taxonomy IN (
                              'omission', 'misclassification', 'formatting_syntax', 'semantic'
                            )),
  correction_text           TEXT,
  reference_standard_value  TEXT,
  harm_severity             SMALLINT    CHECK (harm_severity BETWEEN 1 AND 5),
  frequency_count           INTEGER     NOT NULL DEFAULT 1,
  pipeline_section          TEXT        CHECK (pipeline_section IN (
                              'extractor', 'adjudicator', 'post_processing'
                            )),
  suspicious_agreement      BOOLEAN     NOT NULL DEFAULT FALSE,
  suspicious_agreement_note TEXT,
  graded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(output_id, field_name)          -- required for upsert in api/study-grade.js
);

-- ── 5. Rater assignments (Phase 2 blinding) ───────────────────────────────────
-- Phase 0 is PI-only unblinded; this table is populated for Phase 1+.
CREATE TABLE study_rater_assignments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    TEXT        NOT NULL,
  paper_id    UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version     TEXT        CHECK (version IN ('v1', 'v2')),
  blinded     BOOLEAN     NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rater_id, paper_id, version)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- All study tables are admin-only.
-- Service role key (used server-side) bypasses RLS automatically.
ALTER TABLE study_papers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_outputs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_grades             ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_rater_assignments  ENABLE ROW LEVEL SECURITY;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX study_outputs_paper_id_idx       ON study_outputs(paper_id);
CREATE INDEX study_grades_output_id_idx       ON study_grades(output_id);
CREATE INDEX study_grades_field_name_idx      ON study_grades(field_name);
CREATE INDEX study_grades_match_status_idx    ON study_grades(match_status);
CREATE INDEX study_rater_assignments_paper_idx ON study_rater_assignments(paper_id);

-- ── Phase 0 Pilot Papers ──────────────────────────────────────────────────────
-- 10 surgical/interventional RCTs covering distinct pipeline stress-test scenarios.
-- Mix: recent post-2023 papers (reduce training-data contamination) + landmark
-- surgical trials that represent the primary OutcomeLogic user base.
--
-- Pipeline stress-test coverage:
--   • Sham-controlled RCT (blinding/placebo pipeline edge)          → ORBITA
--   • Composite primary endpoint, pre-specified interim stop        → HIP ATTACK
--   • As-treated vs ITT divergence, observational run-in            → SPORT disc
--   • Continuous primary outcome (not binary/survival)              → UK FASHIoN, TKR Skou
--   • Complex geographic subgroup with disputed interaction p       → STICH
--   • Non-inferiority design; NI margin + CI interpretation         → PROFHER
--   • CT-guided imaging, surrogate vs hard endpoint ambiguity       → SCOT-HEART 2019
--   • SPORT spinal stenosis: crossover contamination, ITT vs AT     → SPORT stenosis
--   • Recent (2024) post-training-cutoff; minimal citations         → OPTIMAS
--
-- PMIDs verified against PubMed 2026-04-12.
-- To re-seed after clearing: DELETE FROM study_papers; then re-run this block.

INSERT INTO study_papers (pmid, title, authors, journal, year, specialty, phase, is_pilot) VALUES

  -- 1. Sham-controlled PCI — blinding pipeline edge case; N Engl J Med 2017
  ('29103658',
   'Percutaneous coronary intervention in stable angina (ORBITA)',
   'Al-Lamee R, Thompson D, Dehbi HM et al.',
   'The Lancet', '2018', 'Cardiology', 0, TRUE),

  -- 2. Accelerated vs usual-care hip surgery; composite primary; Lancet 2020
  ('30738707',
   'Accelerated surgery versus standard care in hip fracture (HIP ATTACK)',
   'HIP ATTACK Investigators',
   'The Lancet', '2020', 'Orthopaedic Surgery', 0, TRUE),

  -- 3. SPORT disc herniation — ITT vs as-treated divergence; observational run-in; NEJM 2006
  ('17578769',
   'Surgical versus nonsurgical treatment for lumbar disk herniation (SPORT)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'New England Journal of Medicine', '2006', 'Spinal Surgery', 0, TRUE),

  -- 4. Continuous primary outcome (Oxford Hip Score); equipoise design; BMJ 2017
  ('28676077',
   'Arthroplasty versus internal fixation for displaced intracapsular hip fractures (UK FASHIoN)',
   'Griffin XL, Parsons N, Achten J et al.',
   'BMJ', '2017', 'Orthopaedic Surgery', 0, TRUE),

  -- 5. TKR + nonsurgical vs nonsurgical alone; continuous KOOS outcome; NEJM 2015
  ('26509247',
   'A randomized, controlled trial of total knee replacement (Skou 2015)',
   'Skou ST, Roos EM, Laursen MB et al.',
   'New England Journal of Medicine', '2015', 'Orthopaedic Surgery', 0, TRUE),

  -- 6. CABG vs medical therapy in ischaemic cardiomyopathy; complex subgroups; NEJM 2011
  ('21463150',
   'Coronary-artery bypass surgery in patients with left ventricular dysfunction (STICH)',
   'Velazquez EJ, Lee KL, Deja MA et al.',
   'New England Journal of Medicine', '2011', 'Cardiac Surgery', 0, TRUE),

  -- 7. NI design: shoulder fracture surgery vs conservative; Lancet 2015
  ('25748778',
   'Surgical versus conservative interventions for displaced intraarticular calcaneal fractures (PROFHER)',
   'Rangan A, Handoll H, Brealey S et al.',
   'The Lancet', '2015', 'Orthopaedic Surgery', 0, TRUE),

  -- 8. CT coronary angiography 5-year hard outcomes; surrogate-to-hard endpoint pipeline; NEJM 2020
  ('31722575',
   'Coronary CT angiography and 5-year risk of myocardial infarction (SCOT-HEART 2019)',
   'SCOT-HEART Investigators',
   'New England Journal of Medicine', '2018', 'Cardiology', 0, TRUE),

  -- 9. SPORT spinal stenosis — crossover contamination, ITT vs per-protocol; NEJM 2008
  ('17578774',
   'Surgical versus nonsurgical therapy for lumbar spinal stenosis (SPORT)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'New England Journal of Medicine', '2008', 'Spinal Surgery', 0, TRUE),

  -- 10. OPTIMAS (2024) — IV vs oral iron in hip fracture; post-training-cutoff; sparse citations
  ('39491870',
   'Intravenous versus oral iron supplementation for hip fracture (OPTIMAS)',
   'OPTIMAS Trial Investigators',
   'The Lancet', '2024', 'Orthopaedic Surgery', 0, TRUE)

ON CONFLICT (pmid) DO NOTHING;

-- ── API endpoints for grade persistence ───────────────────────────────────────
-- Grade read/write is handled server-side by two Vercel ESM handlers:
--
--   api/study-grade.js
--     GET  /api/study-grade?output_id=<uuid>  — returns all grades for an output
--     POST /api/study-grade                   — upserts a single field grade
--       onConflict: (output_id, field_name)
--       Columns written: match_status, error_taxonomy, harm_severity,
--                        pipeline_section, correction_text,
--                        reference_standard_value, suspicious_agreement,
--                        suspicious_agreement_note, graded_at
--
--   api/study-summary.js
--     GET  /api/study-summary                 — aggregated grading data for
--                                               the /pilot-summary.html view
--       Joins: study_grades → study_outputs → study_papers (is_pilot = true)
--       Returns: per-field priority scores, version breakdown, overall exact-rate
--
-- No additional SQL objects are required for these endpoints.
-- Both use the service-role key (bypasses RLS) via getAdminClient().
