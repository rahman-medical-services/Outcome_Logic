-- Seed minimal multi-rater identities for end-to-end smoke testing of
-- Phase 1a blinding, Phase 2 crossover visibility, and Phase 3 arbitration.
--
-- Idempotent: re-running resets pair, roles, and passphrase but keeps
-- rater_id stable (so existing rows in phase1a_extractions etc. survive).
--
-- Change every passphrase below before exposing to external raters.
-- These are smoke-test credentials only.

INSERT INTO validation_raters (rater_id, display_name, pair, role, passphrase) VALUES
  ('rater_a', 'Test Rater A', 'A',  'phase1a,phase2', 'test_a'),
  ('rater_b', 'Test Rater B', 'B',  'phase1a,phase2', 'test_b'),
  ('arbiter', 'Test Arbiter', NULL, 'arbitrator',     'test_arb'),
  ('admin',   'Study Admin',  NULL, 'admin',          'test_admin')
ON CONFLICT (rater_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  pair         = EXCLUDED.pair,
  role         = EXCLUDED.role,
  passphrase   = EXCLUDED.passphrase,
  is_active    = true;

-- Quick sanity report
SELECT rater_id, display_name, pair, role, is_active
FROM validation_raters
ORDER BY pair NULLS LAST, rater_id;
