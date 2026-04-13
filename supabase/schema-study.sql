-- ============================================================
-- OutcomeLogic Validation Study Schema
-- Run once in Supabase SQL editor (Dashboard → SQL Editor)
--
-- Phase structure:
--   Phase 0  — PI-only. Identify systematic errors in V2. Informs V1 prompt design.
--   Phase 1  — Pilot. V1 vs V2 head-to-head. Powers sample size for Phase 2.
--   Phase 2  — Main study. V1 vs V2. Prompts frozen from Phase 1.
--   Phase 3  — Clinical utility. Different rubric. Landmark papers only.
--
-- All study tables are admin-only (service role key bypasses RLS).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Papers registered for the validation study
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_papers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pmid         TEXT        UNIQUE,
  doi          TEXT,
  title        TEXT        NOT NULL,
  trial_name   TEXT,                    -- short acronym e.g. "ORBITA"
  authors      TEXT,
  journal      TEXT,
  year         TEXT,
  domain       TEXT,                    -- Surgery | Orthopaedics | Medicine | Critical Care | Anaesthesia
  specialty    TEXT,
  study_design TEXT,                    -- RCT | cohort | single-arm | crossover etc.
  phase        SMALLINT    NOT NULL DEFAULT 0 CHECK (phase IN (0, 1, 2, 3)),
  is_pilot     BOOLEAN     NOT NULL DEFAULT FALSE,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'analyzing', 'complete', 'error')),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 2. Pipeline outputs — V2 only in Phase 0; V1 + V2 in Phase 1/2
-- pipeline_version tracks which prompt version produced the output
-- so that Phase 1/2 comparisons are not confounded by prompt changes.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_extractions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id         UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version          TEXT        NOT NULL CHECK (version IN ('v1', 'v2')),
  pipeline_version TEXT,                -- e.g. "v2.1.0-hardened" — tag before each phase run
  output_json      JSONB,
  source_type      TEXT,                -- full-text-pmc | abstract-only | full-text-pdf etc.
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(paper_id, version)
);

-- ─────────────────────────────────────────────────────────────
-- 3. Raters — PI, registrars, consultants
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_raters (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('registrar', 'consultant', 'pi')),
  specialty   TEXT,
  blinded     BOOLEAN     NOT NULL DEFAULT TRUE,   -- FALSE for PI in Phase 0
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 4. Field-level structured grades
--
-- One row per (extraction, rater, field_name).
-- field_name is a string enum enforced by the UI:
--   trial_identification | study_design | population | intervention |
--   comparator | primary_outcome_definition | primary_outcome_effect_measure |
--   primary_outcome_point_estimate | primary_outcome_ci | primary_outcome_p_value |
--   primary_outcome_arm_a_n | primary_outcome_arm_b_n |
--   primary_outcome_arm_a_events | primary_outcome_arm_b_events |
--   primary_outcome_analysis_population | primary_outcome_adjusted |
--   secondary_outcomes_list | grade_certainty | risk_of_bias |
--   risk_of_bias_rationale | adverse_events | subgroup_interactions |
--   lay_summary | source_citation
--
-- field_section groups fields for aggregate views:
--   pico | primary_endpoint | secondary_endpoints | appraisal |
--   adverse_events | subgroups | patient_view
--
-- error_taxonomy:
--   omission         — value present in paper, not extracted
--   misclassification — wrong category/label
--   formatting_syntax — correct value, wrong format
--   semantic          — numerically close but clinically meaningfully different
--
-- pipeline_section: where the error likely originated
--   extractor | adjudicator | post_processing
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_grades (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id             UUID        NOT NULL REFERENCES study_extractions(id) ON DELETE CASCADE,
  rater_id                  UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  field_name                TEXT        NOT NULL,
  field_section             TEXT        NOT NULL
                            CHECK (field_section IN (
                              'pico', 'primary_endpoint', 'secondary_endpoints',
                              'appraisal', 'adverse_events', 'subgroups', 'patient_view'
                            )),
  match_status              TEXT        NOT NULL
                            CHECK (match_status IN (
                              'exact_match', 'partial_match', 'fail', 'hallucinated'
                            )),
  error_taxonomy            TEXT
                            CHECK (error_taxonomy IN (
                              'omission', 'misclassification', 'formatting_syntax', 'semantic'
                            )),
  correction_text           TEXT,       -- what the correct value should be
  harm_severity             SMALLINT    CHECK (harm_severity BETWEEN 1 AND 5),
  pipeline_section          TEXT
                            CHECK (pipeline_section IN (
                              'extractor', 'adjudicator', 'post_processing'
                            )),
  -- suspicious_agreement: both V1 and V2 give the same wrong answer
  -- (more dangerous than one-sided failure — set by rater during Phase 1/2 comparison)
  suspicious_agreement      BOOLEAN     NOT NULL DEFAULT FALSE,
  suspicious_agreement_note TEXT,
  graded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(extraction_id, rater_id, field_name)
);

-- ─────────────────────────────────────────────────────────────
-- 5. Rater assignments — which rater reviews which paper/version
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_rater_assignments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  paper_id    UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version     TEXT        NOT NULL CHECK (version IN ('v1', 'v2')),
  completed   BOOLEAN     NOT NULL DEFAULT FALSE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rater_id, paper_id, version)
);

-- ─────────────────────────────────────────────────────────────
-- 6. Sessions — review session metadata for time tracking
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  paper_count SMALLINT,
  notes       TEXT
);

-- ─────────────────────────────────────────────────────────────
-- RLS — admin-only (service role bypasses automatically)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE study_papers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_extractions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_raters           ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_grades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_rater_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions         ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS study_extractions_paper_id_idx    ON study_extractions(paper_id);
CREATE INDEX IF NOT EXISTS study_grades_extraction_id_idx    ON study_grades(extraction_id);
CREATE INDEX IF NOT EXISTS study_grades_field_name_idx       ON study_grades(field_name);
CREATE INDEX IF NOT EXISTS study_grades_match_status_idx     ON study_grades(match_status);
CREATE INDEX IF NOT EXISTS study_assignments_rater_id_idx    ON study_rater_assignments(rater_id);
CREATE INDEX IF NOT EXISTS study_assignments_paper_id_idx    ON study_rater_assignments(paper_id);

-- ─────────────────────────────────────────────────────────────
-- Phase 0 Pilot Papers (10)
-- Primarily surgical/orthopaedic trials — domain focus of OutcomeLogic.
-- Selected to cover: sham controls, non-inferiority, null results,
-- complex survival data, contentious subgroups, abstract-only fallback.
--
-- IMPORTANT: Verify all PMIDs against PubMed before running analyses.
-- PMIDs marked "VERIFY" should be confirmed before use.
-- ─────────────────────────────────────────────────────────────
INSERT INTO study_papers (pmid, title, trial_name, authors, journal, year, domain, specialty, study_design, phase, is_pilot) VALUES

  -- 1. Sham-controlled RCT — tests blinding/sham design extraction + ORBITA controversy
  ('29126895',
   'Percutaneous coronary intervention in stable angina (ORBITA): a double-blind, randomised controlled trial',
   'ORBITA',
   'Al-Lamee R, Thompson D, Dehbi HM et al.',
   'The Lancet', '2018', 'Medicine', 'Cardiology', 'RCT', 0, TRUE),

  -- 2. Accelerated surgery for hip fracture — tests time-to-event extraction, surgical specialty
  (NULL,
   'Accelerated surgery versus standard care in hip fracture (HIP ATTACK): an international, randomised, multicentre, controlled trial',
   'HIP ATTACK',
   'HIP ATTACK Investigators',
   'The Lancet', '2020', 'Orthopaedics', 'Hip', 'RCT', 0, TRUE),

  -- 3. Surgery vs nonoperative for lumbar disc herniation — two-arm RCT, complex crossover
  ('17545430',
   'Surgical versus nonoperative treatment for lumbar disk herniation: the Spine Patient Outcomes Research Trial (SPORT)',
   'SPORT (disc)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'JAMA', '2006', 'Orthopaedics', 'Spine', 'RCT', 0, TRUE),

  -- 4. Hip arthroscopy vs physiotherapy for FAI — tests non-inferiority design, UK multicentre
  (NULL,
   'Hip arthroscopy versus best conservative care for the treatment of femoroacetabular impingement syndrome (UK FASHIoN): a multicentre randomised controlled trial',
   'UK FASHIoN',
   'Griffin DR, Dickenson EJ, Wall PDH et al.',
   'The Lancet', '2018', 'Orthopaedics', 'Hip', 'RCT', 0, TRUE),

  -- 5. TKR vs non-surgical management — NEJM 2015, Skou — tests continuous outcome extraction
  ('26488691',
   'A randomized, controlled trial of total knee replacement',
   'TKR (Skou 2015)',
   'Skou ST, Roos EM, Laursen MB et al.',
   'New England Journal of Medicine', '2015', 'Orthopaedics', 'Knee', 'RCT', 0, TRUE),

  -- 6. CABG vs medical therapy for ischaemic cardiomyopathy — survival data, multiple time points
  ('21463148',
   'Coronary-artery bypass surgery in patients with left ventricular dysfunction (STICH)',
   'STICH',
   'Velazquez EJ, Lee KL, Deja MA et al.',
   'New England Journal of Medicine', '2011', 'Surgery', 'Vascular', 'RCT', 0, TRUE),

  -- 7. PCI vs CABG for left main — EXCEL original 3-year; contentious long-term outcomes
  ('27117439',
   'Everolimus-eluting stents or bypass surgery for left main coronary artery disease (EXCEL)',
   'EXCEL',
   'Stone GW, Sabik JF, Serruys PW et al.',
   'New England Journal of Medicine', '2016', 'Surgery', 'Vascular', 'RCT', 0, TRUE),

  -- 8. Plate fixation vs conservative for proximal humerus fractures — null primary endpoint
  (NULL,
   'Surgical treatment compared with early particle physiotherapy for fractures of the proximal humerus in adults (PROFHER)',
   'PROFHER',
   'Handoll HH, Brealey S, Rangan A et al.',
   'The Lancet', '2015', 'Orthopaedics', 'Shoulder', 'RCT', 0, TRUE),

  -- 9. CT coronary angiography vs standard care — 5-year outcomes; tests long follow-up extraction
  ('31475798',
   'Coronary CT angiography and 5-year risk of myocardial infarction (SCOT-HEART)',
   'SCOT-HEART',
   'Newby DE, Adamson PD, Berry C et al.',
   'New England Journal of Medicine', '2019', 'Medicine', 'Cardiology', 'RCT', 0, TRUE),

  -- 10. Surgery vs nonoperative for lumbar spinal stenosis — companion to SPORT disc paper
  ('18997196',
   'Surgical versus nonoperative treatment for lumbar spinal stenosis: four-year results of the Spine Patient Outcomes Research Trial (SPORT)',
   'SPORT (stenosis)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'Spine', '2010', 'Orthopaedics', 'Spine', 'RCT', 0, TRUE)

ON CONFLICT (pmid) DO NOTHING;
