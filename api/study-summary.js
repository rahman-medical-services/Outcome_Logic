// api/study-summary.js
// Aggregated grading data for the Phase 0 pilot summary view.
// Admin-only: requires INTERNAL_API_TOKEN + admin-tier JWT.
//
// GET /api/study-summary
//   Returns per-field aggregations, version breakdown, and overall metrics
//   for all pilot papers that have been graded.

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
function getAdminClient() {
  const url    = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) throw new Error('Supabase env not configured.');
  return createClient(url, svcKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getAnonClient() {
  const url     = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env not configured.');
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ─────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────
async function requireAdmin(req, res) {
  const apiToken = req.headers['x-api-token'];
  if (!apiToken || apiToken !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorised.' });
    return null;
  }
  const bearer = req.headers['authorization']?.replace('Bearer ', '');
  if (!bearer) {
    res.status(401).json({ error: 'No user session.' });
    return null;
  }
  const { data: { user }, error } = await getAnonClient().auth.getUser(bearer);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return null;
  }
  const tier = user.user_metadata?.tier || 'free';
  if (tier !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return user;
}

// ─────────────────────────────────────────────
// AGGREGATION HELPERS
// ─────────────────────────────────────────────

function computeFieldAggregations(grades) {
  // Group grades by field_name
  const byField = {};
  for (const grade of grades) {
    const fn = grade.field_name;
    if (!byField[fn]) byField[fn] = [];
    byField[fn].push(grade);
  }

  const fieldSummaries = [];

  for (const [field_name, rows] of Object.entries(byField)) {
    const total_graded       = rows.length;
    const exact_count        = rows.filter(r => r.match_status === 'exact_match').length;
    const partial_count      = rows.filter(r => r.match_status === 'partial_match').length;
    const fail_count         = rows.filter(r => r.match_status === 'fail').length;
    const hallucinated_count = rows.filter(r => r.match_status === 'hallucinated').length;

    // Average severity over non-null harm_severity values
    const severityRows  = rows.filter(r => r.harm_severity !== null && r.harm_severity !== undefined);
    const avg_severity  = severityRows.length > 0
      ? severityRows.reduce((sum, r) => sum + r.harm_severity, 0) / severityRows.length
      : 0;

    // priority_score = avg_severity × (1 - exact_rate)
    // which equals avg_severity × (fail+partial+hallucinated) / total
    const non_exact     = fail_count + partial_count + hallucinated_count;
    const priority_score = total_graded > 0
      ? avg_severity * (non_exact / total_graded)
      : 0;

    // Error taxonomy distribution
    const error_taxonomy_dist = { omission: 0, misclassification: 0, formatting_syntax: 0, semantic: 0 };
    for (const r of rows) {
      if (r.error_taxonomy && r.error_taxonomy in error_taxonomy_dist) {
        error_taxonomy_dist[r.error_taxonomy]++;
      }
    }

    // Pipeline section distribution
    const pipeline_section_dist = { extractor: 0, adjudicator: 0, post_processing: 0 };
    for (const r of rows) {
      if (r.pipeline_section && r.pipeline_section in pipeline_section_dist) {
        pipeline_section_dist[r.pipeline_section]++;
      }
    }

    // Most recent correction text for this field (for the prompt queue)
    const withCorrection = rows
      .filter(r => r.correction_text)
      .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    const latest_correction_text = withCorrection.length > 0 ? withCorrection[0].correction_text : null;

    // Dominant error type
    const taxEntries = Object.entries(error_taxonomy_dist).filter(([, n]) => n > 0);
    taxEntries.sort((a, b) => b[1] - a[1]);
    const dominant_error_taxonomy = taxEntries.length > 0 ? taxEntries[0][0] : null;

    // Dominant pipeline section
    const secEntries = Object.entries(pipeline_section_dist).filter(([, n]) => n > 0);
    secEntries.sort((a, b) => b[1] - a[1]);
    const dominant_pipeline_section = secEntries.length > 0 ? secEntries[0][0] : null;

    fieldSummaries.push({
      field_name,
      total_graded,
      exact_count,
      partial_count,
      fail_count,
      hallucinated_count,
      avg_severity:            Math.round(avg_severity * 100) / 100,
      priority_score:          Math.round(priority_score * 100) / 100,
      error_taxonomy_dist,
      pipeline_section_dist,
      latest_correction_text,
      dominant_error_taxonomy,
      dominant_pipeline_section,
    });
  }

  // Sort by priority_score descending
  fieldSummaries.sort((a, b) => b.priority_score - a.priority_score);

  return fieldSummaries;
}

function computeVersionBreakdown(grades) {
  const v1Grades = grades.filter(g => g.version === 'v1');
  const v2Grades = grades.filter(g => g.version === 'v2');

  function breakdown(rows) {
    const total      = rows.length;
    const exactCount = rows.filter(r => r.match_status === 'exact_match').length;
    return {
      total,
      exact_count: exactCount,
      exact_rate:  total > 0 ? Math.round((exactCount / total) * 10000) / 100 : null,
    };
  }

  return {
    v1: breakdown(v1Grades),
    v2: breakdown(v2Grades),
  };
}

function computeTaxonomyBreakdown(grades) {
  const nonExact = grades.filter(g => g.match_status !== 'exact_match' && g.match_status !== null);
  const total    = nonExact.length;

  const categories = ['omission', 'misclassification', 'formatting_syntax', 'semantic'];
  return categories.map(taxonomy => {
    const rows      = nonExact.filter(g => g.error_taxonomy === taxonomy);
    const count     = rows.length;
    const pct       = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;

    // Most affected fields by this taxonomy
    const fieldCounts = {};
    for (const r of rows) {
      fieldCounts[r.field_name] = (fieldCounts[r.field_name] || 0) + 1;
    }
    const mostAffected = Object.entries(fieldCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([f]) => f);

    return { taxonomy, count, pct_of_non_exact: pct, most_affected_fields: mostAffected };
  });
}

function computePipelineBreakdown(grades, fieldSummaries) {
  const sections = ['extractor', 'adjudicator', 'post_processing'];
  return sections.map(section => {
    const rows  = grades.filter(g => g.pipeline_section === section);
    const count = rows.length;

    // Top field for this section
    const fieldCounts = {};
    for (const r of rows) {
      fieldCounts[r.field_name] = (fieldCounts[r.field_name] || 0) + 1;
    }
    const topEntry = Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])[0];
    const top_field = topEntry ? topEntry[0] : null;

    return { section, error_count: count, top_field };
  });
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method Not Allowed' });

  const user = await requireAdmin(req, res);
  if (!user) return;

  const supabase = getAdminClient();

  // 1. Fetch all grades for pilot papers (join through outputs → papers)
  const { data: grades, error: gradesErr } = await supabase
    .from('study_grades')
    .select(`
      id,
      field_name,
      match_status,
      error_taxonomy,
      harm_severity,
      pipeline_section,
      correction_text,
      reference_standard_value,
      suspicious_agreement,
      graded_at,
      study_outputs!inner (
        id,
        paper_id,
        version,
        study_papers!inner (
          id,
          title,
          is_pilot
        )
      )
    `)
    .eq('study_outputs.study_papers.is_pilot', true);

  if (gradesErr) {
    console.error('[study-summary] Grades fetch error:', gradesErr.message);
    return res.status(500).json({ error: gradesErr.message });
  }

  // 2. Count pilot papers
  const { count: pilotPaperCount, error: paperCountErr } = await supabase
    .from('study_papers')
    .select('id', { count: 'exact', head: true })
    .eq('is_pilot', true);

  if (paperCountErr) {
    console.error('[study-summary] Paper count error:', paperCountErr.message);
    return res.status(500).json({ error: paperCountErr.message });
  }

  // 3. Flatten grades — attach version and paper info to each grade row
  const flatGrades = (grades || []).map(g => ({
    id:                      g.id,
    field_name:              g.field_name,
    match_status:            g.match_status,
    error_taxonomy:          g.error_taxonomy,
    harm_severity:           g.harm_severity,
    pipeline_section:        g.pipeline_section,
    correction_text:         g.correction_text,
    reference_standard_value: g.reference_standard_value,
    suspicious_agreement:    g.suspicious_agreement,
    graded_at:               g.graded_at,
    output_id:               g.study_outputs?.id,
    paper_id:                g.study_outputs?.study_papers?.id,
    version:                 g.study_outputs?.version,
    paper_title:             g.study_outputs?.study_papers?.title,
  }));

  // 4. Count distinct output_ids with at least one grade
  const gradedOutputIds = new Set(flatGrades.map(g => g.output_id).filter(Boolean));
  const gradedOutputCount = gradedOutputIds.size;

  // 5. Count distinct papers with at least one grade
  const gradedPaperIds = new Set(flatGrades.map(g => g.paper_id).filter(Boolean));
  const papersGraded   = gradedPaperIds.size;

  // 6. Compute overall metrics
  const totalGrades    = flatGrades.length;
  const exactCount     = flatGrades.filter(g => g.match_status === 'exact_match').length;
  const overallExactRate = totalGrades > 0
    ? Math.round((exactCount / totalGrades) * 10000) / 100
    : null;

  // 7. Per-field aggregations
  const fieldSummaries = computeFieldAggregations(flatGrades);

  // 8. Version breakdown
  const version_breakdown = computeVersionBreakdown(flatGrades);

  // 9. Taxonomy breakdown
  const taxonomy_breakdown = computeTaxonomyBreakdown(flatGrades);

  // 10. Pipeline section breakdown
  const pipeline_breakdown = computePipelineBreakdown(flatGrades, fieldSummaries);

  // 11. Prompt modification queue: fields with priority_score > 1.0, ordered
  const prompt_queue = fieldSummaries
    .filter(f => f.priority_score > 1.0)
    .map(f => ({
      field_name:               f.field_name,
      priority_score:           f.priority_score,
      dominant_error_taxonomy:  f.dominant_error_taxonomy,
      dominant_pipeline_section: f.dominant_pipeline_section,
      latest_correction_text:   f.latest_correction_text,
    }));

  return res.status(200).json({
    summary: fieldSummaries,
    overall: {
      exact_rate:           overallExactRate,
      total_grades:         totalGrades,
      papers_graded:        papersGraded,
      pilot_paper_count:    pilotPaperCount,
      graded_output_count:  gradedOutputCount,
    },
    version_breakdown,
    taxonomy_breakdown,
    pipeline_breakdown,
    prompt_queue,
  });
}
