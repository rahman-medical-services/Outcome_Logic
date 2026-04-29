-- One-time setup: create the Supabase Storage bucket for validation-study PDFs.
-- Run once after deploying schema-validation.sql. Idempotent.
--
-- Bucket policy:
--   - public = true: PDF URLs are directly accessible (RCT PDFs are public artefacts)
--   - 20MB file size cap
--   - application/pdf only
--
-- If you later want this private + signed URLs, set public=false and add
-- explicit RLS policies on storage.objects. For a closed study with public
-- RCTs the simpler public-read configuration is fine.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'validation-pdfs',
  'validation-pdfs',
  true,
  20971520,                  -- 20 MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
