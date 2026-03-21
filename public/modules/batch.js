// modules/batch.js
// Batch PDF upload UI.
// Renders a modal with file picker, per-file status, and progress bar.
// Calls api/library-batch.js which runs each PDF through lib/pipeline.js sequentially.

import { getAccessToken }                   from './auth.js';
import { API_BASE_URL, INTERNAL_API_TOKEN, BATCH_MAX_FILES } from '../config/constants.js';
import { toast }                            from '../components/toasts.js';

// ─────────────────────────────────────────────
// OPEN / CLOSE
// ─────────────────────────────────────────────
export function openBatchModal(onComplete) {
  const existing = document.getElementById('batch-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'batch-modal-overlay';
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';

  overlay.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-lg">

      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200">
        <div>
          <h2 class="text-lg font-bold text-slate-900">Batch PDF Upload</h2>
          <p class="text-xs text-slate-500 mt-0.5">Upload up to ${BATCH_MAX_FILES} PDFs — processed sequentially</p>
        </div>
        <button id="batch-modal-close" class="text-slate-400 hover:text-slate-700 transition text-xl">✕</button>
      </div>

      <!-- File picker -->
      <div class="px-6 py-4" id="batch-picker-area">
        <label class="flex flex-col items-center justify-center w-full h-32
                       border-2 border-dashed border-slate-300 rounded-lg cursor-pointer
                       hover:border-slate-400 hover:bg-slate-50 transition">
          <span class="text-2xl mb-1">📄</span>
          <span class="text-sm font-medium text-slate-600">Drop PDFs here or click to select</span>
          <span class="text-xs text-slate-400 mt-1">PDF files only · Max ${BATCH_MAX_FILES} files</span>
          <input type="file" id="batch-file-input" accept="application/pdf" multiple class="hidden" />
        </label>
      </div>

      <!-- File list (hidden until files selected) -->
      <div id="batch-file-list" class="hidden px-6 pb-2 max-h-56 overflow-y-auto space-y-1.5"></div>

      <!-- Progress bar (hidden until processing) -->
      <div id="batch-progress-area" class="hidden px-6 py-3">
        <div class="flex justify-between text-xs text-slate-500 mb-1">
          <span id="batch-progress-label">Processing…</span>
          <span id="batch-progress-count">0 / 0</span>
        </div>
        <div class="w-full bg-slate-200 rounded-full h-2">
          <div id="batch-progress-bar" class="bg-slate-900 h-2 rounded-full transition-all duration-500"
               style="width:0%"></div>
        </div>
      </div>

      <!-- Error -->
      <div id="batch-error" class="hidden mx-6 mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"></div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-slate-200 flex justify-between items-center">
        <span id="batch-file-count" class="text-xs text-slate-400">No files selected</span>
        <div class="flex gap-2">
          <button id="batch-btn-cancel"
            class="px-4 py-2 rounded text-sm text-slate-600 hover:bg-slate-100 transition">
            Cancel
          </button>
          <button id="batch-btn-start" disabled
            class="px-4 py-2 rounded text-sm font-bold bg-slate-900 text-white
                   hover:bg-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
            Start Batch
          </button>
        </div>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);
  _wireBatchModal(overlay, onComplete);
}

export function closeBatchModal() {
  document.getElementById('batch-modal-overlay')?.remove();
}

// ─────────────────────────────────────────────
// WIRE EVENTS
// ─────────────────────────────────────────────
function _wireBatchModal(overlay, onComplete) {
  let selectedFiles = [];

  const closeBtn   = overlay.querySelector('#batch-modal-close');
  const cancelBtn  = overlay.querySelector('#batch-btn-cancel');
  const startBtn   = overlay.querySelector('#batch-btn-start');
  const fileInput  = overlay.querySelector('#batch-file-input');
  const fileList   = overlay.querySelector('#batch-file-list');
  const fileCount  = overlay.querySelector('#batch-file-count');
  const errorEl    = overlay.querySelector('#batch-error');

  closeBtn.onclick  = closeBatchModal;
  cancelBtn.onclick = closeBatchModal;

  // File selection
  fileInput.onchange = () => {
    selectedFiles = Array.from(fileInput.files).slice(0, BATCH_MAX_FILES);
    _updateFileList(overlay, selectedFiles);
    fileCount.textContent = selectedFiles.length
      ? `${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''} selected`
      : 'No files selected';
    startBtn.disabled = selectedFiles.length === 0;
    errorEl.classList.add('hidden');
  };

  // Drag and drop
  const pickerArea = overlay.querySelector('#batch-picker-area');
  pickerArea.addEventListener('dragover', (e) => { e.preventDefault(); pickerArea.classList.add('bg-slate-50'); });
  pickerArea.addEventListener('dragleave', () => pickerArea.classList.remove('bg-slate-50'));
  pickerArea.addEventListener('drop', (e) => {
    e.preventDefault();
    pickerArea.classList.remove('bg-slate-50');
    const dropped = Array.from(e.dataTransfer.files)
      .filter(f => f.type === 'application/pdf')
      .slice(0, BATCH_MAX_FILES);
    if (!dropped.length) { toast.warning('Please drop PDF files only.'); return; }
    selectedFiles = dropped;
    _updateFileList(overlay, selectedFiles);
    fileCount.textContent = `${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''} selected`;
    startBtn.disabled     = false;
  });

  // Start batch
  startBtn.onclick = async () => {
    if (!selectedFiles.length) return;
    errorEl.classList.add('hidden');
    await _runBatch(overlay, selectedFiles, onComplete);
  };
}

// ─────────────────────────────────────────────
// FILE LIST RENDER
// ─────────────────────────────────────────────
function _updateFileList(overlay, files) {
  const listEl = overlay.querySelector('#batch-file-list');
  if (!files.length) { listEl.classList.add('hidden'); return; }

  listEl.classList.remove('hidden');
  listEl.innerHTML = files.map((f, i) => `
    <div class="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded text-xs" data-index="${i}">
      <span class="text-slate-400 shrink-0">📄</span>
      <span class="flex-1 min-w-0 truncate text-slate-700 font-medium">${escHtml(f.name)}</span>
      <span class="shrink-0 text-slate-400">${_formatSize(f.size)}</span>
      <span class="job-status shrink-0 text-slate-300">○ Pending</span>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────
// RUN BATCH
// ─────────────────────────────────────────────
async function _runBatch(overlay, files, onComplete) {
  const startBtn     = overlay.querySelector('#batch-btn-start');
  const cancelBtn    = overlay.querySelector('#batch-btn-cancel');
  const progressArea = overlay.querySelector('#batch-progress-area');
  const progressBar  = overlay.querySelector('#batch-progress-bar');
  const progressLbl  = overlay.querySelector('#batch-progress-label');
  const progressCnt  = overlay.querySelector('#batch-progress-count');
  const errorEl      = overlay.querySelector('#batch-error');

  startBtn.disabled     = true;
  startBtn.textContent  = 'Processing…';
  cancelBtn.textContent = 'Close';
  progressArea.classList.remove('hidden');

  try {
    const token = getAccessToken();
    if (!token) throw new Error('No active session. Please sign in.');

    // Convert files to base64
    progressLbl.textContent = 'Reading files…';
    const filePayloads = await Promise.all(files.map(async f => ({
      name:   f.name,
      base64: await _fileToBase64(f),
    })));

    progressLbl.textContent = 'Sending to pipeline…';
    progressCnt.textContent = `0 / ${files.length}`;

    // Single API call — server processes sequentially
    const response = await fetch(`${API_BASE_URL}/library-batch`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-token':   INTERNAL_API_TOKEN,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ files: filePayloads }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Batch failed.');

    // Update UI with job results
    const jobs = data.jobs || [];
    _updateJobStatuses(overlay, jobs);

    const completed = jobs.filter(j => j.status === 'complete').length;
    const failed    = jobs.filter(j => j.status === 'failed').length;

    progressBar.style.width  = '100%';
    progressCnt.textContent  = `${completed} / ${files.length}`;
    progressLbl.textContent  = failed
      ? `Done — ${completed} saved, ${failed} failed`
      : `Done — ${completed} saved`;

    if (completed > 0) {
      toast.success(`${completed} trial${completed !== 1 ? 's' : ''} saved to library. Awaiting validation.`);
      onComplete?.(jobs);
    }
    if (failed > 0) {
      toast.warning(`${failed} file${failed !== 1 ? 's' : ''} failed — see list for details.`);
    }

    startBtn.textContent = 'Done';

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    startBtn.textContent = 'Start Batch';
    startBtn.disabled    = false;
    progressArea.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
// UPDATE JOB STATUSES IN FILE LIST
// ─────────────────────────────────────────────
function _updateJobStatuses(overlay, jobs) {
  const listEl = overlay.querySelector('#batch-file-list');
  jobs.forEach((job, i) => {
    const row       = listEl.querySelector(`[data-index="${i}"]`);
    const statusEl  = row?.querySelector('.job-status');
    if (!statusEl) return;

    if (job.status === 'complete') {
      statusEl.textContent  = '✓ Saved';
      statusEl.className    = 'job-status shrink-0 text-green-600 font-bold';
    } else if (job.status === 'failed') {
      statusEl.textContent  = `✕ Failed`;
      statusEl.className    = 'job-status shrink-0 text-red-500';
      statusEl.title        = job.error || 'Unknown error';
    }
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader    = new FileReader();
    reader.onload   = () => resolve(reader.result.split(',')[1]);
    reader.onerror  = reject;
    reader.readAsDataURL(file);
  });
}

function _formatSize(bytes) {
  if (bytes < 1024)        return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}