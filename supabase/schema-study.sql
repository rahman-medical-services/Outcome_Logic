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
-- PMIDs are best-effort — verify and update in the study admin page if needed.
-- All 10 papers are landmark surgical/medical RCTs used to validate OutcomeLogic.
INSERT INTO study_papers (pmid, title, authors, journal, year, specialty, phase, is_pilot) VALUES
  ('29031853', 'Percutaneous coronary intervention in stable angina (ORBITA)',
   'Al-Lamee R, Thompson D, Dehbi HM et al.', 'The Lancet', '2018', 'Cardiology', 0, TRUE),

  ('32061319', 'Accelerated surgery versus standard care in hip fracture (HIP ATTACK)',
   'HIP ATTACK Investigators', 'The Lancet', '2020', 'Orthopaedics', 0, TRUE),

  ('16481637', 'Surgical versus nonoperative treatment for lumbar disk herniation (SPORT)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.', 'JAMA', '2006', 'Spine', 0, TRUE),

  ('29679972', 'Arthroscopic surgery versus physiotherapy for femoroacetabular impingement (UK FASHIoN)',
   'Griffin DR, Dickenson EJ, Wall PD et al.', 'The Lancet', '2018', 'Orthopaedics', 0, TRUE),

  ('26488691', 'A randomized, controlled trial of total knee replacement (Skou 2015)',
   'Skou ST, Roos EM, Laursen MB et al.', 'New England Journal of Medicine', '2015', 'Orthopaedics', 0, TRUE),

  ('22077679', 'Coronary-artery bypass surgery in patients with left ventricular dysfunction (STICH)',
   'Velazquez EJ, Lee KL, Deja MA et al.', 'New England Journal of Medicine', '2011', 'Cardiac Surgery', 0, TRUE),

  ('27733897', 'Everolimus-eluting stents or bypass surgery for left main coronary artery disease (EXCEL)',
   'Stone GW, Sabik JF, Serruys PW et al.', 'New England Journal of Medicine', '2016', 'Cardiac Surgery', 0, TRUE),

  ('25573082', 'Surgical treatment versus non-surgical treatment for the management of proximal humeral fractures (PROFHER)',
   'Rangan A, Handoll H, Brealey S et al.', 'The Lancet', '2015', 'Orthopaedics', 0, TRUE),

  ('26041020', 'Coronary CT angiography and 5-year risk of myocardial infarction (SCOT-HEART)',
   'SCOT-HEART Investigators', 'The Lancet', '2015', 'Cardiology', 0, TRUE),

  ('18612163', 'Surgical versus nonoperative treatment for lumbar spinal stenosis (SPORT)',
   'Weinstein JN, Tosteson TD, Lurie JD et al.', 'JAMA', '2008', 'Spine', 0, TRUE)

ON CONFLICT (pmid) DO NOTHING;
