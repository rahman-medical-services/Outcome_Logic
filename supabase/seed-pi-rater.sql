-- Seed the PI as an all-phases rater for testing.
-- Idempotent: re-running resets pair, roles, and passphrase but keeps rater_id stable.
-- Change the passphrase ('test') before any external rater uses the system.

INSERT INTO validation_raters (rater_id, display_name, pair, role, passphrase)
VALUES ('saqib', 'Saqib Rahman (PI — testing)', 'A', 'phase1a,phase2,arbitrator,admin', 'test')
ON CONFLICT (rater_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  pair         = EXCLUDED.pair,
  role         = EXCLUDED.role,
  passphrase   = EXCLUDED.passphrase,
  is_active    = true;
