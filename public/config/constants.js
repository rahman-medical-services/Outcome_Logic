// config/constants.js
// Static compile-time constants only.
// Runtime values (API keys, URLs) are read directly from window.ENV
// inside each module's functions — never at module parse time.

export const APP_VERSION        = '4.0.0';
export const APP_NAME           = 'OutcomeLogic';
export const BATCH_MAX_FILES    = 20;
export const BATCH_JOB_DELAY_MS = 3000;
export const LIBRARY_TABLE      = 'trials';

export const FEATURES = {
  library:    true,
  batch:      true,
  export:     true,
  validation: true,
  paidTier:   false,
};