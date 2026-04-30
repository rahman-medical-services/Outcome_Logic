-- ============================================================
-- OutcomeLogic Validation Study Schema
-- Aligned to PROTOCOL.md v2.0 (3-phase, multi-rater, timed)
-- Created: 2026-04-29 (Session 20)
-- ============================================================
--
-- Coexistence:
--   - This schema is ENTIRELY SEPARATE from schema-study.sql.
--   - schema-study.sql owns Phase 0 grading + the V4 pipeline run records
--     (study_papers, study_extractions, study_grades, etc.).
--   - schema-validation.sql owns the formal 30-paper validation study.
--   - The only link is validation_papers.v4_extraction_id (UUID, not a FK)
--     which references study_extractions(id) at the application layer.
--
-- Design choices (flexibility-first; lock down before formal study):
--   - All categorical fields are TEXT — no enums, no CHECK constraints.
--     Application layer validates. Add CHECKs once values are stable.
--   - Foreign keys use ON DELETE CASCADE on paper_id and rater_id so
--     papers and raters can be added/removed freely during debugging.
--     Switch to RESTRICT before formal data collection begins.
--   - Soft delete via is_active flag preferred over physical delete.
--   - Locking via boolean `locked` columns; application layer enforces.
--   - RLS enabled; service role bypasses (matches schema-study.sql).
--   - Field list (the 19 MA fields) is NOT enforced in the schema —
--     stored as TEXT field_name. UI layer drives the field set so
--     adding/removing fields does not require a migration.
--
-- Re-run safety: DROP CASCADE at top wipes all validation data.
-- ============================================================


-- ============================================================
-- Drop in reverse-dependency order (idempotent for dev)
-- ============================================================
DROP VIEW  IF EXISTS validation_paper_progress      CASCADE;
DROP TABLE IF EXISTS phase3_paper_ratings           CASCADE;
DROP TABLE IF EXISTS phase3_arbitrations            CASCADE;
DROP TABLE IF EXISTS phase2_grades                  CASCADE;
DROP TABLE IF EXISTS phase2_sessions                CASCADE;
DROP TABLE IF EXISTS phase1a_extractions            CASCADE;
DROP TABLE IF EXISTS phase1a_sessions               CASCADE;
DROP TABLE IF EXISTS validation_papers              CASCADE;
DROP TABLE IF EXISTS validation_raters              CASCADE;
DROP FUNCTION IF EXISTS validation_set_updated_at() CASCADE;


-- ============================================================
-- Helper: updated_at trigger function (shared)
-- ============================================================
CREATE OR REPLACE FUNCTION validation_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 1. validation_raters
-- Closed-set identities. Not real auth — passphrase gate only.
-- PI is excluded from Phase 1a (PROTOCOL §2.3); enforced in app, not DB.
-- ============================================================
CREATE TABLE validation_raters (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id      TEXT        NOT NULL UNIQUE,                 -- e.g. 'rater_a1'; used as FK target
  display_name  TEXT        NOT NULL,
  pair          TEXT,                                        -- 'A' | 'B' | NULL (arbitrator/admin)
  role          TEXT        NOT NULL DEFAULT 'phase1a',      -- comma-separated, e.g. 'phase1a,phase2'
  passphrase    TEXT        NOT NULL,                        -- simple gate, not auth
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_raters_active ON validation_raters(is_active) WHERE is_active = true;

COMMENT ON TABLE validation_raters IS
  'Validation study rater identities. Lightweight passphrase login, not real auth. PI must not hold phase1a role (PROTOCOL §2.3) — enforced at login.';
COMMENT ON COLUMN validation_raters.pair IS
  'A or B for crossover assignment. NULL for arbitrator/admin.';
COMMENT ON COLUMN validation_raters.role IS
  'Comma-separated list. A rater may hold multiple roles (e.g. ''phase2,arbitrator'').';


-- ============================================================
-- 2. validation_papers
-- The validation study paper set (30 formal + 5 preliminary test set).
-- Excludes the 10 Phase 0 papers per PROTOCOL §1.3.
-- ============================================================
CREATE TABLE validation_papers (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_number          INTEGER     UNIQUE,                  -- 1..30 for formal set; NULL for preliminary
  short_label           TEXT,                                -- e.g. 'CIBIS-II' for UI display
  title                 TEXT        NOT NULL,
  pmid                  TEXT,
  doi                   TEXT,
  pdf_filename          TEXT,
  pdf_sha256            TEXT,                                -- archived PDF hash (PROTOCOL §12)
  pdf_url               TEXT,                                -- Storage URL or external link
  is_preliminary        BOOLEAN     NOT NULL DEFAULT false,  -- 5 HFrEF beta-blocker test papers
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  crossover_assignment  TEXT,                                -- 'a_phase1a' | 'a_phase2a' | NULL
  phase1a_locked        BOOLEAN     NOT NULL DEFAULT false,
  phase2a_locked        BOOLEAN     NOT NULL DEFAULT false,
  phase3_locked         BOOLEAN     NOT NULL DEFAULT false,
  v4_extraction_id      UUID,                                -- → study_extractions.id (app-level link)
  v4_runtime_seconds    NUMERIC,                             -- snapshot of _runtime_seconds at run time
  merged_json           JSONB,                               -- final V4-shape JSON post-Phase 3 (V4 + 2b corrections + arbitrated MA)
  merged_at             TIMESTAMPTZ,                         -- set when merged_json is written by phase3_paper_submit
  library_trial_id      UUID,                                -- → trials.id if saved to validated library; NULL otherwise
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_papers_active      ON validation_papers(is_active) WHERE is_active = true;
CREATE INDEX idx_validation_papers_preliminary ON validation_papers(is_preliminary);

COMMENT ON TABLE validation_papers IS
  'Validation study paper set. is_preliminary=true marks the 5 HFrEF beta-blocker rehearsal papers (CIBIS-II, MERIT-HF, COPERNICUS, SENIORS, BEST) — these inform protocol refinement only and are NOT part of the formal 30-paper analysis.';
COMMENT ON COLUMN validation_papers.crossover_assignment IS
  '''a_phase1a'' = Pair A does Phase 1a, Pair B does Phase 2a. ''a_phase2a'' = swap. PROTOCOL §2.2: papers 1-15 vs 16-30.';
COMMENT ON COLUMN validation_papers.v4_extraction_id IS
  'Application-level link to study_extractions(id). Not a DB FK — keeps the validation schema decoupled from the pipeline schema.';


-- ============================================================
-- 3. phase1a_sessions
-- Per-rater per-paper Phase 1a timer + submission lock.
-- ============================================================
CREATE TABLE phase1a_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  rater_id      TEXT        NOT NULL REFERENCES validation_raters(rater_id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ,                                 -- set on first field input
  submitted_at  TIMESTAMPTZ,                                 -- set on explicit submit
  time_seconds  INTEGER,                                     -- computed = submitted_at - started_at
  locked        BOOLEAN     NOT NULL DEFAULT false,          -- true on submit
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, rater_id)
);

CREATE INDEX idx_phase1a_sessions_paper ON phase1a_sessions(paper_id);
CREATE INDEX idx_phase1a_sessions_rater ON phase1a_sessions(rater_id);

CREATE TRIGGER trg_phase1a_sessions_updated BEFORE UPDATE ON phase1a_sessions
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();


-- ============================================================
-- 4. phase1a_extractions
-- Per-field manual extraction values (the 19 MA fields per
-- PROTOCOL §3.1). All values stored as TEXT; cast in app layer.
-- ============================================================
CREATE TABLE phase1a_extractions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  rater_id          TEXT        NOT NULL REFERENCES validation_raters(rater_id) ON DELETE CASCADE,
  field_name        TEXT        NOT NULL,
  extracted_value   TEXT,                                    -- NULL if cannot_determine or not yet entered
  cannot_determine  BOOLEAN     NOT NULL DEFAULT false,      -- field absent from paper
  uncertain         BOOLEAN     NOT NULL DEFAULT false,      -- rater unsure; flag for arbitration
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, rater_id, field_name)
);

CREATE INDEX idx_phase1a_extractions_paper ON phase1a_extractions(paper_id);
CREATE INDEX idx_phase1a_extractions_rater ON phase1a_extractions(rater_id);
CREATE INDEX idx_phase1a_extractions_field ON phase1a_extractions(field_name);

CREATE TRIGGER trg_phase1a_extractions_updated BEFORE UPDATE ON phase1a_extractions
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();

COMMENT ON TABLE phase1a_extractions IS
  'Pre-pipeline manual extraction (PROTOCOL §3.1, 19 MA fields). Two raters per paper, each blinded to the other and to the pipeline output. Blinding enforced at API layer (rater A cannot read rater B''s row until both submit).';


-- ============================================================
-- 5. phase2_sessions
-- Per-rater per-paper per-phase timer for Phase 2a / 2b.
-- 2a (MA fields) and 2b (non-MA fields) are sequentially gated and
-- timed separately. App enforces: cannot create 2b session until
-- 2a session is locked for the same (paper, rater).
-- ============================================================
CREATE TABLE phase2_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  rater_id      TEXT        NOT NULL REFERENCES validation_raters(rater_id) ON DELETE CASCADE,
  phase         TEXT        NOT NULL,                        -- '2a' | '2b'
  extraction_id UUID,                                        -- snapshot of V4 extraction reviewed
  started_at    TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ,
  time_seconds  INTEGER,
  locked        BOOLEAN     NOT NULL DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, rater_id, phase)
);

CREATE INDEX idx_phase2_sessions_paper ON phase2_sessions(paper_id);
CREATE INDEX idx_phase2_sessions_rater ON phase2_sessions(rater_id);

CREATE TRIGGER trg_phase2_sessions_updated BEFORE UPDATE ON phase2_sessions
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();

COMMENT ON TABLE phase2_sessions IS
  'Phase 2a (MA fields, primary time endpoint) and Phase 2b (non-MA fields, additional burden) are timed separately. phase2a_seconds vs phase1a_seconds is the primary within-rater paired comparison (PROTOCOL §2.4).';


-- ============================================================
-- 6. phase2_grades
-- Per-field rater corrections to V4 pipeline output. _critic audit
-- trail is NOT shown to rater (PROTOCOL §2.3 blinding requirement).
-- ============================================================
CREATE TABLE phase2_grades (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  rater_id          TEXT        NOT NULL REFERENCES validation_raters(rater_id) ON DELETE CASCADE,
  phase             TEXT        NOT NULL,                    -- '2a' | '2b'
  field_name        TEXT        NOT NULL,
  v4_value          TEXT,                                    -- snapshot of V4 value at grading time
  match_status      TEXT,                                    -- exact_match | partial_match | fail | hallucinated | cannot_determine
  correction_value  TEXT,                                    -- rater's corrected value if non-exact
  harm_severity     INTEGER,                                 -- 1..5; NULL for exact_match
  error_taxonomy    TEXT,                                    -- '1','3a','3b','4','5','6','7','8' (Class 2 deprecated in V4)
  pipeline_section  TEXT,                                    -- 'extractor' | 'critic' | 'post-processing'
  root_cause_stage  TEXT,                                    -- optional: extractor|critic|schema_design|prompt_guidance|document_structure
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, rater_id, phase, field_name)
);

CREATE INDEX idx_phase2_grades_paper ON phase2_grades(paper_id);
CREATE INDEX idx_phase2_grades_rater ON phase2_grades(rater_id);
CREATE INDEX idx_phase2_grades_field ON phase2_grades(field_name);

CREATE TRIGGER trg_phase2_grades_updated BEFORE UPDATE ON phase2_grades
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();


-- ============================================================
-- 7. phase3_arbitrations
-- Per-(paper, field) final arbitrated decision. One row per field,
-- regardless of whether there was a discrepancy. arbitrated_value is
-- the validated ground truth used for the library export and the
-- pilot meta-analysis input (PROTOCOL §9).
-- ============================================================
CREATE TABLE phase3_arbitrations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id              UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  field_name            TEXT        NOT NULL,
  v4_value              TEXT,                                -- pipeline value at arbitration
  v1_value              TEXT,                                -- V1 snapshot (for Class 8 detection)
  rater_a_id            TEXT        REFERENCES validation_raters(rater_id) ON DELETE SET NULL,
  rater_b_id            TEXT        REFERENCES validation_raters(rater_id) ON DELETE SET NULL,
  rater_a_correction    TEXT,
  rater_b_correction    TEXT,
  rater_a_match_status  TEXT,
  rater_b_match_status  TEXT,
  arbitrator_id         TEXT        REFERENCES validation_raters(rater_id) ON DELETE SET NULL,
  arbitrated_value      TEXT,                                -- final ground truth
  arbitrator_decision   TEXT,                                -- adopt_a | adopt_b | new_value | exact_match_confirmed | both_correct
  arbitrator_notes      TEXT,
  arbitrated_at         TIMESTAMPTZ,
  locked                BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, field_name)
);

CREATE INDEX idx_phase3_arbitrations_paper       ON phase3_arbitrations(paper_id);
CREATE INDEX idx_phase3_arbitrations_arbitrator  ON phase3_arbitrations(arbitrator_id);

CREATE TRIGGER trg_phase3_arbitrations_updated BEFORE UPDATE ON phase3_arbitrations
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();

COMMENT ON TABLE phase3_arbitrations IS
  'Per-field final arbitrated decision. Used for both Phase 2 rater-pair discrepancies and Phase 1a evaluative-field disagreements (rob_overall, grade_certainty per PROTOCOL §2.3).';


-- ============================================================
-- 8. phase3_paper_ratings
-- Arbitrator's overall paper-level quality + usability ratings.
-- ============================================================
CREATE TABLE phase3_paper_ratings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID        NOT NULL REFERENCES validation_papers(id) ON DELETE CASCADE,
  arbitrator_id     TEXT        NOT NULL REFERENCES validation_raters(rater_id) ON DELETE CASCADE,
  quality_rating    INTEGER,                                 -- 1..5
  usability_rating  INTEGER,                                 -- 1..5
  notes             TEXT,
  submitted_at      TIMESTAMPTZ,
  locked            BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paper_id, arbitrator_id)
);

CREATE TRIGGER trg_phase3_paper_ratings_updated BEFORE UPDATE ON phase3_paper_ratings
  FOR EACH ROW EXECUTE FUNCTION validation_set_updated_at();


-- ============================================================
-- 9. RLS — service role bypasses (matches schema-study.sql pattern)
-- ============================================================
ALTER TABLE validation_raters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_papers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase1a_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase1a_extractions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase2_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase2_grades         ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase3_arbitrations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase3_paper_ratings  ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- 10. Reporting view — paper progress across all phases
-- ============================================================
CREATE OR REPLACE VIEW validation_paper_progress AS
SELECT
  p.id                                                                                        AS paper_id,
  p.paper_number,
  p.short_label,
  p.title,
  p.is_preliminary,
  p.crossover_assignment,
  p.v4_extraction_id IS NOT NULL                                                              AS pipeline_run,
  (SELECT COUNT(*) FROM phase1a_sessions s WHERE s.paper_id = p.id AND s.locked)              AS phase1a_raters_done,
  (SELECT COUNT(*) FROM phase2_sessions s WHERE s.paper_id = p.id AND s.phase = '2a' AND s.locked) AS phase2a_raters_done,
  (SELECT COUNT(*) FROM phase2_sessions s WHERE s.paper_id = p.id AND s.phase = '2b' AND s.locked) AS phase2b_raters_done,
  (SELECT COUNT(*) FROM phase3_arbitrations a WHERE a.paper_id = p.id AND a.locked)           AS phase3_fields_arbitrated,
  p.phase3_locked                                                                             AS arbitration_complete
FROM validation_papers p
WHERE p.is_active = true;


-- ============================================================
-- 11. Seed: 5 HFrEF beta-blocker preliminary test papers
-- PMIDs intentionally NULL — must be verified against live PubMed
-- before PDFs are obtained (PROTOCOL §0). LEARNINGS.md Session 8:
-- AI-generated PMIDs were wrong; do not seed unverified PMIDs.
-- ============================================================
INSERT INTO validation_papers (short_label, title, is_preliminary, notes) VALUES
  ('CIBIS-II',   'The Cardiac Insufficiency Bisoprolol Study II (CIBIS-II): a randomised trial. Lancet 1999;353:9-13.',                      true, 'Preliminary HFrEF beta-blocker test set. Verify PMID before use.'),
  ('MERIT-HF',   'Effect of metoprolol CR/XL in chronic heart failure: MERIT-HF. Lancet 1999;353:2001-7.',                                   true, 'Preliminary test set. Verify PMID.'),
  ('COPERNICUS', 'Effect of carvedilol on survival in severe chronic heart failure (COPERNICUS). Packer M et al. NEJM 2001;344:1651-8.',    true, 'Preliminary test set. Verify PMID.'),
  ('SENIORS',    'Randomized trial of nebivolol on mortality and CV hospitalization in elderly heart failure (SENIORS). Eur Heart J 2005.', true, 'Preliminary test set. Verify PMID.'),
  ('BEST',       'A trial of the beta-blocker bucindolol in patients with advanced chronic heart failure (BEST). NEJM 2001;344:1659-67.',   true, 'Preliminary test set. Null result — tests pipeline does not fabricate significance. Verify PMID.');


-- ============================================================
-- 12. Seed: rater rows (commented — uncomment, edit passphrases, run)
-- ============================================================
-- INSERT INTO validation_raters (rater_id, display_name, pair, role, passphrase) VALUES
--   ('rater_a1', 'Rater A1',    'A',  'phase1a,phase2',  'CHANGEME'),
--   ('rater_a2', 'Rater A2',    'A',  'phase1a,phase2',  'CHANGEME'),
--   ('rater_b1', 'Rater B1',    'B',  'phase1a,phase2',  'CHANGEME'),
--   ('rater_b2', 'Rater B2',    'B',  'phase1a,phase2',  'CHANGEME'),
--   ('arbiter',  'Arbitrator',  NULL, 'arbitrator',      'CHANGEME'),
--   ('admin',    'Study Admin', NULL, 'admin',           'CHANGEME');


-- ============================================================
-- 13. Migration helpers (idempotent — safe to re-run on live DB)
-- For deployments that ran the original Session 20 schema, this
-- adds the Session 21 Phase 3 / library columns without DROPping.
-- ============================================================
ALTER TABLE validation_papers ADD COLUMN IF NOT EXISTS merged_json      JSONB;
ALTER TABLE validation_papers ADD COLUMN IF NOT EXISTS merged_at        TIMESTAMPTZ;
ALTER TABLE validation_papers ADD COLUMN IF NOT EXISTS library_trial_id UUID;


-- ============================================================
-- End of validation schema
-- ============================================================
