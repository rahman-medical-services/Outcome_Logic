-- ============================================================
-- OutcomeLogic Validation Study Schema
-- Run once in Supabase SQL editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Papers registered for the validation study
CREATE TABLE IF NOT EXISTS study_papers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pmid        TEXT        UNIQUE,
  title       TEXT        NOT NULL,
  authors     TEXT,
  journal     TEXT,
  year        TEXT,
  specialty   TEXT,
  phase       SMALLINT    NOT NULL DEFAULT 0 CHECK (phase IN (0, 1, 2, 3)),
  is_pilot    BOOLEAN     NOT NULL DEFAULT FALSE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. V1 and V2 pipeline outputs for each paper
CREATE TABLE IF NOT EXISTS study_outputs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID        NOT NULL REFERENCES study_papers(id) ON DELETE CASCADE,
  version       TEXT        NOT NULL CHECK (version IN ('v1', 'v2')),
  output_json   JSONB,
  source_type   TEXT,                  -- e.g. full-text-pmc, abstract-only
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(paper_id, version)
);

-- 3. Raters (registrars, consultants, PI)
CREATE TABLE IF NOT EXISTS study_raters (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('registrar', 'consultant', 'pi')),
  specialty   TEXT,
  blinded     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Grades given by raters (5-point Likert per domain)
CREATE TABLE IF NOT EXISTS study_grades (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id            UUID        NOT NULL REFERENCES study_outputs(id) ON DELETE CASCADE,
  rater_id             UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  pico_accuracy        SMALLINT    CHECK (pico_accuracy BETWEEN 1 AND 5),
  statistical_accuracy SMALLINT    CHECK (statistical_accuracy BETWEEN 1 AND 5),
  clinical_relevance   SMALLINT    CHECK (clinical_relevance BETWEEN 1 AND 5),
  appraisal_quality    SMALLINT    CHECK (appraisal_quality BETWEEN 1 AND 5),
  overall              SMALLINT    CHECK (overall BETWEEN 1 AND 5),
  free_text            TEXT,
  graded_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(output_id, rater_id)
);

-- 5. Rater ↔ output assignments
CREATE TABLE IF NOT EXISTS study_assignments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id    UUID        NOT NULL REFERENCES study_raters(id) ON DELETE CASCADE,
  output_id   UUID        NOT NULL REFERENCES study_outputs(id) ON DELETE CASCADE,
  completed   BOOLEAN     NOT NULL DEFAULT FALSE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rater_id, output_id)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- All study tables are admin-only. Service role key (used server-side) bypasses
-- RLS automatically. No public access policies are needed.
ALTER TABLE study_papers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_outputs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_raters      ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_grades      ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_assignments ENABLE ROW LEVEL SECURITY;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS study_outputs_paper_id_idx ON study_outputs(paper_id);
CREATE INDEX IF NOT EXISTS study_grades_output_id_idx ON study_grades(output_id);
CREATE INDEX IF NOT EXISTS study_assignments_rater_id_idx ON study_assignments(rater_id);

-- ── Phase 0 Pilot Papers ─────────────────────────────────────────────────────
-- 10 papers selected to cover pipeline edge cases and commentary module stress-testing.
-- PMIDs should be verified against PubMed before running analyses.
-- To re-seed after clearing: DELETE FROM study_papers; then re-run this block.
INSERT INTO study_papers (pmid, title, authors, journal, year, specialty, phase, is_pilot) VALUES

  -- 1. Rate comparison (not survival), massive citation pool → commentary stress test
  ('20554319', 'Effects of tranexamic acid on death, vascular occlusive events, and blood transfusion in trauma patients (CRASH-2)',
   'CRASH-2 Trial Collaborators', 'The Lancet', '2010', 'Trauma Surgery', 0, TRUE),

  -- 2. Composite rate outcome, stopped early, very high citations
  ('26551272', 'A randomized trial of intensive versus standard blood-pressure control (SPRINT)',
   'SPRINT Research Group', 'New England Journal of Medicine', '2015', 'Cardiology', 0, TRUE),

  -- 3. Survival data with explicit multiple time points → KM chart rendering
  ('29562145', 'Nivolumab plus ipilimumab versus sunitinib in advanced renal-cell carcinoma (CheckMate 214)',
   'Motzer RJ, Tannir NM, McDermott DF et al.', 'New England Journal of Medicine', '2018', 'Oncology', 0, TRUE),

  -- 4. Single-arm trial — no comparator, control_pct should be null throughout
  ('31825192', 'Trastuzumab deruxtecan in previously treated HER2-positive breast cancer (DESTINY-Breast01)',
   'Modi S, Saura C, Yamashita T et al.', 'New England Journal of Medicine', '2020', 'Oncology', 0, TRUE),

  -- 5. Null primary endpoint (p=0.14), post-hoc geographic subgroup controversy
  ('25119509', 'Spironolactone for heart failure with preserved ejection fraction (TOPCAT)',
   'Pitt B, Pfeffer MA, Assmann SF et al.', 'New England Journal of Medicine', '2014', 'Cardiology', 0, TRUE),

  -- 6. Pre-specified subgroup interaction by respiratory support; ~10,000 citations
  ('32678530', 'Dexamethasone in hospitalized patients with Covid-19 (RECOVERY)',
   'RECOVERY Collaborative Group', 'New England Journal of Medicine', '2021', 'Critical Care', 0, TRUE),

  -- 7. Pre-specified geographic subgroup with disputed interaction p=0.045 (PLATO)
  ('19717846', 'Ticagrelor versus clopidogrel in patients with acute coronary syndromes (PLATO)',
   'Wallentin L, Becker RC, Budaj A et al.', 'New England Journal of Medicine', '2009', 'Cardiology', 0, TRUE),

  -- 8. Non-inferiority design — tests NI margin interpretation vs superiority p-value
  ('32469183', 'Relugolix for androgen-deprivation therapy in advanced prostate cancer (HERO)',
   'Shore ND, Saad F, Cookson MS et al.', 'New England Journal of Medicine', '2020', 'Oncology', 0, TRUE),

  -- 9. NEJM paywalled — falls through to abstract-only; tests graceful degradation
  ('31562798', 'Five-year outcomes after PCI or CABG for left main coronary artery disease (EXCEL 5-year)',
   'Stone GW, Kappetein AP, Sabik JF et al.', 'New England Journal of Medicine', '2019', 'Cardiac Surgery', 0, TRUE),

  -- 10. Recent paper (2023), minimal citations → commentary sparse-pool fallback
  ('37272522', 'Overall survival with osimertinib in resected EGFR-mutated NSCLC (ADAURA OS)',
   'Tsuboi M, Herbst RS, John T et al.', 'New England Journal of Medicine', '2023', 'Oncology', 0, TRUE)

ON CONFLICT (pmid) DO NOTHING;
