// config/tiers.js
// Single source of truth for tier permissions.
// Frontend and backend both reference this — frontend for UI rendering,
// backend for API enforcement.
//
// Tiers:
//   admin    — full rights
//   pro      — library + analyse + add papers + batch upload
//   standard — library read only
//   free     — 10 curated landmark papers only (read only)

export const TIERS = {
  admin: {
    label:          'Admin',
    canSearch:      true,
    canAnalyse:     true,
    canAddToLib:    true,
    canBatchUpload: true,
    canValidate:    true,
    canEditData:    true,
    canDelete:      true,
    canEscalate:    true,
    canManageUsers: true,
    canSetLandmark: true,
    libraryAccess:  'full',     // all trials
    analysisLimit:  null,       // unlimited
  },
  pro: {
    label:          'Pro',
    canSearch:      true,
    canAnalyse:     true,
    canAddToLib:    true,
    canBatchUpload: true,
    canValidate:    false,
    canEditData:    false,
    canDelete:      false,
    canEscalate:    false,
    canManageUsers: false,
    canSetLandmark: false,
    libraryAccess:  'full',
    analysisLimit:  50,         // per day
  },
  standard: {
    label:          'Standard',
    canSearch:      true,
    canAnalyse:     false,
    canAddToLib:    false,
    canBatchUpload: false,
    canValidate:    false,
    canEditData:    false,
    canDelete:      false,
    canEscalate:    false,
    canManageUsers: false,
    canSetLandmark: false,
    libraryAccess:  'full',
    analysisLimit:  0,
  },
  free: {
    label:          'Free',
    canSearch:      false,
    canAnalyse:     false,
    canAddToLib:    false,
    canBatchUpload: false,
    canValidate:    false,
    canEditData:    false,
    canDelete:      false,
    canEscalate:    false,
    canManageUsers: false,
    canSetLandmark: false,
    libraryAccess:  'landmark',  // curated 10 only
    analysisLimit:  0,
  },
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Check if a tier has a specific permission */
export function can(tier, permission) {
  return TIERS[tier]?.[permission] === true;
}

/** Get the full config object for a tier */
export function getTierConfig(tier) {
  return TIERS[tier] || TIERS.free;
}

/** Tier display labels for UI */
export const TIER_LABELS = {
  admin:    'Admin',
  pro:      'Pro',
  standard: 'Standard',
  free:     'Free',
};

/** Tier badge colours — Tailwind classes */
export const TIER_COLOURS = {
  admin:    { bg: 'bg-purple-100', text: 'text-purple-700' },
  pro:      { bg: 'bg-blue-100',   text: 'text-blue-700'   },
  standard: { bg: 'bg-slate-100',  text: 'text-slate-600'  },
  free:     { bg: 'bg-slate-100',  text: 'text-slate-400'  },
};

/** Upgrade message shown when a lower-tier user hits a gated feature */
export const UPGRADE_MESSAGES = {
  canAnalyse:     'Upgrade to Pro to run analyses.',
  canAddToLib:    'Upgrade to Pro to save trials to the library.',
  canBatchUpload: 'Upgrade to Pro to use batch upload.',
  canValidate:    'Admin access required to validate trials.',
  canEditData:    'Admin access required to edit trial data.',
  canDelete:      'Admin access required to delete trials.',
  default:        'Upgrade your plan to access this feature.',
};

export function upgradeMessage(permission) {
  return UPGRADE_MESSAGES[permission] || UPGRADE_MESSAGES.default;
}