// config/taxonomy.js
// Canonical domain → specialty → subspecialty tree
// Single source of truth for all dropdowns, Gemini prompts, and Supabase queries.
// To add a new specialty: add one entry here. Nothing else needs changing.

export const TAXONOMY = {
  Surgery: {
    'Upper GI': [
      'Oesophageal',
      'Gastric',
      'Bariatric',
      'Biliary',
      'Pancreatic',
      'Liver',
    ],
    'Hernia': [
      'Inguinal',
      'Incisional',
      'Hiatus',
      'Parastomal',
      'Umbilical',
      'Femoral',
    ],
    'Colorectal': [
      'Rectal Cancer',
      'Colonic Cancer',
      'Inflammatory Bowel Disease',
      'Diverticular Disease',
      'Anal',
    ],
    'Breast': [
      'Breast Cancer — Early',
      'Breast Cancer — Advanced',
      'Reconstruction',
    ],
    'Endocrine': [
      'Thyroid',
      'Parathyroid',
      'Adrenal',
    ],
    'Vascular': [
      'Aortic',
      'Peripheral Arterial',
      'Carotid',
      'Venous',
    ],
    'Hepatobiliary': [
      'Liver Resection',
      'Transplant',
      'Portal Hypertension',
    ],
  },

  Orthopaedics: {
    'Hip': [
      'Arthroplasty',
      'Fracture',
      'Dysplasia',
    ],
    'Knee': [
      'Arthroplasty',
      'Ligament',
      'Meniscus',
      'Cartilage',
    ],
    'Spine': [
      'Lumbar Disc',
      'Spinal Stenosis',
      'Deformity',
      'Infection',
    ],
    'Shoulder': [
      'Arthroplasty',
      'Rotator Cuff',
      'Instability',
    ],
    'Trauma': [
      'Long Bone Fracture',
      'Pelvic Fracture',
      'Polytrauma',
    ],
  },

  Medicine: {
    'Cardiology': [
      'Heart Failure',
      'Acute Coronary Syndrome',
      'Arrhythmia',
      'Valvular Disease',
      'Hypertension',
    ],
    'Oncology': [
      'Lung Cancer',
      'Breast Cancer',
      'Colorectal Cancer',
      'Haematological',
      'Immunotherapy',
    ],
    'Respiratory': [
      'COPD',
      'Asthma',
      'Pulmonary Fibrosis',
      'Pulmonary Hypertension',
    ],
    'Gastroenterology': [
      'Inflammatory Bowel Disease',
      'Liver Disease',
      'Pancreatic Disease',
      'Upper GI',
    ],
    'Endocrinology': [
      'Diabetes — Type 1',
      'Diabetes — Type 2',
      'Thyroid',
      'Obesity',
    ],
    'Neurology': [
      'Stroke',
      'Multiple Sclerosis',
      'Parkinson\'s Disease',
      'Epilepsy',
    ],
    'Infectious Disease': [
      'Sepsis',
      'Antimicrobial Resistance',
      'HIV',
      'Respiratory Infection',
    ],
  },

  'Critical Care': {
    'ICU': [
      'Sepsis',
      'ARDS',
      'Ventilation',
      'Nutrition',
      'Sedation',
    ],
    'Emergency Medicine': [
      'Trauma',
      'Resuscitation',
      'Toxicology',
    ],
  },

  Anaesthesia: {
    'Regional': [
      'Neuraxial',
      'Peripheral Nerve Block',
      'Enhanced Recovery',
    ],
    'General': [
      'Airway',
      'PONV',
      'Pain Management',
    ],
  },
};

// ─────────────────────────────────────────────
// DERIVED HELPERS
// Used by dropdowns, Gemini prompts, and validation
// ─────────────────────────────────────────────

/** All domain names as a sorted array */
export const DOMAINS = Object.keys(TAXONOMY).sort();

/** All specialty names for a given domain */
export function getSpecialties(domain) {
  if (!domain || !TAXONOMY[domain]) return [];
  return Object.keys(TAXONOMY[domain]).sort();
}

/** All subspecialty names for a given domain + specialty */
export function getSubspecialties(domain, specialty) {
  if (!domain || !specialty) return [];
  return (TAXONOMY[domain]?.[specialty] || []).sort();
}

/** Flat list of all specialties across all domains — for Gemini prompts */
export function getAllSpecialties() {
  return Object.entries(TAXONOMY).flatMap(([domain, specialties]) =>
    Object.keys(specialties).map(spec => `${domain} > ${spec}`)
  ).sort();
}

/** Flat list of all subspecialties — for Gemini prompts */
export function getAllSubspecialties() {
  return Object.entries(TAXONOMY).flatMap(([domain, specialties]) =>
    Object.entries(specialties).flatMap(([spec, subs]) =>
      subs.map(sub => `${domain} > ${spec} > ${sub}`)
    )
  ).sort();
}

/** Validate that a domain/specialty/subspecialty combination exists in the taxonomy */
export function isValidTaxonomy(domain, specialty, subspecialty) {
  if (!TAXONOMY[domain]) return false;
  if (!TAXONOMY[domain][specialty]) return false;
  if (subspecialty && !TAXONOMY[domain][specialty].includes(subspecialty)) return false;
  return true;
}

/** Best-effort fuzzy match — used when Gemini returns a near-miss string */
export function findClosestMatch(domain, specialty, subspecialty) {
  const domainMatch = DOMAINS.find(d =>
    d.toLowerCase() === domain?.toLowerCase()
  ) || DOMAINS[0];

  const specs = getSpecialties(domainMatch);
  const specMatch = specs.find(s =>
    s.toLowerCase() === specialty?.toLowerCase()
  ) || specs[0];

  const subs = getSubspecialties(domainMatch, specMatch);
  const subMatch = subs.find(s =>
    s.toLowerCase() === subspecialty?.toLowerCase()
  ) || null;

  return { domain: domainMatch, specialty: specMatch, subspecialty: subMatch };
}