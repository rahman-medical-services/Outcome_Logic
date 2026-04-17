-- ============================================================
-- OutcomeLogic Validation Study Schema
-- Run once in Supabase SQL editor (Dashboard → SQL Editor)
--
-- Phase structure:
--   Phase 0  — PI-only feasibility. 10 surgical/orthopaedic papers, V3 only.
--              Goal: identify systematic errors before scaling. COMPLETE.
--   Phase 1  — Signal pilot. 10 cardiac surgery papers, V1 vs V3 head-to-head.
--              Goal: estimate effect size delta to power Phase 2 sample size.
--   Phase 2  — Powered validation. N determined from Phase 1. V1 vs V3 (+/- generic arm).
--              Multi-rater, publication-grade. Prompts frozen from Phase 1.
--   Phase 3  — Clinical utility assessment. Different rubric. See FEATURES.md.
--
-- All study tables are admin-only (service role key bypasses RLS).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- DROP existing tables (handles rename from study_outputs → study_extractions
-- and output_id → extraction_id in study_grades). CASCADE removes dependents.
-- WARNING: this wipes any existing study data. Safe to run before Phase 0.
-- ─────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS study_sessions          CASCADE;
DROP TABLE IF EXISTS study_rater_assignments CASCADE;
DROP TABLE IF EXISTS study_assignments       CASCADE;
DROP TABLE IF EXISTS study_grades            CASCADE;
DROP TABLE IF EXISTS study_raters            CASCADE;
DROP TABLE IF EXISTS study_extractions       CASCADE;
DROP TABLE IF EXISTS study_outputs           CASCADE;
DROP TABLE IF EXISTS study_papers            CASCADE;

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
  version          TEXT        NOT NULL,  -- Phase 0: free-form to allow rapid prompt iteration.
  -- Examples: 'v2', 'v2.1-adj-fix', 'v2.2-candidate-values'. Add CHECK constraint before Phase 1 freeze.
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
-- error_taxonomy (8-class — see docs/ERROR_TAXONOMY.md):
--   recall_failure         — value present, both extractors missed it
--   correlated_recall      — both extractors anchored to same wrong prominent text
--   ranking_hierarchy      — C3a: correct candidate present; adjudicator violated ranking rules (adjusted > unadjusted etc.)
--   ranking_ambiguity      — C3b: correct candidate present; adjudicator chose wrong when candidates were genuinely ambiguous
--   misclassification      — wrong category/label (e.g. wrong effect measure type)
--   interpretation_failure — value extracted but meaning misunderstood
--   hallucination          — extracted value has no basis in the source document
--   formatting_enum        — correct value, wrong format or enum string
--
-- pipeline_section: where the error manifested in the pipeline
--   extractor | adjudicator | post_processing
--
-- root_cause_stage: deepest fixable origin of the error (optional)
--   extractor | adjudicator | schema_design | prompt_guidance | document_structure
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_grades (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id             UUID        NOT NULL REFERENCES study_extractions(id) ON DELETE CASCADE,
  rater_id                  UUID        REFERENCES study_raters(id) ON DELETE SET NULL,
  field_name                TEXT        NOT NULL,
  field_section             TEXT
                            CHECK (field_section IN (
                              'pico', 'primary_endpoint', 'secondary_endpoints',
                              'appraisal', 'adverse_events', 'subgroups', 'patient_view'
                            )),
  match_status              TEXT
                            CHECK (match_status IN (
                              'exact_match', 'partial_match', 'fail', 'hallucinated'
                            )),
  error_taxonomy            TEXT
                            CHECK (error_taxonomy IN (
                              'recall_failure', 'correlated_recall',
                              'ranking_hierarchy', 'ranking_ambiguity',
                              'misclassification', 'interpretation_failure',
                              'hallucination', 'formatting_enum'
                            )),
  correction_text           TEXT,
  reference_standard_value  TEXT,       -- PI's independent assessment (required for evaluative fields)
  harm_severity             SMALLINT    CHECK (harm_severity BETWEEN 1 AND 5),
  pipeline_section          TEXT
                            CHECK (pipeline_section IN (
                              'extractor', 'adjudicator', 'post_processing'
                            )),
  root_cause_stage          TEXT
                            CHECK (root_cause_stage IN (
                              'extractor', 'adjudicator', 'schema_design',
                              'prompt_guidance', 'document_structure'
                            )),
  -- suspicious_agreement: both V1 and V3 give the same wrong answer
  -- (more dangerous than one-sided failure — set by rater during Phase 1/2 comparison)
  suspicious_agreement      BOOLEAN     NOT NULL DEFAULT FALSE,
  suspicious_agreement_note TEXT,
  graded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(extraction_id, field_name)
);

-- ─────────────────────────────────────────────────────────────
-- 5. Rater assignments — which rater reviews which paper/version
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS study_rater_assignments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  paper_id    UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version     TEXT        NOT NULL,  -- Phase 0: free-form. Add CHECK before Phase 1.
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
-- All PMIDs verified against live PubMed via E-utilities API (April 2026).
-- To correct a PMID after insertion:
--   UPDATE study_papers SET pmid='<correct>' WHERE trial_name='<name>';
INSERT INTO study_papers (pmid, title, trial_name, authors, journal, year, domain, specialty, study_design, phase, is_pilot) VALUES

  -- 1. ORBITA — sham-controlled RCT; tests blinding/sham design + ORBITA controversy
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/29103656
  ('29103656',
   'Percutaneous coronary intervention in stable angina (ORBITA): a double-blind, randomised controlled trial',
   'ORBITA',
   'Al-Lamee R, Thompson D, Dehbi HM et al.',
   'The Lancet', '2018', 'Medicine', 'Cardiology', 'RCT', 0, TRUE),

  -- 2. HIP ATTACK — accelerated surgery for hip fracture; tests time-to-event extraction
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/32050090
  ('32050090',
   'Accelerated surgery versus standard care in hip fracture (HIP ATTACK): an international, randomised, controlled trial',
   'HIP ATTACK',
   'HIP ATTACK Investigators',
   'The Lancet', '2020', 'Orthopaedics', 'Hip', 'RCT', 0, TRUE),

  -- 3. SPORT (disc) — surgery vs nonoperative for lumbar disc herniation; complex crossover
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/17119140 (RCT arm; companion observational: 17119141)
  ('17119140',
   'Surgical vs nonoperative treatment for lumbar disk herniation: the Spine Patient Outcomes Research Trial (SPORT): a randomized trial',
   'SPORT (disc)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'JAMA', '2006', 'Orthopaedics', 'Spine', 'RCT', 0, TRUE),

  -- 4. UK FASHIoN — hip arthroscopy vs physiotherapy for FAI; UK multicentre
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/29893223
  ('29893223',
   'Hip arthroscopy versus best conservative care for the treatment of femoroacetabular impingement syndrome (UK FASHIoN): a multicentre randomised controlled trial',
   'UK FASHIoN',
   'Griffin DR, Dickenson EJ, Wall PDH et al.',
   'The Lancet', '2018', 'Orthopaedics', 'Hip', 'RCT', 0, TRUE),

  -- 5. TKR (Skou 2015) — TKR vs non-surgical; tests continuous outcome extraction
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/26488691 (confirmed by PI)
  ('26488691',
   'A randomized, controlled trial of total knee replacement',
   'TKR (Skou 2015)',
   'Skou ST, Roos EM, Laursen MB et al.',
   'New England Journal of Medicine', '2015', 'Orthopaedics', 'Knee', 'RCT', 0, TRUE),

  -- 6. STICH — CABG vs medical therapy for ischaemic cardiomyopathy; survival, multiple time points
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/21463150
  ('21463150',
   'Coronary-artery bypass surgery in patients with left ventricular dysfunction',
   'STICH',
   'Velazquez EJ, Lee KL, Deja MA et al.',
   'New England Journal of Medicine', '2011', 'Surgery', 'Vascular', 'RCT', 0, TRUE),

  -- 7. EXCEL — PCI vs CABG for left main; 3-year primary; contentious long-term outcomes
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/27797291
  ('27797291',
   'Everolimus-Eluting Stents or Bypass Surgery for Left Main Coronary Artery Disease',
   'EXCEL',
   'Stone GW, Sabik JF, Serruys PW et al.',
   'New England Journal of Medicine', '2016', 'Surgery', 'Vascular', 'RCT', 0, TRUE),

  -- 8. PROFHER — surgery vs conservative for proximal humerus fractures; null primary endpoint
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/25756440 (published JAMA 2015, not Lancet)
  ('25756440',
   'Surgical vs nonsurgical treatment of adults with displaced fractures of the proximal humerus: the PROFHER randomized clinical trial',
   'PROFHER',
   'Rangan A, Handoll H, Brealey S et al.',
   'JAMA', '2015', 'Orthopaedics', 'Shoulder', 'RCT', 0, TRUE),

  -- 9. SCOT-HEART — CT coronary angiography vs standard care; 5-year MI outcomes
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/30145934 (NEJM 2018, epub Aug 2018)
  ('30145934',
   'Coronary CT Angiography and 5-Year Risk of Myocardial Infarction',
   'SCOT-HEART',
   'SCOT-HEART Investigators; Newby DE et al.',
   'New England Journal of Medicine', '2018', 'Medicine', 'Cardiology', 'RCT', 0, TRUE),

  -- 10. SPORT (stenosis) — surgery vs nonoperative for lumbar spinal stenosis; 4-year follow-up
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/20453723 (4-yr Spine 2010)
  -- Note: 2-yr primary JAMA 2008 paper is PMID 18091066 if preferred
  ('20453723',
   'Surgical versus nonsurgical therapy for lumbar spinal stenosis: four-year results of the Spine Patient Outcomes Research Trial',
   'SPORT (stenosis)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.',
   'Spine', '2010', 'Orthopaedics', 'Spine', 'RCT', 0, TRUE)

ON CONFLICT (pmid) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- Phase 1 Pilot Papers (10)
-- Cardiac surgery / cardiothoracic RCTs.
-- Selected to stress: co-primary endpoints (C3), NI designs (C5),
-- abstract vs full-text discordance (ISCHEMIA), complex subgroups,
-- and post-training-cutoff generalisability (DEDICATE).
-- PMIDs verified via PubMed E-utilities API (April 2026).
-- ─────────────────────────────────────────────────────────────
INSERT INTO study_papers (pmid, title, trial_name, authors, journal, year, domain, specialty, study_design, phase, is_pilot) VALUES

  -- 1. SYNTAX — PCI vs CABG, MACCE composite, SYNTAX score subgroups
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/19228612
  ('19228612',
   'Percutaneous coronary intervention versus coronary-artery bypass grafting for severe coronary artery disease',
   'SYNTAX',
   'Serruys PW, Morice MC, Kappetein AP et al.',
   'New England Journal of Medicine', '2009', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 2. CREST — carotid stenting vs endarterectomy, co-primary composite + components
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/20505173
  ('20505173',
   'Stenting versus endarterectomy for treatment of carotid-artery stenosis',
   'CREST',
   'Brott TG, Hobson RW, Howard G et al.',
   'New England Journal of Medicine', '2010', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 3. PARTNER 1 — TAVR vs surgical AVR in high-risk patients
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/21639811
  ('21639811',
   'Transcatheter versus surgical aortic-valve replacement in high-risk patients',
   'PARTNER 1',
   'Smith CR, Leon MB, Mack MJ et al.',
   'New England Journal of Medicine', '2011', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 4. FREEDOM — PCI vs CABG in diabetes, composite primary, rich subgroups
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/23121323
  ('23121323',
   'Strategies for multivessel revascularization in patients with diabetes',
   'FREEDOM',
   'Farkouh ME, Domanski M, Sleeper LA et al.',
   'New England Journal of Medicine', '2012', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 5. CORONARY — off-pump vs on-pump CABG, NI design (Lamy et al)
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/22449296
  ('22449296',
   'Off-pump or on-pump coronary-artery bypass grafting at 30 days',
   'CORONARY',
   'Lamy A, Devereaux PJ, Prabhakaran D et al.',
   'New England Journal of Medicine', '2012', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 6. PARTNER 2 — TAVR intermediate risk, explicit NI design (Leon et al)
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/27040324
  ('27040324',
   'Transcatheter or Surgical Aortic-Valve Replacement in Intermediate-Risk Patients',
   'PARTNER 2',
   'Leon MB, Smith CR, Mack MJ et al.',
   'New England Journal of Medicine', '2016', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 7. ART — bilateral vs single internal mammary artery grafts at 10 years (Taggart et al)
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/30699314
  ('30699314',
   'Bilateral versus Single Internal-Thoracic-Artery Grafts at 10 Years',
   'ART',
   'Taggart DP, Benedetto U, Gerry S et al.',
   'New England Journal of Medicine', '2019', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 8. PARTNER 3 — TAVR low risk, NI design (Mack et al)
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/30883058
  ('30883058',
   'Transcatheter Aortic-Valve Replacement with a Balloon-Expandable Valve in Low-Risk Patients',
   'PARTNER 3',
   'Mack MJ, Leon MB, Thourani VH et al.',
   'New England Journal of Medicine', '2019', 'Surgery', 'Vascular', 'RCT', 1, TRUE),

  -- 9. ISCHEMIA — invasive vs conservative for stable CAD; known abstract vs full-text discordance
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/32227755
  ('32227755',
   'Initial Invasive or Conservative Strategy for Stable Coronary Disease',
   'ISCHEMIA',
   'Maron DJ, Hochman JS, Reynolds HR et al.',
   'New England Journal of Medicine', '2020', 'Medicine', 'Cardiology', 'RCT', 1, TRUE),

  -- 10. DEDICATE — TAVR vs SAVR low surgical risk; post-training-cutoff (2024)
  -- Verified: https://pubmed.ncbi.nlm.nih.gov/38588025
  ('38588025',
   'Transcatheter or Surgical Treatment of Aortic-Valve Stenosis',
   'DEDICATE',
   'Overtchouk P, Modine T, Woitek F et al.',
   'New England Journal of Medicine', '2024', 'Surgery', 'Vascular', 'RCT', 1, TRUE)

ON CONFLICT (pmid) DO NOTHING;
