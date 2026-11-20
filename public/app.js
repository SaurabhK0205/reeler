// ==============================================================================
// REELER — LINEAR OBSIDIAN VAULT APPLICATION LOGIC
// Dual View (Poster Grid + Responsive Table) & Fullscreen Adaptive Snap Feed
// ==============================================================================

/**
 * Safely reads the stored view mode preference ('grid' | 'list') from localStorage.
 * Normalizes invalid values to 'grid' and handles restricted storage exceptions.
 * @returns {'grid' | 'list'}
 */
function readViewMode() {
  try {
    const v = localStorage.getItem('reeler_view_mode');
    return v === 'list' ? 'list' : 'grid';
  } catch (_) {
    return 'grid';
  }
}

/**
 * Safely writes the view mode preference to localStorage.
 * @param {'grid' | 'list'} mode
 */
function saveViewMode(mode) {
  try {
    localStorage.setItem('reeler_view_mode', mode);
  } catch (_) {
    /* non-fatal */
  }
}

const VAULT_KEY_STORAGE = 'reeler_vault_key';
const VAULT_LAST_ACTIVE_STORAGE = 'reeler_vault_last_active';
const VAULT_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour inactivity threshold

let lastActivityRecordTime = 0;

/**
 * Records user interaction timestamp to enforce 1-hour inactivity auto-logout.
 * Throttled to at most once every 10 seconds to avoid unnecessary localStorage writes.
 */
function recordVaultActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityRecordTime < 10000) {
    return;
  }
  if (checkVaultInactivity(false)) {
    return;
  }
  lastActivityRecordTime = now;
  try {
    if (localStorage.getItem(VAULT_KEY_STORAGE)) {
      localStorage.setItem(VAULT_LAST_ACTIVE_STORAGE, String(now));
    }
  } catch (_) {
    /* non-fatal */
  }
}

/**
 * Checks whether the current vault session has exceeded the 1-hour inactivity limit.
 * If expired, immediately purges stored keys, resets state, and shows the gate screen.
 * @param {boolean} [quiet=false]
 * @returns {boolean} True if session was expired and logged out.
 */
function checkVaultInactivity(quiet = false) {
  try {
    const key = localStorage.getItem(VAULT_KEY_STORAGE);
    if (!key) {
      if (vaultGateScreen && vaultGateScreen.classList.contains('is-hidden')) {
        if (typeof closeReelsFeed === 'function') closeReelsFeed();
        if (typeof resetVaultSessionState === 'function') resetVaultSessionState();
        if (typeof showVaultGateScreen === 'function') showVaultGateScreen(undefined, { preserveWorkspace: false });
      }
      return false;
    }

    const rawLastActive = localStorage.getItem(VAULT_LAST_ACTIVE_STORAGE);
    if (!rawLastActive) {
      localStorage.setItem(VAULT_LAST_ACTIVE_STORAGE, String(Date.now()));
      return false;
    }

    const lastActive = Number(rawLastActive);
    if (Number.isFinite(lastActive) && Date.now() - lastActive > VAULT_INACTIVITY_TIMEOUT_MS) {
      confirmSignOutVault({
        reason: 'inactivity',
        message: 'Your session expired due to 1 hour of inactivity for your privacy. Please sign back in.',
        quiet,
      });
      return true;
    }
  } catch (_) {
    /* non-fatal */
  }
  return false;
}

/**
 * Reads the stored private vault access key from localStorage.
 * Enforces the 1-hour inactivity check so expired keys are rejected immediately.
 * @returns {string}
 */
function getVaultAccessKey() {
  try {
    const key = localStorage.getItem(VAULT_KEY_STORAGE) || '';
    if (!key) return '';
    const rawLastActive = localStorage.getItem(VAULT_LAST_ACTIVE_STORAGE);
    if (rawLastActive) {
      const lastActive = Number(rawLastActive);
      if (Number.isFinite(lastActive) && Date.now() - lastActive > VAULT_INACTIVITY_TIMEOUT_MS) {
        confirmSignOutVault({
          reason: 'inactivity',
          message: 'Your session expired due to 1 hour of inactivity for your privacy. Please sign back in.',
          quiet: false,
        });
        return '';
      }
    }
    return key;
  } catch (_) {
    return '';
  }
}

/**
 * Stores or clears the private vault access key.
 * Synchronizes the last active timestamp when a valid key is set.
 * @param {string | null | undefined} key
 */
function setVaultAccessKey(key) {
  try {
    if (key && key.trim()) {
      localStorage.setItem(VAULT_KEY_STORAGE, key.trim());
      localStorage.setItem(VAULT_LAST_ACTIVE_STORAGE, String(Date.now()));
      syncBrowserTimezone();
    } else {
      localStorage.removeItem(VAULT_KEY_STORAGE);
      localStorage.removeItem(VAULT_LAST_ACTIVE_STORAGE);
    }
  } catch (_) {
    /* non-fatal */
  }
}

/**
 * Generates a unique Idempotency-Key header value for mutating API requests.
 * @returns {string}
 */
function generateIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Automatically syncs the user's browser timezone with their vault profile on the server.
 */
function syncBrowserTimezone() {
  try {
    const key = getVaultAccessKey();
    if (!key) return;
    const clientTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!clientTz) return;
    fetch('/api/user/timezone', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Key': key,
        'Idempotency-Key': generateIdempotencyKey(),
      },
      body: JSON.stringify({ timezone: clientTz }),
    }).catch(() => {});
  } catch (_) {
    /* non-fatal */
  }
}

// Extract and store vault access key from URL query (?key=... or ?vault_key=...)
try {
  const urlParams = new URLSearchParams(window.location.search);
  const keyFromUrl = urlParams.get('key') || urlParams.get('vault_key');
  if (keyFromUrl && keyFromUrl.trim()) {
    setVaultAccessKey(keyFromUrl.trim());
    urlParams.delete('key');
    urlParams.delete('vault_key');
    const remainingQuery = urlParams.toString();
    const cleanUrl = window.location.pathname + (remainingQuery ? `?${remainingQuery}` : '') + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);
  }
} catch (e) {
  console.warn('Failed to parse URL vault key:', e);
}

/**
 * Performs a fetch attaching the private X-Vault-Key header when stored and an Idempotency-Key
 * header automatically for mutating requests (POST, PUT, PATCH, DELETE).
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
function vaultFetch(url, options = {}) {
  const key = getVaultAccessKey();
  const headers = new Headers(options.headers || {});
  if (key) {
    headers.set('X-Vault-Key', key);
    recordVaultActivity(false);
  }
  const method = String(options.method || 'GET').toUpperCase();
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', generateIdempotencyKey());
  }
  return fetch(url, { ...options, headers });
}

const ASPECT_CACHE_STORAGE_KEY = 'reeler_aspect_cache_v1';
const ASPECT_CACHE_MAX_ENTRIES = 300;
const CREATOR_TOP_LIMIT = 6;
const CREATOR_SEARCH_LIMIT = 15;
const INSTAGRAM_HANDLE_REGEX = /^[a-zA-Z0-9._]{1,30}$/;
const PLACEHOLDER_CREATOR_HANDLES = new Set([
  'instagram_user',
  'instagram_creator',
  'instagram creator',
  'instagram reel',
  'instagram',
  'unattributed',
]);

/**
 * Extracts a validated public Instagram handle when present, returning null for placeholders
 * (such as `instagram_user`, `Instagram Creator`, `unattributed`) or malformed handles.
 * @param {string | null | undefined} username
 * @returns {string | null}
 */
function extractPublicCreatorHandle(username) {
  const raw = String(username || '').trim().replace(/^@+/, '');
  if (!raw || PLACEHOLDER_CREATOR_HANDLES.has(raw.toLowerCase())) {
    return null;
  }
  if (
    !INSTAGRAM_HANDLE_REGEX.test(raw) ||
    !/[a-zA-Z0-9]/.test(raw) ||
    raw.includes('..') ||
    raw.startsWith('.') ||
    raw.endsWith('.')
  ) {
    return null;
  }
  return raw;
}

/**
 * Resolves unified display text, initial badge letter, accessible label, and attribution flags
 * for any creator record or missing/placeholder creator metadata.
 * @param {object | null | undefined} creator
 * @returns {{ publicHandle: string | null, displayText: string, accessibleName: string, initial: string, hasPublicHandle: boolean, isAttributedName: boolean }}
 */
function getCreatorDisplayInfo(creator) {
  const publicHandle = extractPublicCreatorHandle(creator?.username);
  if (publicHandle) {
    const label = `@${publicHandle}`;
    return {
      publicHandle,
      displayText: label,
      accessibleName: label,
      initial: (publicHandle.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase(),
      hasPublicHandle: true,
      isAttributedName: true,
    };
  }

  const rawDisplay = stripPrivateUseChars(String(creator?.display_name || ''))
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safeDisplay = rawDisplay && !PLACEHOLDER_CREATOR_HANDLES.has(rawDisplay.toLowerCase())
    ? rawDisplay
    : '';

  if (safeDisplay) {
    return {
      publicHandle: null,
      displayText: safeDisplay,
      accessibleName: safeDisplay,
      initial: (safeDisplay.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase(),
      hasPublicHandle: false,
      isAttributedName: true,
    };
  }

  return {
    publicHandle: null,
    displayText: 'Instagram Creator',
    accessibleName: 'this item',
    initial: 'R',
    hasPublicHandle: false,
    isAttributedName: false,
  };
}

/**
 * Resolves explicit saved media classification ('reel' | 'post') from record field or URL path.
 * @param {object | null | undefined} reel
 * @returns {'reel' | 'post'}
 */
function getSavedMediaType(reel) {
  const explicit = typeof reel?.media_type === 'string' ? reel.media_type.trim().toLowerCase() : '';
  if (explicit === 'post' || explicit === 'reel') {
    return explicit;
  }
  const url = typeof reel?.reel_url === 'string' ? reel.reel_url : '';
  if (/instagram\.com\/(?:[a-zA-Z0-9._]+\/)?p\//i.test(url)) {
    return 'post';
  }
  return 'reel';
}

/**
 * Returns localized singular/plural nouns for the active media type and collection category filters.
 * @param {string} mediaType
 * @param {'all' | 'instagram' | 'bot'} [source='all']
 * @returns {{ singular: string, plural: string, titlePlural: string, scopedPlural: string, scopedUnit: (count: number) => string }}
 */
function getMediaUnitLabels(mediaType, source = 'all') {
  let singular = 'item';
  let plural = 'items';
  let nounTitle = 'Items';
  if (mediaType === 'post') {
    singular = 'post';
    plural = 'posts';
    nounTitle = 'Posts';
  } else if (mediaType === 'reel') {
    singular = 'reel';
    plural = 'reels';
    nounTitle = 'Reels';
  }

  if (source === 'instagram') {
    return {
      singular,
      plural,
      titlePlural: `Saved ${nounTitle}`,
      scopedPlural: `saved ${plural}`,
      scopedUnit: (count) => `saved ${count === 1 ? singular : plural}`,
    };
  }
  if (source === 'bot') {
    return {
      singular,
      plural,
      titlePlural: `Bot-Sent ${nounTitle}`,
      scopedPlural: `bot-sent ${plural}`,
      scopedUnit: (count) => `bot-sent ${count === 1 ? singular : plural}`,
    };
  }
  return {
    singular,
    plural,
    titlePlural: nounTitle,
    scopedPlural: `tracked ${plural}`,
    scopedUnit: (count) => (count === 1 ? singular : plural),
  };
}

/**
 * Loads previously measured embed aspect ratios from localStorage (best effort).
 * @returns {Map<string, { embedRatio: number | null, isClips: boolean | null, thumbAspectRatio: number | null }>}
 */
function loadAspectCache() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(ASPECT_CACHE_STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [code, val] of Object.entries(parsed)) {
        if (val && typeof val.r === 'number' && Number.isFinite(val.r)) {
          map.set(code, {
            embedRatio: val.r,
            isClips: typeof val.c === 'boolean' ? val.c : null,
            thumbAspectRatio: typeof val.tr === 'number' && Number.isFinite(val.tr) ? val.tr : null,
          });
        }
      }
    }
  } catch (_) {
    /* non-fatal */
  }
  return map;
}

/**
 * Persists a measured embed aspect entry into bounded localStorage cache.
 * @param {string} shortcode
 * @param {{ embedRatio: number, isClips: boolean | null, thumbAspectRatio: number | null }} entry
 */
function persistAspectCacheEntry(shortcode, entry) {
  if (!shortcode || !entry || typeof entry.embedRatio !== 'number') return;
  if (state.aspectCache.size >= ASPECT_CACHE_MAX_ENTRIES && !state.aspectCache.has(shortcode)) {
    const oldest = state.aspectCache.keys().next().value;
    if (oldest) state.aspectCache.delete(oldest);
  }
  state.aspectCache.set(shortcode, entry);

  try {
    const obj = {};
    for (const [code, val] of state.aspectCache.entries()) {
      if (typeof val.embedRatio === 'number') {
        obj[code] = { r: val.embedRatio, c: val.isClips, tr: val.thumbAspectRatio };
      }
    }
    localStorage.setItem(ASPECT_CACHE_STORAGE_KEY, JSON.stringify(obj));
  } catch (_) {
    /* non-fatal */
  }
}

const state = {
  filters: {
    source: 'all',
    creatorId: '',
    mediaType: 'all',
    datePreset: 'all',
    watchStatus: 'all',
    sortBy: 'newest_saved',
    search: '',
    page: 1,
    limit: 24,
  },
  initialPageOffset: 0,
  creatorQuery: '',
  viewMode: readViewMode(),
  total: 0,
  reels: [],
  creators: [],
  topCreators: [],
  selectedCreator: null,
  totalCreators: 0,
  creatorMatchTotal: 0,
  stats: null,
  currentFeedReelId: null,
  currentFeedIndex: 0,
  previouslyFocusedElement: null,
  previouslyFocusedReelId: null,
  thumbRatioCache: new Map(),
  metaCache: new Map(),
  aspectCache: loadAspectCache(),
};

let isFeedLoadingMore = false;
let isCatalogLoadingMore = false;
let catalogIntersectionObserver = null;

// DOM References
const topNavEl = document.querySelector('.top-nav');
const vaultContainerEl = document.querySelector('.vault-container');
const srStatusAnnouncer = document.getElementById('sr-status-announcer');
const dbBadge = document.getElementById('db-badge');
const shortcutsHelpBtn = document.getElementById('shortcuts-help-btn');
const shortcutsPopover = document.getElementById('shortcuts-popover');
const shortcutsCloseBtn = document.getElementById('shortcuts-close-btn');
const popoverImportBtn = document.getElementById('popover-import-btn');
const importBtn = document.getElementById('import-btn');
const archiveFileInput = document.getElementById('archive-file-input');
const statsBar = document.querySelector('.stats-bar');
const metricFilterAll = document.getElementById('metric-filter-all');
const metricFilterWeek = document.getElementById('metric-filter-week');
const metricFilterLater = document.getElementById('metric-filter-later');
const metricFilterWatched = document.getElementById('metric-filter-watched');
const statTotal = document.getElementById('stat-total');
const statMediaSplit = document.getElementById('stat-media-split');
const statCreators = document.getElementById('stat-creators');
const statWeek = document.getElementById('stat-week');
const statWatchLater = document.getElementById('stat-watch-later');
const statWatched = document.getElementById('stat-watched');
const sourceTabsButtons = Array.from(document.querySelectorAll('.source-tab-btn'));
const sourceCountAll = document.getElementById('source-count-all');
const sourceCountInstagram = document.getElementById('source-count-instagram');
const sourceCountBot = document.getElementById('source-count-bot');
const collectionSourceHint = document.getElementById('collection-source-hint');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const mediaTypeButtons = Array.from(document.querySelectorAll('.media-type-btn'));
const datePresetSelect = document.getElementById('date-preset');
const watchFilterSelect = document.getElementById('watch-filter');
const sortBySelect = document.getElementById('sort-by');
const creatorsStripContainer = document.getElementById('creators-strip-container');
const creatorsMobileToggle = document.getElementById('creators-mobile-toggle');
const creatorFilterInput = document.getElementById('creator-filter-input');
const clearCreatorFilterBtn = document.getElementById('clear-creator-filter');
const creatorStripMeta = document.getElementById('creator-strip-meta');
const creatorPillsList = document.getElementById('creator-pills-list');
const resetCreatorBtn = document.getElementById('reset-creator-btn');
const reelsGrid = document.getElementById('reels-grid');
const reelsTableContainer = document.getElementById('reels-table-container');
const reelsTable = document.getElementById('reels-table');
const reelsTableBody = document.getElementById('reels-table-body');
const vaultGateScreen = document.getElementById('vault-gate-screen');
const vaultGateTitle = document.getElementById('vault-gate-title');
const vaultGateDesc = document.getElementById('vault-gate-desc');
const tabOtpBtn = document.getElementById('tab-otp-btn');
const tabKeyBtn = document.getElementById('tab-key-btn');
const vaultOtpPanel = document.getElementById('vault-otp-panel');
const vaultKeyPanel = document.getElementById('vault-key-panel');
const vaultOtpForm = document.getElementById('vault-otp-form');
const vaultOtpInput = document.getElementById('vault-otp-input');
const vaultOtpSubmitBtn = document.getElementById('vault-otp-submit-btn');
const vaultKeyForm = document.getElementById('vault-key-form');
const vaultKeyInput = document.getElementById('vault-key-input');
const vaultKeySubmitBtn = document.getElementById('vault-key-submit-btn');
const vaultGateError = document.getElementById('vault-gate-error');
const vaultGateSwitchActions = document.getElementById('vault-gate-switch-actions');
const vaultGateCancelBtn = document.getElementById('vault-gate-cancel-btn');
const vaultGateSignoutBtn = document.getElementById('vault-gate-signout-btn');
const switchVaultBtn = document.getElementById('switch-vault-btn');

const DEFAULT_VAULT_GATE_TITLE = 'Private Vault';
const DEFAULT_VAULT_GATE_DESC = "You scroll through 1,000 reels a day. Make sure you don't miss an important one.";
const SWITCH_VAULT_GATE_TITLE = 'Switch Vault';
const SWITCH_VAULT_GATE_DESC = 'Sign in to another Instagram account with a fresh single-use 6-digit code or direct key. Your current vault stays active if you cancel.';

let isSwitchingVault = false;
let vaultAuthGeneration = 0;
let vaultSessionGeneration = 0;
let vaultAuthAbortController = null;
let pendingOtpAttempt = { code: '', key: '' };

/**
 * Returns the Idempotency-Key bound to the current 6-digit OTP submission attempt so network-error
 * retries for the same code reuse the original key and replay a consumed OTP's response safely.
 * @param {string} code
 * @returns {string}
 */
function getOtpAttemptIdempotencyKey(code) {
  if (pendingOtpAttempt.code === code && pendingOtpAttempt.key) {
    return pendingOtpAttempt.key;
  }
  const key = generateIdempotencyKey();
  pendingOtpAttempt = { code, key };
  return key;
}

/**
 * Clears any cached OTP attempt key when the code changes, completes, or the flow resets.
 */
function clearPendingOtpAttempt() {
  pendingOtpAttempt = { code: '', key: '' };
}

/**
 * Invalidates and aborts any in-flight vault authentication request so late completions from
 * canceled or signed-out attempts can never overwrite the active vault key or workspace.
 */
function invalidatePendingVaultAuth() {
  vaultAuthGeneration++;
  if (vaultAuthAbortController) {
    vaultAuthAbortController.abort();
    vaultAuthAbortController = null;
  }
  if (vaultOtpSubmitBtn) {
    vaultOtpSubmitBtn.disabled = false;
    vaultOtpSubmitBtn.textContent = 'Unlock Vault';
  }
  if (vaultKeySubmitBtn) {
    vaultKeySubmitBtn.disabled = false;
    vaultKeySubmitBtn.textContent = 'Unlock Vault';
  }
}

vaultOtpInput?.addEventListener('input', () => {
  const normalized = (vaultOtpInput.value || '').trim().replace(/\s+/g, '');
  if (pendingOtpAttempt.code && normalized !== pendingOtpAttempt.code) {
    clearPendingOtpAttempt();
  }
});

/**
 * Keeps the header Switch Vault button visible only while an active vault session is unlocked.
 */
function syncSwitchVaultButtonVisibility() {
  if (!switchVaultBtn) return;
  const gateOpen = Boolean(vaultGateScreen && !vaultGateScreen.classList.contains('is-hidden'));
  switchVaultBtn.hidden = gateOpen || !getVaultAccessKey();
}

/**
 * Updates Vault Gate heading, helper copy, and cancel/sign-out controls for locked vs switch mode.
 */
function syncVaultGateModeUI() {
  const switchActive = isSwitchingVault && Boolean(getVaultAccessKey());
  if (!switchActive) {
    isSwitchingVault = false;
  }
  if (vaultGateTitle) {
    vaultGateTitle.textContent = switchActive ? SWITCH_VAULT_GATE_TITLE : DEFAULT_VAULT_GATE_TITLE;
  }
  if (vaultGateDesc) {
    vaultGateDesc.textContent = switchActive ? SWITCH_VAULT_GATE_DESC : DEFAULT_VAULT_GATE_DESC;
  }
  if (vaultGateSwitchActions) {
    vaultGateSwitchActions.hidden = !switchActive;
  }
}

/**
 * Switches between 6-digit OTP code and direct access key tab in vault gate.
 * @param {'otp' | 'key'} tab
 */
function switchVaultGateTab(tab) {
  if (tab === 'otp') {
    tabOtpBtn?.classList.add('active');
    tabOtpBtn?.setAttribute('aria-selected', 'true');
    tabKeyBtn?.classList.remove('active');
    tabKeyBtn?.setAttribute('aria-selected', 'false');
    vaultOtpPanel?.classList.remove('is-hidden');
    vaultKeyPanel?.classList.add('is-hidden');
    vaultOtpInput?.focus();
  } else {
    tabKeyBtn?.classList.add('active');
    tabKeyBtn?.setAttribute('aria-selected', 'true');
    tabOtpBtn?.classList.remove('active');
    tabOtpBtn?.setAttribute('aria-selected', 'false');
    vaultKeyPanel?.classList.remove('is-hidden');
    vaultOtpPanel?.classList.add('is-hidden');
    vaultKeyInput?.focus();
  }
}

tabOtpBtn?.addEventListener('click', () => switchVaultGateTab('otp'));
tabKeyBtn?.addEventListener('click', () => switchVaultGateTab('key'));

/**
 * Shows the Zero-Login Vault Auth Gate when unauthenticated or switching accounts.
 * In switch mode, the active vault's DOM/state is preserved so the user can return immediately.
 * @param {string} [errorMessage]
 * @param {{ preserveWorkspace?: boolean }} [options]
 */
function showVaultGateScreen(errorMessage, options = {}) {
  if (!vaultGateScreen) return;
  const preserveWorkspace = Boolean(options.preserveWorkspace ?? (isSwitchingVault && Boolean(getVaultAccessKey())));
  if (!preserveWorkspace) {
    isSwitchingVault = false;
  }
  if (vaultContainerEl) vaultContainerEl.classList.add('is-vault-locked');
  vaultGateScreen.classList.remove('is-hidden');
  syncVaultGateModeUI();

  if (!preserveWorkspace) {
    if (resultsCount) resultsCount.textContent = 'Private Vault Locked';
    if (reelsGrid) reelsGrid.innerHTML = '';
    if (reelsTableBody) reelsTableBody.innerHTML = '';
    if (reelsTableContainer) reelsTableContainer.classList.add('is-hidden');
    if (paginationBar) paginationBar.classList.add('is-hidden');
  }
  if (vaultGateError) {
    if (errorMessage) {
      vaultGateError.textContent = errorMessage;
      vaultGateError.hidden = false;
    } else {
      vaultGateError.hidden = true;
    }
  }
  syncSwitchVaultButtonVisibility();
}

/**
 * Hides the Zero-Login Vault Auth Gate when authenticated.
 */
function hideVaultGateScreen() {
  if (!vaultGateScreen) return;
  isSwitchingVault = false;
  syncVaultGateModeUI();
  if (vaultContainerEl) vaultContainerEl.classList.remove('is-vault-locked');
  vaultGateScreen.classList.add('is-hidden');
  if (reelsGrid) reelsGrid.classList.toggle('is-hidden', state.viewMode !== 'grid');
  if (reelsTableContainer) reelsTableContainer.classList.toggle('is-hidden', state.viewMode === 'grid');
  if (vaultGateError) vaultGateError.hidden = true;
  syncSwitchVaultButtonVisibility();
}

/**
 * Aborts in-flight vault requests and clears displayed vault data & filters before switching
 * to another account or signing out cleanly.
 */
function resetVaultSessionState() {
  resetGridThumbnailHydration();
  gridThumbUnavailableShortcodes.clear();
  gridThumbRefreshedExpired.clear();
  gridThumbReplacedUrls.clear();
  metaNoThumbExpiry.clear();
  if (fetchReelsAbortController) {
    fetchReelsAbortController.abort();
    fetchReelsAbortController = null;
  }
  if (creatorsFetchController) {
    creatorsFetchController.abort();
    creatorsFetchController = null;
  }
  if (statsFetchController) {
    statsFetchController.abort();
    statsFetchController = null;
  }
  if (typeof state !== 'undefined' && state) {
    state.initialPageOffset = 0;
    state.reels = [];
    state.total = 0;
    state.stats = null;
    state.creators = [];
    state.topCreators = [];
    state.totalCreators = 0;
    state.creatorMatchTotal = 0;
    state.selectedCreator = null;
    state.creatorQuery = '';
    if (state.filters) {
      state.filters.creatorId = '';
      state.filters.page = 1;
    }
  }
  isFeedLoadingMore = false;
  isCatalogLoadingMore = false;
  const catalogSpinner = document.getElementById('catalog-scroll-spinner');
  if (catalogSpinner) catalogSpinner.hidden = true;
  if (creatorFilterInput) creatorFilterInput.value = '';
  if (typeof syncUrlState === 'function') {
    syncUrlState();
  }
  if (statTotal) statTotal.textContent = '--';
  if (statMediaSplit) statMediaSplit.textContent = '';
  if (statCreators) statCreators.textContent = '--';
  if (statWeek) statWeek.textContent = '--';
  if (statWatchLater) statWatchLater.textContent = '--';
  if (statWatched) statWatched.textContent = '--';
  if (sourceCountAll) sourceCountAll.textContent = '--';
  if (sourceCountInstagram) sourceCountInstagram.textContent = '--';
  if (sourceCountBot) sourceCountBot.textContent = '--';
  if (creatorPillsList) creatorPillsList.innerHTML = '';
  if (reelsGrid) reelsGrid.innerHTML = '';
  if (reelsTableBody) reelsTableBody.innerHTML = '';
  if (reelsTableState) {
    reelsTableState.hidden = true;
    reelsTableState.innerHTML = '';
  }
  if (paginationBar) paginationBar.classList.add('is-hidden');
  if (resultsCount) resultsCount.textContent = 'Loading tracked items...';
}

/**
 * Opens the Vault Gate in non-destructive switch mode so the user can sign in to another vault
 * or cancel right back to their active session without getting locked out.
 */
function handleSwitchVault() {
  invalidatePendingVaultAuth();
  clearPendingOtpAttempt();
  closeShortcutsPopover(false);
  if (vaultOtpInput) vaultOtpInput.value = '';
  if (vaultKeyInput) vaultKeyInput.value = '';

  if (!getVaultAccessKey()) {
    resetVaultSessionState();
    showVaultGateScreen();
    switchVaultGateTab('otp');
    return;
  }

  isSwitchingVault = true;
  showVaultGateScreen(undefined, { preserveWorkspace: true });
  switchVaultGateTab('otp');
  if (typeof announceStatus === 'function') {
    announceStatus('Switch Vault opened. Enter a fresh 6-digit code or direct key, or choose Back to Current Vault.');
  }
}

/**
 * Cancels Switch Vault and immediately returns to the already-authenticated vault.
 */
function cancelSwitchVault() {
  if (!isSwitchingVault || !getVaultAccessKey()) return;
  invalidatePendingVaultAuth();
  clearPendingOtpAttempt();
  hideVaultGateScreen();
  switchVaultBtn?.focus();
  if (typeof announceStatus === 'function') {
    announceStatus('Returned to your current vault.');
  }
}

/**
 * Explicitly signs out of the current device, clears the stored vault key, and resets vault state.
 */
function confirmSignOutVault() {
  const options = arguments[0] || {};
  if (typeof closeReelsFeed === 'function') {
    closeReelsFeed();
  }
  invalidatePendingVaultAuth();
  clearPendingOtpAttempt();
  vaultSessionGeneration++;
  isSwitchingVault = false;
  setVaultAccessKey(null);
  closeShortcutsPopover(false);
  resetVaultSessionState();
  if (vaultOtpInput) vaultOtpInput.value = '';
  if (vaultKeyInput) vaultKeyInput.value = '';
  showVaultGateScreen(undefined, { preserveWorkspace: false });
  switchVaultGateTab('otp');
  const message = options.message || 'Signed out of this device. Enter a fresh 6-digit code or vault key to sign back in.';
  if (typeof announceStatus === 'function') {
    announceStatus(message);
  }
  if (options.reason === 'inactivity' && !options.quiet) {
    showToast(message, 'info');
  }
}

/**
 * Commits a newly authenticated vault key and starts all catalog loads immediately under a
 * session generation independent of later Switch Vault open/cancel actions.
 * @param {string} newVaultKey
 */
async function commitAuthenticatedVaultKey(newVaultKey) {
  clearPendingOtpAttempt();
  const sessionGen = ++vaultSessionGeneration;
  if (isSwitchingVault) {
    resetVaultSessionState();
  }
  setVaultAccessKey(newVaultKey);
  hideVaultGateScreen();
  syncBrowserTimezone();
  await Promise.all([loadStats(), loadCreators(), fetchReels()]);
  if (sessionGen !== vaultSessionGeneration) return;
}

switchVaultBtn?.addEventListener('click', handleSwitchVault);
vaultGateCancelBtn?.addEventListener('click', cancelSwitchVault);
vaultGateSignoutBtn?.addEventListener('click', confirmSignOutVault);
syncSwitchVaultButtonVisibility();

if (vaultOtpForm) {
  vaultOtpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = (vaultOtpInput?.value || '').trim().replace(/\s+/g, '');
    if (!entered || !/^\d{6}$/.test(entered)) {
      showVaultGateScreen('Please enter the 6-digit code received from your Instagram DM.');
      return;
    }

    invalidatePendingVaultAuth();
    const opGen = vaultAuthGeneration;
    const controller = new AbortController();
    vaultAuthAbortController = controller;
    const idempotencyKey = getOtpAttemptIdempotencyKey(entered);

    if (vaultOtpSubmitBtn) {
      vaultOtpSubmitBtn.disabled = true;
      vaultOtpSubmitBtn.textContent = 'Verifying...';
    }
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ code: entered }),
      });
      if (opGen !== vaultAuthGeneration) return;
      const data = await res.json().catch(() => null);
      if (opGen !== vaultAuthGeneration) return;

      if (res.ok && data?.vaultKey) {
        await commitAuthenticatedVaultKey(data.vaultKey);
      } else {
        // Keep the attempt key on transient 5xx/409/429 responses so retries replay cleanly;
        // clear it on terminal 400/422 rejections so the next submission starts fresh.
        if (res.status === 400 || res.status === 422) {
          clearPendingOtpAttempt();
        }
        showVaultGateScreen(
          data?.message || 'This 6-digit code is invalid, expired, or already used (codes are single-use). Send "code" to @er_reel_er for a fresh code.'
        );
      }
    } catch (err) {
      if (opGen !== vaultAuthGeneration || err?.name === 'AbortError') return;
      // Preserve pendingOtpAttempt on network errors so resubmitting the same OTP reuses the original key
      showVaultGateScreen('Unable to verify code. Please check your connection and try again.');
    } finally {
      if (opGen === vaultAuthGeneration) {
        if (vaultAuthAbortController === controller) {
          vaultAuthAbortController = null;
        }
        if (vaultOtpSubmitBtn) {
          vaultOtpSubmitBtn.disabled = false;
          vaultOtpSubmitBtn.textContent = 'Unlock Vault';
        }
      }
    }
  });
}

if (vaultKeyForm) {
  vaultKeyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = (vaultKeyInput?.value || '').trim();
    if (!entered) {
      showVaultGateScreen('Please enter your vault access key.');
      return;
    }

    invalidatePendingVaultAuth();
    const opGen = vaultAuthGeneration;
    const controller = new AbortController();
    vaultAuthAbortController = controller;

    if (vaultKeySubmitBtn) {
      vaultKeySubmitBtn.disabled = true;
      vaultKeySubmitBtn.textContent = 'Verifying...';
    }
    try {
      const res = await fetch('/api/session', {
        signal: controller.signal,
        headers: { 'X-Vault-Key': entered },
      });
      if (opGen !== vaultAuthGeneration) return;

      if (res.ok) {
        await commitAuthenticatedVaultKey(entered);
      } else {
        showVaultGateScreen('Invalid access key. Please check the link from your Instagram DM.');
      }
    } catch (err) {
      if (opGen !== vaultAuthGeneration || err?.name === 'AbortError') return;
      showVaultGateScreen('Unable to verify key. Please try again.');
    } finally {
      if (opGen === vaultAuthGeneration) {
        if (vaultAuthAbortController === controller) {
          vaultAuthAbortController = null;
        }
        if (vaultKeySubmitBtn) {
          vaultKeySubmitBtn.disabled = false;
          vaultKeySubmitBtn.textContent = 'Unlock Vault';
        }
      }
    }
  });
}
const reelsTableState = document.getElementById('reels-table-state');
const resultsCount = document.getElementById('results-count');
const activeFilterChips = document.getElementById('active-filter-chips');
const paginationBar = document.getElementById('pagination-bar');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const pageJumpForm = document.getElementById('page-jump-form');
const pageJumpInput = document.getElementById('page-jump-input');
const pageIndicator = document.getElementById('page-indicator');
const pageJumpGoBtn = document.getElementById('page-jump-go-btn');
const viewModeGridBtn = document.getElementById('view-mode-grid');
const viewModeListBtn = document.getElementById('view-mode-list');

// Fullscreen Reels Snap-Feed References
const feedModal = document.getElementById('reels-feed-modal');
const feedScrollTrack = document.getElementById('feed-scroll-track');
const feedCounterKicker = document.getElementById('feed-counter-kicker');
const feedArrowUp = document.getElementById('feed-arrow-up');
const feedArrowDown = document.getElementById('feed-arrow-down');
const feedCloseBtn = document.getElementById('feed-close-btn');

let fetchReelsAbortController = null;
let creatorsFetchController = null;
let statsFetchController = null;
let searchTimeout = null;
let creatorSearchTimeout = null;
let isCreatorSearching = false;
let statsLoadErrorNotified = false;
let creatorsLoadErrorNotified = false;
let hasInitialReelsSettled = false;
const pendingStatusIds = new Set();
const pendingStatusValues = new Map();

// --- Initialization & URL State Sync ---

/**
 * Restores initial view mode and active filters from URL query parameters on page load.
 * @returns {{ hasUrlView: boolean }}
 */
function restoreFiltersFromUrl() {
  let hasUrlView = false;
  try {
    const params = new URLSearchParams(window.location.search);
    const validSources = new Set(['all', 'instagram', 'bot']);
    const validMediaTypes = new Set(['all', 'reel', 'post']);
    const validDates = new Set(['all', 'today', 'yesterday', '7d', '30d', '3m', '6m', 'year']);
    const validStatuses = new Set(['all', 'unwatched', 'watch_later', 'watched']);
    const validSorts = new Set(['newest_saved', 'oldest_saved', 'newest_published', 'oldest_published']);

    const view = params.get('view');
    if (view === 'list' || view === 'grid') {
      state.viewMode = view;
      hasUrlView = true;
    }

    const source = params.get('source');
    if (source && validSources.has(source)) state.filters.source = source;

    const creator = params.get('creator');
    if (creator) state.filters.creatorId = creator;

    const type = params.get('type');
    if (type && validMediaTypes.has(type)) state.filters.mediaType = type;

    const date = params.get('date');
    if (date && validDates.has(date)) state.filters.datePreset = date;

    const status = params.get('status');
    if (status && validStatuses.has(status)) state.filters.watchStatus = status;

    const sort = params.get('sort');
    if (sort && validSorts.has(sort)) state.filters.sortBy = sort;

    const q = params.get('q');
    if (q) state.filters.search = q;

    const pageNum = parseInt(params.get('page') || '1', 10);
    if (Number.isFinite(pageNum) && pageNum >= 1) {
      state.filters.page = pageNum;
    }
  } catch (_) {
    /* non-fatal */
  }

  searchInput.value = state.filters.search;
  clearSearchBtn.hidden = !state.filters.search;
  datePresetSelect.value = state.filters.datePreset;
  watchFilterSelect.value = state.filters.watchStatus;
  sortBySelect.value = state.filters.sortBy;
  syncSourceTabsUi();
  syncMediaTypeToggleUi();
  syncKpiActiveStates();
  setCreatorsExpanded(false);
  return { hasUrlView };
}

/**
 * Persists active filters, pagination, and view mode into the browser URL without adding history entries.
 */
function syncUrlState() {
  try {
    const params = new URLSearchParams();
    if (state.filters.source !== 'all') params.set('source', state.filters.source);
    if (state.filters.creatorId) params.set('creator', state.filters.creatorId);
    if (state.filters.mediaType !== 'all') params.set('type', state.filters.mediaType);
    if (state.filters.datePreset !== 'all') params.set('date', state.filters.datePreset);
    if (state.filters.watchStatus !== 'all') params.set('status', state.filters.watchStatus);
    if (state.filters.sortBy !== 'newest_saved') params.set('sort', state.filters.sortBy);
    if (state.filters.search.trim()) params.set('q', state.filters.search.trim());
    if (state.filters.page > 1) params.set('page', String(state.filters.page));
    if (state.viewMode === 'list' || readViewMode() !== state.viewMode) {
      params.set('view', state.viewMode);
    }

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || ''}`;
    history.replaceState(null, '', nextUrl);
  } catch (_) {
    /* non-fatal */
  }
}

/**
 * Returns true if any catalog filter (excluding collection category when `includeSource` is false) is active.
 * @param {boolean} [includeSource=true]
 * @returns {boolean}
 */
function hasActiveFilters(includeSource = true) {
  return Boolean(
    (includeSource && state.filters.source !== 'all') ||
    state.filters.creatorId ||
    state.filters.mediaType !== 'all' ||
    state.filters.datePreset !== 'all' ||
    state.filters.watchStatus !== 'all' ||
    state.filters.search.trim()
  );
}

/**
 * Synchronizes active highlight, pressed state, and contextual sync explanation across the Collection Category tabs.
 */
function syncSourceTabsUi() {
  const current = state.filters.source || 'all';
  sourceTabsButtons.forEach((btn) => {
    const value = btn.dataset.source || 'all';
    const isActive = value === current;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  if (collectionSourceHint) {
    if (current === 'instagram') {
      collectionSourceHint.textContent = 'Instagram Saved archive: re-import saved_posts.json to sync newly saved posts.';
    } else if (current === 'bot') {
      collectionSourceHint.textContent = 'DMed to Reeler Bot only: not added to your Instagram Saved collection.';
    } else {
      collectionSourceHint.textContent = 'Instagram Saved (re-import saved_posts.json to sync) & items DMed to Reeler Bot.';
    }
  }
}

/**
 * Synchronizes active highlight and pressed states across the Content Type segmented toggle.
 */
function syncMediaTypeToggleUi() {
  const current = state.filters.mediaType || 'all';
  mediaTypeButtons.forEach((btn) => {
    const value = btn.dataset.mediaType || 'all';
    const isActive = value === current;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

/**
 * Synchronizes active highlight and pressed states across the KPI quick-filter strip and filter dropdowns.
 */
function syncKpiActiveStates() {
  const noFilters = !hasActiveFilters();
  const isWeekActive = state.filters.datePreset === '7d';
  const isLaterActive = state.filters.watchStatus === 'watch_later';
  const isWatchedActive = state.filters.watchStatus === 'watched';

  if (metricFilterAll) {
    metricFilterAll.classList.toggle('is-filter-active', noFilters);
    metricFilterAll.setAttribute('aria-pressed', String(noFilters));
  }
  if (metricFilterWeek) {
    metricFilterWeek.classList.toggle('is-filter-active', isWeekActive);
    metricFilterWeek.setAttribute('aria-pressed', String(isWeekActive));
  }
  if (metricFilterLater) {
    metricFilterLater.classList.toggle('is-filter-active', isLaterActive);
    metricFilterLater.setAttribute('aria-pressed', String(isLaterActive));
  }
  if (metricFilterWatched) {
    metricFilterWatched.classList.toggle('is-filter-active', isWatchedActive);
    metricFilterWatched.setAttribute('aria-pressed', String(isWatchedActive));
  }
}

/**
 * Updates mobile collapsible creator strip expansion state and toggle button label.
 * @param {boolean} expanded
 */
function setCreatorsExpanded(expanded) {
  if (!creatorsStripContainer) return;
  creatorsStripContainer.classList.toggle('is-expanded', expanded);
  if (creatorsMobileToggle) {
    creatorsMobileToggle.setAttribute('aria-expanded', String(expanded));
    const labelEl = creatorsMobileToggle.querySelector('.creators-mobile-toggle-label');
    if (labelEl) {
      if (expanded) {
        labelEl.textContent = 'Hide';
      } else if (state.filters.creatorId) {
        const selected = findCreatorById(state.filters.creatorId);
        labelEl.textContent = selected ? getCreatorDisplayInfo(selected).displayText : 'Filtered';
      } else {
        labelEl.textContent = 'Browse';
      }
    }
  }
}

const CHIP_REMOVE_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

/**
 * Formats an active date preset into concise chip text matching filter select labels.
 * @param {string} preset
 * @returns {string}
 */
function formatDateChipLabel(preset) {
  switch (preset) {
    case 'today': return 'Date: Today';
    case 'yesterday': return 'Date: Yesterday';
    case '7d': return 'Date: 7 Days';
    case '30d': return 'Date: 30 Days';
    case '3m': return 'Date: 3 Months';
    case '6m': return 'Date: 6 Months';
    case 'year': return 'Date: This Year';
    default: return '';
  }
}

/**
 * Resolves a creator object by ID across active list, cached top creators, selected creator, or loaded reels.
 * @param {string} id
 * @returns {object | null}
 */
function findCreatorById(id) {
  if (!id) return null;
  if (state.selectedCreator?.id === id) return state.selectedCreator;
  return state.creators.find((c) => c.id === id)
    || state.topCreators.find((c) => c.id === id)
    || state.reels.find((r) => r.creator?.id === id)?.creator
    || null;
}

/**
 * Resolves the display handle for an active creator filter ID.
 * @returns {string}
 */
function resolveActiveCreatorLabel() {
  if (!state.filters.creatorId) return '';
  const match = findCreatorById(state.filters.creatorId);
  return match ? getCreatorDisplayInfo(match).displayText : 'Selected';
}

/**
 * Clears one active filter dimension while preserving remaining filters and focus continuity.
 * @param {'source' | 'creator' | 'mediaType' | 'date' | 'status' | 'search'} key
 * @param {boolean} [fromKeyboard=false]
 */
function removeSingleFilter(key, fromKeyboard = false) {
  let message = 'Filter removed.';
  if (key === 'source') {
    state.filters.source = 'all';
    syncSourceTabsUi();
    message = 'Cleared collection category filter.';
  } else if (key === 'creator') {
    state.filters.creatorId = '';
    state.selectedCreator = null;
    renderCreatorStrip();
    message = 'Cleared creator filter.';
  } else if (key === 'mediaType') {
    state.filters.mediaType = 'all';
    syncMediaTypeToggleUi();
    message = 'Cleared content type filter.';
  } else if (key === 'date') {
    state.filters.datePreset = 'all';
    datePresetSelect.value = 'all';
    message = 'Cleared date filter.';
  } else if (key === 'status') {
    state.filters.watchStatus = 'all';
    watchFilterSelect.value = 'all';
    message = 'Cleared status filter.';
  } else if (key === 'search') {
    clearTimeout(searchTimeout);
    state.filters.search = '';
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    message = 'Cleared search filter.';
  }

  state.filters.page = 1;
  syncKpiActiveStates();
  syncUrlState();
  renderActiveFilterChips();
  announceStatus(message);
  fetchReels();

  if (fromKeyboard && activeFilterChips) {
    const nextChip = activeFilterChips.querySelector('.active-filter-chip, .active-filter-clear');
    if (nextChip) {
      nextChip.focus({ preventScroll: true });
    } else {
      searchInput?.focus({ preventScroll: true });
    }
  }
}

/**
 * Renders removable active filter summary chips alongside the results counter.
 */
function renderActiveFilterChips() {
  if (!activeFilterChips) return;
  activeFilterChips.innerHTML = '';
  const items = [];

  if (state.filters.source !== 'all') {
    const sourceLabel = state.filters.source === 'bot' ? 'Sent to Bot' : 'Saved on IG';
    items.push({
      key: 'source',
      label: `Category: ${sourceLabel}`,
      ariaLabel: `Remove collection category filter ${sourceLabel}`,
      title: `Remove collection category filter ${sourceLabel}`,
    });
  }
  if (state.filters.creatorId) {
    const handle = resolveActiveCreatorLabel();
    items.push({
      key: 'creator',
      label: `Creator: ${handle}`,
      ariaLabel: `Remove creator filter ${handle}`,
      title: `Remove creator filter ${handle}`,
    });
  }
  if (state.filters.mediaType !== 'all') {
    const typeLabel = state.filters.mediaType === 'post' ? 'Posts' : 'Reels';
    items.push({
      key: 'mediaType',
      label: `Type: ${typeLabel}`,
      ariaLabel: `Remove content type filter ${typeLabel}`,
      title: `Remove content type filter ${typeLabel}`,
    });
  }
  if (state.filters.datePreset !== 'all') {
    const dateLabel = formatDateChipLabel(state.filters.datePreset);
    if (dateLabel) {
      items.push({
        key: 'date',
        label: dateLabel,
        ariaLabel: `Remove ${dateLabel} filter`,
        title: `Remove ${dateLabel} filter`,
      });
    }
  }
  if (state.filters.watchStatus !== 'all') {
    const statusLabel = formatStatusLabel(state.filters.watchStatus);
    items.push({
      key: 'status',
      label: `Status: ${statusLabel}`,
      ariaLabel: `Remove status filter ${statusLabel}`,
      title: `Remove status filter ${statusLabel}`,
    });
  }
  const trimmedSearch = state.filters.search.trim();
  if (trimmedSearch) {
    const clipped = trimmedSearch.length > 24 ? `${trimmedSearch.slice(0, 23)}…` : trimmedSearch;
    items.push({
      key: 'search',
      label: `Search: "${clipped}"`,
      ariaLabel: `Remove search filter "${trimmedSearch}"`,
      title: `Remove search "${trimmedSearch}"`,
    });
  }

  if (items.length === 0) {
    activeFilterChips.hidden = true;
    return;
  }

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'active-filter-chip';
    btn.dataset.filterKey = item.key;
    btn.setAttribute('aria-label', item.ariaLabel);
    btn.title = item.title;
    btn.innerHTML = `<span class="chip-label">${escapeHtml(item.label)}</span>${CHIP_REMOVE_SVG}`;
    btn.addEventListener('click', (e) => removeSingleFilter(item.key, e.detail === 0));
    activeFilterChips.appendChild(btn);
  });

  if (items.length >= 2) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'active-filter-clear';
    clearBtn.setAttribute('aria-label', 'Clear all active filters');
    clearBtn.textContent = 'Clear all';
    clearBtn.addEventListener('click', (e) => {
      const isKeyboard = e.detail === 0;
      clearAllFilters();
      announceStatus('Cleared all active filters.');
      if (isKeyboard) searchInput?.focus({ preventScroll: true });
    });
    activeFilterChips.appendChild(clearBtn);
  }

  activeFilterChips.hidden = false;
}

/**
 * Resets all active collection, search, creator, date, and watch-status filters to defaults and reloads page 1.
 */
function clearAllFilters() {
  clearTimeout(searchTimeout);
  clearTimeout(creatorSearchTimeout);
  if (creatorsFetchController) {
    creatorsFetchController.abort();
    creatorsFetchController = null;
  }
  isCreatorSearching = false;
  state.filters.source = 'all';
  state.filters.creatorId = '';
  state.filters.mediaType = 'all';
  state.filters.datePreset = 'all';
  state.filters.watchStatus = 'all';
  state.filters.search = '';
  state.filters.page = 1;
  state.creatorQuery = '';
  state.selectedCreator = null;
  if (state.topCreators.length > 0) {
    state.creators = state.topCreators;
    state.creatorMatchTotal = state.totalCreators;
  }

  searchInput.value = '';
  clearSearchBtn.hidden = true;
  datePresetSelect.value = 'all';
  watchFilterSelect.value = 'all';
  if (creatorFilterInput) creatorFilterInput.value = '';
  if (clearCreatorFilterBtn) clearCreatorFilterBtn.hidden = true;

  syncSourceTabsUi();
  syncMediaTypeToggleUi();
  syncKpiActiveStates();
  syncUrlState();
  renderCreatorStrip();
  renderActiveFilterChips();
  fetchReels();
  if (state.topCreators.length === 0) {
    loadCreators('');
  }
}

/**
 * Announces transient status updates cleanly via a visually hidden polite live region.
 * @param {string} message
 */
function announceStatus(message) {
  if (!srStatusAnnouncer || !message) return;
  srStatusAnnouncer.textContent = '';
  requestAnimationFrame(() => {
    if (srStatusAnnouncer) srStatusAnnouncer.textContent = message;
  });
}

/**
 * Renders structural skeleton placeholders immediately on initial load for both Grid and List views
 * so cold fetches avoid blank voids across remote Supabase latency.
 */
function renderInitialSkeletons() {
  if (hasInitialReelsSettled) return;

  if (state.viewMode === 'grid') {
    if (!reelsGrid || reelsGrid.children.length > 0) return;
    const count = window.innerWidth <= 600 ? 4 : 8;
    reelsGrid.innerHTML = Array.from({ length: count }, () => `
      <div class="vault-skeleton-card" aria-hidden="true">
        <div class="skeleton-poster"></div>
        <div class="skeleton-details">
          <div class="skeleton-line skeleton-line-short"></div>
          <div class="skeleton-line skeleton-line-long"></div>
        </div>
      </div>
    `).join('');
    return;
  }

  if (reelsTableBody && reelsTableBody.children.length === 0) {
    if (reelsTable) reelsTable.hidden = false;
    if (reelsTableContainer) reelsTableContainer.classList.remove('is-empty-state');
    if (reelsTableState) reelsTableState.hidden = true;
    const rowCount = window.innerWidth <= 680 ? 4 : 6;
    reelsTableBody.innerHTML = Array.from({ length: rowCount }, () => `
      <tr class="table-row table-skeleton-row" aria-hidden="true">
        <td class="table-rank"><div class="skeleton-bar skeleton-bar-xs"></div></td>
        <td class="table-creator-td">
          <div class="table-creator-cell">
            <div class="skeleton-avatar"></div>
            <div class="skeleton-bar skeleton-bar-sm"></div>
          </div>
        </td>
        <td class="table-caption-cell"><div class="skeleton-bar skeleton-bar-lg"></div></td>
        <td class="table-date-cell"><div class="skeleton-bar skeleton-bar-sm"></div></td>
        <td class="table-status-td"><div class="skeleton-bar skeleton-bar-pill"></div></td>
        <td class="table-actions-td">
          <div class="table-actions-cell">
            <div class="skeleton-btn"></div>
            <div class="skeleton-btn"></div>
            <div class="skeleton-btn"></div>
          </div>
        </td>
      </tr>
    `).join('');
  }
}

/**
 * Initializes the vault application, restores URL state, binds events, and loads data in parallel.
 */
async function init() {
  checkVaultInactivity(true);
  const { hasUrlView } = restoreFiltersFromUrl();
  applyViewMode(state.viewMode, false, !hasUrlView);
  renderActiveFilterChips();
  setupEventListeners();
  renderInitialSkeletons();
  syncBrowserTimezone();
  await Promise.all([checkHealth(), loadStats(), loadCreators(), fetchReels()]);
}

/**
 * Applies grid or list view mode to the UI, updates button pressed states, and optionally syncs URL state and preference.
 * @param {'grid' | 'list'} mode
 * @param {boolean} [shouldSyncUrl=true]
 * @param {boolean} [persistPreference=true]
 */
function applyViewMode(mode, shouldSyncUrl = true, persistPreference = true) {
  state.viewMode = mode;
  if (persistPreference) {
    saveViewMode(mode);
  }

  const isGrid = mode === 'grid';
  viewModeGridBtn.classList.toggle('active', isGrid);
  viewModeGridBtn.setAttribute('aria-pressed', String(isGrid));
  viewModeListBtn.classList.toggle('active', !isGrid);
  viewModeListBtn.setAttribute('aria-pressed', String(!isGrid));

  reelsGrid.classList.toggle('is-hidden', !isGrid);
  reelsTableContainer.classList.toggle('is-hidden', isGrid);
  renderInitialSkeletons();

  if (isGrid) {
    observeGridCardsForThumbnails();
  } else {
    resetGridThumbnailHydration();
  }

  if (shouldSyncUrl) {
    syncUrlState();
  }
}

/**
 * Updates the storage badge markup cleanly with desktop and compact mobile labels.
 * @param {'connected' | 'local' | 'offline'} variant
 * @param {string} fullLabel
 * @param {string} shortLabel
 */
function renderDbBadge(variant, fullLabel, shortLabel) {
  dbBadge.className = `nav-badge ${variant}`;
  dbBadge.innerHTML = `<span class="badge-dot" aria-hidden="true"></span><span class="badge-label badge-label-full">${escapeHtml(fullLabel)}</span><span class="badge-label badge-label-short" aria-hidden="true">${escapeHtml(shortLabel)}</span>`;
}

/**
 * Checks server and database connectivity, updating the status indicator badge.
 */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Health request failed');
    const data = await res.json();
    if (data.database === 'supabase') {
      renderDbBadge('connected', 'Cloud Synced', 'Synced');
    } else {
      renderDbBadge('local', 'Local Vault', 'Local');
    }
  } catch (_) {
    renderDbBadge('offline', 'Offline', 'Offline');
  }
}

/**
 * Fetches summary statistics from the server and populates metric cards.
 * @param {{ silent?: boolean }} [options]
 */
async function loadStats(options = {}) {
  const silent = Boolean(options.silent);
  if (silent && statsFetchController?.isExplicit) {
    return;
  }
  if (statsFetchController) {
    statsFetchController.abort();
  }
  const controller = new AbortController();
  controller.isExplicit = !silent;
  statsFetchController = controller;
  const { signal } = controller;
  if (!silent) {
    statsBar?.setAttribute('aria-busy', 'true');
  }
  try {
    const res = await vaultFetch('/api/stats', { signal });
    if (signal.aborted) return;
    if (res.status === 401) {
      showVaultGateScreen();
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const stats = await res.json();
    if (signal.aborted) return;
    state.stats = stats;
    statsLoadErrorNotified = false;

    const totalReels = Number(stats.totalReels || 0);
    const savedOnIgCount = stats.savedOnInstagramCount !== undefined ? Number(stats.savedOnInstagramCount) : null;
    const botSentCount = stats.botSentCount !== undefined ? Number(stats.botSentCount) : null;
    const totalCreators = Number(stats.totalCreators || 0);
    const savedWeek = Number(stats.savedThisWeek || 0);
    const watchLaterCount = Number(stats.watchLaterCount || 0);
    const watchedCount = Number(stats.watchedCount || 0);
    const reelsCount = stats.reelsCount !== undefined ? Number(stats.reelsCount) : null;
    const postsCount = stats.postsCount !== undefined ? Number(stats.postsCount) : null;

    statTotal.textContent = totalReels.toLocaleString();
    if (sourceCountAll) sourceCountAll.textContent = totalReels.toLocaleString();
    if (sourceCountInstagram) {
      sourceCountInstagram.textContent = savedOnIgCount !== null ? savedOnIgCount.toLocaleString() : '—';
    }
    if (sourceCountBot) {
      sourceCountBot.textContent = botSentCount !== null ? botSentCount.toLocaleString() : '—';
    }
    if (statMediaSplit) {
      if (reelsCount !== null && postsCount !== null && totalReels > 0) {
        const reelWord = reelsCount === 1 ? 'reel' : 'reels';
        const postWord = postsCount === 1 ? 'post' : 'posts';
        statMediaSplit.textContent = `${reelsCount.toLocaleString()} ${reelWord} · ${postsCount.toLocaleString()} ${postWord}`;
      } else {
        statMediaSplit.textContent = '';
      }
    }
    statCreators.textContent = totalCreators.toLocaleString();
    statWeek.textContent = savedWeek.toLocaleString();
    statWatchLater.textContent = watchLaterCount.toLocaleString();
    if (statWatched) {
      statWatched.textContent = watchedCount.toLocaleString();
    }
    statsBar?.querySelector('[data-stats-error]')?.remove();
    statsBar?.classList.remove('has-stats-error');
    if (metricFilterLater) {
      metricFilterLater.classList.toggle('has-pending-later', watchLaterCount > 0);
    }
    statsBar?.classList.remove('is-initial-loading');
  } catch (e) {
    if (e?.name === 'AbortError' || signal.aborted) return;
    console.error('Failed to load stats:', e);
    statsBar?.classList.remove('is-initial-loading');
    if (!state.stats) {
      statTotal.textContent = '—';
      if (sourceCountAll) sourceCountAll.textContent = '—';
      if (sourceCountInstagram) sourceCountInstagram.textContent = '—';
      if (sourceCountBot) sourceCountBot.textContent = '—';
      if (statMediaSplit) statMediaSplit.textContent = '';
      statCreators.textContent = '—';
      statWeek.textContent = '—';
      statWatchLater.textContent = '—';
      if (statWatched) {
        statWatched.textContent = '—';
      }
      if (metricFilterLater) {
        metricFilterLater.classList.remove('has-pending-later');
      }
      if (statsBar) {
        statsBar.classList.add('has-stats-error');
        if (!statsBar.querySelector('[data-stats-error]')) {
          const banner = document.createElement('div');
          banner.className = 'stats-error-banner';
          banner.setAttribute('data-stats-error', '1');
          banner.setAttribute('role', 'alert');
          banner.innerHTML = '<span class="stats-error-msg">Library stats unavailable.</span><button type="button" class="strip-inline-retry" data-action="retry-stats" aria-label="Retry loading library statistics">Retry</button>';
          banner.querySelector('[data-action="retry-stats"]')?.addEventListener('click', () => loadStats());
          statsBar.appendChild(banner);
        }
      }
    }
    if (!silent && !statsLoadErrorNotified) {
      statsLoadErrorNotified = true;
      showToast('Could not load library statistics.', 'error', {
        actionLabel: 'Retry',
        onAction: () => loadStats(),
      });
    }
  } finally {
    if (statsFetchController === controller) {
      statsFetchController = null;
      if (!silent) {
        statsBar?.setAttribute('aria-busy', 'false');
      }
    }
  }
}

/**
 * Fetches bounded top creators (or matching server search results) and populates the quick-filter strip
 * without shipping the full directory over initial page load.
 * @param {string} [query=state.creatorQuery]
 * @param {{ silent?: boolean }} [options]
 */
async function loadCreators(query = state.creatorQuery, options = {}) {
  const silent = Boolean(options.silent);
  if (silent && creatorsFetchController?.isExplicit) {
    return;
  }
  const trimmedQ = String(query || '').trim();
  if (creatorsFetchController) {
    creatorsFetchController.abort();
  }
  const controller = new AbortController();
  controller.isExplicit = !silent;
  creatorsFetchController = controller;
  const { signal } = controller;
  isCreatorSearching = Boolean(trimmedQ);

  if (!silent && creatorStripMeta && !trimmedQ && state.creators.length === 0) {
    creatorStripMeta.textContent = 'Loading top creators...';
  } else if (!silent && creatorStripMeta && trimmedQ) {
    renderCreatorStrip();
  }

  try {
    const params = new URLSearchParams();
    if (trimmedQ) {
      params.set('q', trimmedQ);
      params.set('limit', String(CREATOR_SEARCH_LIMIT));
    } else {
      params.set('limit', String(CREATOR_TOP_LIMIT));
      if (state.filters.creatorId) {
        params.set('includeId', state.filters.creatorId);
      }
    }

    const res = await vaultFetch(`/api/creators?${params.toString()}`, { signal });
    if (res.status === 401) {
      showVaultGateScreen();
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const list = await res.json();
    if (signal.aborted) return;

    const totalHdr = parseInt(res.headers.get('X-Total-Count') || '', 10);
    const matchHdr = parseInt(res.headers.get('X-Match-Count') || '', 10);

    state.creators = Array.isArray(list) ? list : [];
    state.totalCreators = Number.isFinite(totalHdr) ? totalHdr : Math.max(state.totalCreators, state.creators.length);
    state.creatorMatchTotal = Number.isFinite(matchHdr) ? matchHdr : state.creators.length;

    if (!trimmedQ) {
      state.topCreators = state.creators;
    }

    if (state.filters.creatorId) {
      const activeMatch = state.creators.find((c) => c.id === state.filters.creatorId)
        || state.topCreators.find((c) => c.id === state.filters.creatorId);
      if (activeMatch) {
        state.selectedCreator = activeMatch;
      }
    }

    isCreatorSearching = false;
    creatorsLoadErrorNotified = false;
    renderCreatorStrip();
    renderActiveFilterChips();
  } catch (e) {
    if (e?.name === 'AbortError') return;
    isCreatorSearching = false;
    console.error('Failed to load creators:', e);
    if (silent && state.creators.length > 0) {
      return;
    }
    if (creatorStripMeta && (trimmedQ || state.creators.length === 0)) {
      creatorStripMeta.innerHTML = '<span>Creator filters unavailable</span> <button type="button" class="strip-inline-retry" data-action="retry-creators">Retry</button>';
      creatorStripMeta.querySelector('[data-action="retry-creators"]')?.addEventListener('click', () => loadCreators(state.creatorQuery));
    }
    if (!silent && !creatorsLoadErrorNotified) {
      creatorsLoadErrorNotified = true;
      showToast('Could not load creator filters.', 'error', {
        actionLabel: 'Retry',
        onAction: () => loadCreators(state.creatorQuery),
      });
    }
  } finally {
    if (creatorsFetchController === controller) {
      creatorsFetchController = null;
    }
  }
}

/**
 * Renders the bounded quick-filter strip: All Creators + Top 6 creators (or top 15 matching search query),
 * always retaining the active creator selection so DOM complexity and payloads stay minimal across 4,900+ creators.
 */
function renderCreatorStrip() {
  creatorPillsList.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  const isAllActive = !state.filters.creatorId;
  allBtn.className = `creator-chip ${isAllActive ? 'active' : ''}`;
  allBtn.setAttribute('data-creator-id', '');
  allBtn.setAttribute('aria-pressed', String(isAllActive));
  allBtn.textContent = 'All Creators';
  allBtn.addEventListener('click', () => selectCreator(''));
  creatorPillsList.appendChild(allBtn);

  const q = state.creatorQuery.trim().toLowerCase().replace(/^@+/, '');
  const limit = q ? CREATOR_SEARCH_LIMIT : CREATOR_TOP_LIMIT;
  const visibleCreators = state.creators.slice(0, limit);

  if (state.filters.creatorId) {
    const selectedCreator = findCreatorById(state.filters.creatorId);
    if (selectedCreator && !visibleCreators.some((c) => c.id === selectedCreator.id)) {
      visibleCreators.unshift(selectedCreator);
    }
  }

  for (const c of visibleCreators) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isActive = state.filters.creatorId === c.id;
    chip.className = `creator-chip ${isActive ? 'active' : ''}`;
    chip.setAttribute('data-creator-id', c.id);
    chip.setAttribute('aria-pressed', String(isActive));

    const cleanAvatar = sanitizeMediaUrl(c.profile_picture_url);
    if (cleanAvatar && !isPlaceholderMediaUrl(cleanAvatar)) {
      const img = document.createElement('img');
      img.src = cleanAvatar;
      img.referrerPolicy = 'no-referrer';
      img.className = 'creator-chip-img';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
      chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = getCreatorDisplayInfo(c).displayText;
    chip.appendChild(name);

    if (c.saved_count) {
      const counter = document.createElement('span');
      counter.className = 'chip-counter';
      counter.textContent = Number(c.saved_count).toLocaleString();
      chip.appendChild(counter);
    }

    chip.addEventListener('click', () => selectCreator(c.id));
    creatorPillsList.appendChild(chip);
  }

  if (creatorStripMeta) {
    const totalCreatorsCount = state.totalCreators || state.creators.length;
    if (q && isCreatorSearching) {
      creatorStripMeta.textContent = `Searching "@${q}"...`;
    } else if (totalCreatorsCount === 0 && !q) {
      creatorStripMeta.textContent = '';
    } else if (q) {
      const matchTotal = state.creatorMatchTotal || state.creators.length;
      creatorStripMeta.textContent = state.creators.length === 0
        ? `No creators matching "@${q}"`
        : `Showing ${Math.min(state.creators.length, limit)} of ${matchTotal.toLocaleString()} matches`;
    } else {
      const shownCount = Math.min(state.creators.length, CREATOR_TOP_LIMIT);
      creatorStripMeta.textContent = totalCreatorsCount > CREATOR_TOP_LIMIT
        ? `Showing top ${shownCount} of ${totalCreatorsCount.toLocaleString()}`
        : `${totalCreatorsCount.toLocaleString()} creators`;
    }
  }

  resetCreatorBtn.hidden = !state.filters.creatorId;
  setCreatorsExpanded(Boolean(creatorsStripContainer?.classList.contains('is-expanded') || q));
}

/**
 * Selects a creator for filtering, resets pagination to page 1, syncs URL, and fetches reels.
 * @param {string} id
 */
function selectCreator(id) {
  const nextId = (state.filters.creatorId === id && id) ? '' : id;
  state.filters.creatorId = nextId;
  state.selectedCreator = nextId ? findCreatorById(nextId) : null;
  state.filters.page = 1;
  syncKpiActiveStates();
  syncUrlState();
  renderCreatorStrip();
  fetchReels();
}

/**
 * Queries reels matching active filters, pagination, and search terms with abort safety and inline error recovery.
 * @param {{ silent?: boolean; pageOverride?: number; append?: boolean }} [options]
 */
async function fetchReels(options = {}) {
  const silent = Boolean(options.silent);
  const isAppend = Boolean(options.append);
  if (silent && !isAppend && fetchReelsAbortController?.isExplicit) {
    return;
  }
  const pageToFetch = Number.isInteger(options.pageOverride) && options.pageOverride >= 1
    ? options.pageOverride
    : state.filters.page;

  if (!isAppend && fetchReelsAbortController) {
    fetchReelsAbortController.abort();
  }
  const controller = new AbortController();
  controller.isExplicit = !silent && !isAppend;
  if (!isAppend) {
    fetchReelsAbortController = controller;
  }
  const { signal } = controller;

  if (!isAppend) {
    renderActiveFilterChips();
  }
  if (!silent && !isAppend) {
    const queryLabels = getMediaUnitLabels(state.filters.mediaType, state.filters.source);
    resultsCount.textContent = `Querying ${queryLabels.scopedPlural}...`;
  }

  const params = new URLSearchParams();
  if (state.filters.source && state.filters.source !== 'all') params.set('source', state.filters.source);
  if (state.filters.creatorId) params.set('creatorId', state.filters.creatorId);
  if (state.filters.mediaType && state.filters.mediaType !== 'all') params.set('mediaType', state.filters.mediaType);
  if (state.filters.datePreset !== 'all') params.set('datePreset', state.filters.datePreset);
  if (state.filters.watchStatus !== 'all') params.set('watchStatus', state.filters.watchStatus);
  if (state.filters.sortBy) params.set('sortBy', state.filters.sortBy);
  if (state.filters.search.trim()) params.set('search', state.filters.search.trim());
  params.set('page', String(pageToFetch));
  params.set('limit', String(state.filters.limit));

  try {
    const res = await vaultFetch(`/api/reels?${params.toString()}`, { signal });
    if (signal.aborted) return;
    if (res.status === 401) {
      showVaultGateScreen();
      return;
    }
    if (!isSwitchingVault) {
      hideVaultGateScreen();
    }
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody?.error) errMsg = errBody.error;
      } catch (_) {
        /* ignore non-JSON error body */
      }
      throw new Error(errMsg);
    }

    const data = await res.json();
    if (signal.aborted) return;
    if (silent && !isAppend && feedModal?.classList.contains('active')) return;

    const nextReels = data.reels || [];
    const nextTotal = data.total || 0;
    const maxPage = Math.max(1, Math.ceil(nextTotal / state.filters.limit) || 1);
    if (!isAppend && nextReels.length === 0 && pageToFetch > maxPage) {
      if (fetchReelsAbortController === controller) {
        fetchReelsAbortController = null;
      }
      return fetchReels({ silent, pageOverride: maxPage });
    }

    state.total = nextTotal;
    hasInitialReelsSettled = true;

    if (isAppend) {
      const existingIds = new Set(state.reels.map((r) => r.id));
      const newItems = nextReels.filter((r) => !existingIds.has(r.id));
      if (newItems.length > 0) {
        state.reels.push(...newItems);
        renderReels({ append: true, newReels: newItems });
        if (feedModal?.classList.contains('active')) {
          appendFeedSlides(newItems);
        }
      }
      const highestPage = Math.max(state.filters.page, pageToFetch);
      updatePagination(highestPage, state.filters.limit, state.total);
    } else {
      state.initialPageOffset = (pageToFetch - 1) * state.filters.limit;
      if (pageToFetch !== state.filters.page) {
        state.filters.page = pageToFetch;
        syncUrlState();
      }
      state.reels = nextReels;
      renderReels();
      updatePagination(data.page, data.limit, data.total);
      if (feedModal?.classList.contains('active')) {
        renderFeedSlides();
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.error('Failed to fetch reels:', e);
    if (silent && hasInitialReelsSettled) {
      return;
    }
    hasInitialReelsSettled = true;
    renderFetchErrorState(e?.message || 'Unable to reach server');
  } finally {
    if (fetchReelsAbortController === controller) {
      fetchReelsAbortController = null;
    }
  }
}

/**
 * Renders an inline, actionable recovery state cleanly inside both Grid and List canvases.
 * @param {string} errorDetail
 */
function renderFetchErrorState(errorDetail) {
  hasInitialReelsSettled = true;
  resultsCount.textContent = 'Could not load tracked items.';
  paginationBar.classList.add('is-hidden');

  const safeDetail = escapeHtml(errorDetail);
  const resetBtnHtml = hasActiveFilters()
    ? '<button type="button" class="nav-btn nav-btn-secondary" data-action="reset-all-filters">Reset Filters</button>'
    : '';
  const errorHtml = `
    <div class="vault-error-state" role="alert">
      <div class="empty-title-text">Couldn&rsquo;t Load Tracked Items</div>
      <div class="empty-desc-text">The vault query failed (${safeDetail}). Your current search and filters are preserved.</div>
      <div class="state-actions-row">
        <button type="button" class="nav-btn nav-btn-primary" data-action="retry-fetch">Retry Query</button>
        ${resetBtnHtml}
      </div>
    </div>
  `;

  reelsGrid.innerHTML = errorHtml;
  reelsTableBody.innerHTML = '';
  if (reelsTable) reelsTable.hidden = true;
  if (reelsTableContainer) reelsTableContainer.classList.add('is-empty-state');
  if (reelsTableState) {
    reelsTableState.hidden = false;
    reelsTableState.innerHTML = errorHtml;
  }

  vaultContainerEl?.querySelectorAll('[data-action="retry-fetch"]').forEach((btn) => {
    btn.addEventListener('click', () => fetchReels());
  });
  vaultContainerEl?.querySelectorAll('[data-action="reset-all-filters"]').forEach((btn) => {
    btn.addEventListener('click', clearAllFilters);
  });
}

/**
 * Selects the authoritative timestamp and truthful label prefix (`Saved` vs `Sent` vs `Published`)
 * for a grid card, list row, or fullscreen slide.
 * @param {object} reel
 * @returns {{ labelPrefix: 'Saved' | 'Sent' | 'Published', iso: string }}
 */
function getReelDisplayDate(reel) {
  const sort = state.filters.sortBy;
  if (sort === 'newest_published' || sort === 'oldest_published') {
    return {
      labelPrefix: 'Published',
      iso: reel.taken_at || reel.saved_at || reel.first_detected_at || '',
    };
  }
  if (reel?.is_saved_on_instagram === false) {
    return {
      labelPrefix: 'Sent',
      iso: reel.first_detected_at || reel.saved_at || reel.taken_at || '',
    };
  }
  return {
    labelPrefix: 'Saved',
    iso: reel.saved_at || reel.first_detected_at || reel.taken_at || '',
  };
}

const CHECK_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const UNCHECKED_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle></svg>';

/**
 * Returns crisp inner markup for the Watched toggle pill (Bookmark/Later badge owns Watch Later separately).
 * @param {string} status
 * @returns {string}
 */
function renderStatusPillContent(status) {
  return status === 'watched'
    ? `${CHECK_ICON_SVG}<span>Watched</span>`
    : `${UNCHECKED_ICON_SVG}<span>Mark Watched</span>`;
}

/**
 * Returns hover tooltip text clarifying 1-click Watched toggle and Watch Later overwrite behavior.
 * @param {string} status
 * @returns {string}
 */
function getStatusPillTitle(status) {
  if (status === 'watched') return 'Mark as Unwatched';
  if (status === 'watch_later') return 'Mark as Watched (moves out of Watch Later)';
  return 'Mark as Watched';
}

/**
 * Returns hover tooltip text clarifying 1-click Watch Later toggle and Watched overwrite behavior.
 * @param {string} status
 * @param {'card' | 'list' | 'feed'} [surface='card']
 * @returns {string}
 */
function getLaterButtonTitle(status, surface = 'card') {
  if (status === 'watch_later') {
    return surface === 'feed' ? 'Remove from Watch Later (l)' : 'Remove from Watch Later';
  }
  if (status === 'watched') {
    return surface === 'feed' ? 'Move to Watch Later (clears Watched) (l)' : 'Move to Watch Later (clears Watched)';
  }
  if (surface === 'feed') return 'Watch Later (l)';
  return 'Add to Watch Later';
}

/**
 * Returns screen-reader label describing Watch Later button state and mutual exclusion behavior.
 * @param {string} status
 * @param {string} targetLabel
 * @param {'card' | 'list' | 'feed'} [surface='card']
 * @returns {string}
 */
function getLaterButtonAriaLabel(status, targetLabel, surface = 'card') {
  const safeTarget = targetLabel || 'this item';
  if (status === 'watch_later') {
    return surface === 'feed' ? 'Remove from Watch Later' : `Remove ${safeTarget} from Watch Later`;
  }
  if (status === 'watched') {
    return surface === 'feed'
      ? 'Move to Watch Later (clears Watched)'
      : `Move ${safeTarget} to Watch Later (clears Watched)`;
  }
  if (surface === 'feed') return 'Watch Later';
  return `Add ${safeTarget} to Watch Later`;
}

/**
 * Returns screen-reader label describing both the 1-click Watched toggle action and current state.
 * @param {string} status
 * @param {string} targetLabel
 * @returns {string}
 */
function getStatusPillAriaLabel(status, targetLabel) {
  const safeTarget = targetLabel || 'this reel';
  if (status === 'watched') return `Mark ${safeTarget} as Unwatched`;
  if (status === 'watch_later') return `Mark ${safeTarget} as Watched (currently Watch Later)`;
  return `Mark ${safeTarget} as Watched`;
}

/**
 * Builds an accessible grid poster card with tactile play, creator filter, bookmark, and watched toggles.
 * @param {object} reel
 * @param {string} rankNum
 * @returns {HTMLElement}
 */
function createGridCard(reel, rankNum) {
  const effectiveStatus = pendingStatusValues.has(reel.id) ? pendingStatusValues.get(reel.id) : reel.watch_status;
  const isPending = pendingStatusIds.has(reel.id);
  const isBotSent = reel.is_saved_on_instagram === false;
  const itemType = getSavedMediaType(reel);
  const isPost = itemType === 'post';
  const badgeLabel = isPost ? 'Post' : 'Reel';
  const badgeClass = isPost ? 'media-type-post' : 'media-type-reel';
  const itemWord = isPost ? 'post' : 'reel';
  const sourcePillHtml = isBotSent ? '<span class="card-source-pill is-bot">Bot</span>' : '';
  const creatorInfo = getCreatorDisplayInfo(reel.creator);
  const safeCreator = escapeHtml(creatorInfo.displayText);
  const ariaTarget = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `this ${itemWord}`;
  const safeAriaTarget = escapeHtml(ariaTarget);
  const creatorFilterSubject = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `unattributed ${itemWord}s`;
  const { initial } = creatorInfo;
  const dateInfo = getReelDisplayDate(reel);
  const dateFormatted = formatShortDate(dateInfo.iso);
  const isWatchLater = effectiveStatus === 'watch_later';
  const isWatched = effectiveStatus === 'watched';
  const pillTitle = escapeHtml(getStatusPillTitle(effectiveStatus));
  const pillAria = escapeHtml(getStatusPillAriaLabel(effectiveStatus, ariaTarget));
  const cardLaterTitle = escapeHtml(getLaterButtonTitle(effectiveStatus, 'card'));
  const cardLaterAria = escapeHtml(getLaterButtonAriaLabel(effectiveStatus, ariaTarget, 'card'));
  const cleanCaption = stripPrivateUseChars(reel.caption).trim();
  const rawCaption = cleanCaption || 'No caption provided';
  const safeCaption = escapeHtml(rawCaption);
  const rawCleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
  const replacedStoredThumb = rawCleanThumbnail ? sanitizeMediaUrl(gridThumbReplacedUrls.get(rawCleanThumbnail)) : null;
  const cachedMetaThumb = reel.shortcode ? sanitizeMediaUrl(state.metaCache.get(reel.shortcode)?.thumbnailUrl) : null;
  const cleanThumbnail = (replacedStoredThumb && !isPlaceholderMediaUrl(replacedStoredThumb))
    ? replacedStoredThumb
    : ((rawCleanThumbnail && !isPlaceholderMediaUrl(rawCleanThumbnail))
      ? rawCleanThumbnail
      : ((cachedMetaThumb && !isPlaceholderMediaUrl(cachedMetaThumb)) ? cachedMetaThumb : null));
  const hasRealThumbnail = Boolean(cleanThumbnail);
  const thumbMeta = ReelerGeometry.parseThumbMeta(cleanThumbnail);
  const posterAltText = creatorInfo.isAttributedName
    ? `${badgeLabel} poster by ${ariaTarget}`
    : `${isBotSent ? 'Tracked' : 'Saved'} ${itemWord} poster`;
  const posterKindLabel = thumbMeta.mediaKind === 'CAROUSEL_ITEM'
    ? 'Carousel'
    : ((isPost || thumbMeta.isClips === false)
      ? (isBotSent ? 'Bot Post' : 'Saved Post')
      : (isBotSent ? 'Bot Reel' : 'Saved Reel'));
  const touchCueLabel = (isPost || thumbMeta.isClips === false) ? 'Open' : 'Watch';
  const creatorId = reel.creator?.id ? String(reel.creator.id) : '';
  const isCreatorFiltered = Boolean(creatorId && state.filters.creatorId === creatorId);
  const creatorFilterTitle = escapeHtml(
    creatorId
      ? (isCreatorFiltered ? `Showing ${creatorFilterSubject} (click to clear filter)` : `Filter vault by ${creatorFilterSubject}`)
      : `Unattributed ${itemWord} (creator filter unavailable)`
  );
  const creatorFilterAria = escapeHtml(
    isCreatorFiltered ? `Clear creator filter ${creatorFilterSubject}` : `Filter items by ${creatorFilterSubject}`
  );

  const card = document.createElement('article');
  card.className = `vault-poster-card ${hasRealThumbnail ? 'has-thumbnail' : 'is-monogram'}`;
  card.setAttribute('data-id', reel.id);
  card.setAttribute('data-media-type', itemType);
  card.setAttribute('data-source', isBotSent ? 'bot' : 'instagram');

  const hasDateLabel = Boolean(dateFormatted && dateFormatted !== 'Unknown');
  const monogramTitleHtml = creatorInfo.isAttributedName
    ? `<div class="art-creator-handle">${safeCreator}</div>`
    : (cleanCaption
      ? `<div class="art-caption-preview">${escapeHtml(cleanCaption)}</div>`
      : (hasDateLabel
        ? `<div class="art-creator-handle">${escapeHtml(`${dateInfo.labelPrefix} ${dateFormatted}`)}</div>`
        : ''));

  const monogramArtHtml = `
    <div class="monochrome-poster-art"${hasRealThumbnail ? ' aria-hidden="true"' : ''}>
      <div class="art-center-block">
        <div class="art-monogram-circle" aria-hidden="true">${initial}</div>
        ${monogramTitleHtml}
        <div class="art-poster-kind">${posterKindLabel}</div>
      </div>
      <div class="poster-bottom-scrim"></div>
    </div>
  `;

  const imageLayerHtml = hasRealThumbnail
    ? `
      <img class="poster-actual-img" src="${escapeHtml(cleanThumbnail)}" referrerpolicy="no-referrer" alt="${escapeHtml(posterAltText)}" loading="lazy" />
      <div class="poster-top-scrim"></div>
      <div class="poster-bottom-scrim"></div>
    `
    : '';

  card.innerHTML = `
    <div class="poster-media-box">
      ${monogramArtHtml}
      ${imageLayerHtml}
      <button type="button" class="poster-play-trigger" aria-label="Open ${itemWord} #${rankNum}${creatorInfo.isAttributedName ? ` by ${safeAriaTarget}` : ''} in fullscreen feed">
        <span class="play-hover-trigger" aria-hidden="true">
          <span class="play-icon-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </span>
        </span>
        <span class="poster-cue-monogram" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="6 4 20 12 6 20 6 4"></polygon>
          </svg>
        </span>
        <span class="poster-cue-thumb" aria-hidden="true">${touchCueLabel}</span>
      </button>
      <div class="card-header-overlay">
        <div class="card-header-badges">
          <span class="rank-tag" aria-hidden="true">#${rankNum}</span>
          <span class="media-type-badge ${badgeClass}">${badgeLabel}</span>
        </div>
        <button type="button" class="card-bookmark-btn ${isWatchLater ? 'active' : ''}" title="${cardLaterTitle}" aria-label="${cardLaterAria}" aria-pressed="${isWatchLater}"${isPending ? ' disabled aria-busy="true"' : ''}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="card-details-box">
      <div class="card-creator-row">
        <button type="button" class="card-creator-filter-btn ${isCreatorFiltered ? 'is-active' : ''}" data-action="filter-creator" title="${creatorFilterTitle}" aria-label="${creatorFilterAria}" aria-pressed="${isCreatorFiltered}"${creatorId ? '' : ' disabled'}><span class="handle-text">${safeCreator}</span></button>
      </div>
      <div class="card-caption-line">${safeCaption}</div>
      <div class="card-footer-meta">
        <div class="card-meta-left">
          <span class="card-date-label">${dateInfo.labelPrefix} ${dateFormatted}</span>
          ${sourcePillHtml}
          <span class="card-later-badge"${isWatchLater ? '' : ' hidden'}>Later</span>
        </div>
        <button type="button" class="status-pill-toggle ${isWatched ? 'status-pill-watched' : 'status-pill-unwatched'}" data-id="${reel.id}" title="${pillTitle}" aria-label="${pillAria}" aria-pressed="${isWatched}"${isPending ? ' disabled aria-busy="true"' : ''}>
          ${renderStatusPillContent(effectiveStatus)}
        </button>
      </div>
    </div>
  `;

  const posterPlayTrigger = card.querySelector('.poster-play-trigger');
  posterPlayTrigger.addEventListener('click', () => {
    openReelsFeed(reel, posterPlayTrigger);
  });

  const cardCreatorFilterBtn = card.querySelector('[data-action="filter-creator"]');
  if (cardCreatorFilterBtn && creatorId) {
    cardCreatorFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextId = state.filters.creatorId === creatorId ? '' : creatorId;
      if (nextId && reel.creator) {
        state.selectedCreator = reel.creator;
      }
      selectCreator(nextId);
      announceStatus(nextId ? `Filtered items by ${creatorFilterSubject}.` : 'Cleared creator filter.');
    });
  }

  const cardBookmark = card.querySelector('.card-bookmark-btn');
  cardBookmark.addEventListener('click', (e) => {
    e.stopPropagation();
    const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
    const nextStatus = latestStatus === 'watch_later' ? 'unwatched' : 'watch_later';
    updateReelStatus(reel.id, nextStatus);
  });

  const cardStatusBtn = card.querySelector('.status-pill-toggle');
  cardStatusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
    toggleWatchedStatus(reel.id, latestStatus);
  });

  const cardImg = card.querySelector('.poster-actual-img');
  if (cardImg) {
    cardImg.addEventListener('error', () => {
      cardImg.hidden = true;
      card.classList.remove('has-thumbnail');
      card.classList.add('is-monogram');
      card.querySelector('.monochrome-poster-art')?.removeAttribute('aria-hidden');
      if (!card.isConnected) return;
      const sc = reel.shortcode ? String(reel.shortcode).trim() : '';
      if (sc && !hasRefreshedGridThumb(sc, cleanThumbnail) && !isGridThumbUnavailable(sc)) {
        if (gridThumbPendingRefresh.has(sc)) {
          addGridThumbRefreshWaiter(sc, {
            card,
            reel,
            shortcode: sc,
            altText: posterAltText,
            isPost,
            bypassCache: false,
            suppressRefreshRetry: true,
            failedUrl: cleanThumbnail,
            failedStoredUrl: rawCleanThumbnail || cleanThumbnail,
          });
        } else {
          gridThumbPendingRefresh.add(sc);
          const cachedMeta = state.metaCache.get(sc);
          if (cachedMeta && sanitizeMediaUrl(cachedMeta.thumbnailUrl) === cleanThumbnail) {
            state.metaCache.delete(sc);
          }
          if (rawCleanThumbnail && gridThumbReplacedUrls.get(rawCleanThumbnail) === cleanThumbnail) {
            gridThumbReplacedUrls.delete(rawCleanThumbnail);
          }
          registerGridCardForThumbnailHydration(card, reel, posterAltText, isPost, {
            bypassCache: true,
            failedUrl: cleanThumbnail,
            failedStoredUrl: rawCleanThumbnail || cleanThumbnail,
          });
        }
      }
    }, { once: true });

    const handleCardImgLoaded = () => {
      cardImg.classList.add('is-loaded');
      if (reel.shortcode && cardImg.naturalWidth > 0 && cardImg.naturalHeight > 0) {
        state.thumbRatioCache.set(reel.shortcode, cardImg.naturalWidth / cardImg.naturalHeight);
      }
    };

    if (cardImg.complete && cardImg.naturalWidth > 0) {
      handleCardImgLoaded();
    } else {
      cardImg.addEventListener('load', handleCardImgLoaded, { once: true });
    }
  } else if (reel.shortcode) {
    registerGridCardForThumbnailHydration(card, reel, posterAltText, isPost);
  }

  return card;
}

/**
 * Builds an accessible list view table row with action buttons and creator filters.
 * @param {object} reel
 * @param {string} rankNum
 * @returns {HTMLTableRowElement}
 */
function createTableRow(reel, rankNum) {
  const effectiveStatus = pendingStatusValues.has(reel.id) ? pendingStatusValues.get(reel.id) : reel.watch_status;
  const isPending = pendingStatusIds.has(reel.id);
  const isBotSent = reel.is_saved_on_instagram === false;
  const itemType = getSavedMediaType(reel);
  const isPost = itemType === 'post';
  const badgeLabel = isPost ? 'Post' : 'Reel';
  const badgeClass = isPost ? 'media-type-post' : 'media-type-reel';
  const itemWord = isPost ? 'post' : 'reel';
  const sourcePillHtml = isBotSent ? '<span class="card-source-pill is-bot">Bot</span>' : '';
  const creatorInfo = getCreatorDisplayInfo(reel.creator);
  const safeCreator = escapeHtml(creatorInfo.displayText);
  const ariaTarget = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `this ${itemWord}`;
  const safeAriaTarget = escapeHtml(ariaTarget);
  const creatorFilterSubject = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `unattributed ${itemWord}s`;
  const safeReelUrl = escapeHtml(sanitizeExternalHref(reel.reel_url, 'https://www.instagram.com/'));
  const { initial } = creatorInfo;
  const dateInfo = getReelDisplayDate(reel);
  const dateFormatted = formatShortDate(dateInfo.iso);
  const isWatchLater = effectiveStatus === 'watch_later';
  const isWatched = effectiveStatus === 'watched';
  const pillTitle = escapeHtml(getStatusPillTitle(effectiveStatus));
  const pillAria = escapeHtml(getStatusPillAriaLabel(effectiveStatus, ariaTarget));
  const listLaterTitle = escapeHtml(getLaterButtonTitle(effectiveStatus, 'list'));
  const listLaterAria = escapeHtml(getLaterButtonAriaLabel(effectiveStatus, ariaTarget, 'list'));
  const cleanCaption = stripPrivateUseChars(reel.caption).trim();
  const rawCaption = cleanCaption || 'No caption provided';
  const safeCaption = escapeHtml(rawCaption);
  const creatorId = reel.creator?.id ? String(reel.creator.id) : '';
  const isCreatorFiltered = Boolean(creatorId && state.filters.creatorId === creatorId);
  const creatorFilterTitle = escapeHtml(
    creatorId
      ? (isCreatorFiltered ? `Showing ${creatorFilterSubject} (click to clear filter)` : `Filter vault by ${creatorFilterSubject}`)
      : `Unattributed ${itemWord} (creator filter unavailable)`
  );
  const creatorFilterAria = escapeHtml(
    isCreatorFiltered ? `Clear creator filter ${creatorFilterSubject}` : `Filter items by ${creatorFilterSubject}`
  );

  const row = document.createElement('tr');
  row.className = 'table-row';
  row.setAttribute('data-id', reel.id);
  row.setAttribute('data-media-type', itemType);
  row.setAttribute('data-source', isBotSent ? 'bot' : 'instagram');
  const tableDateLabel = dateInfo.labelPrefix === 'Published'
    ? `Pub ${dateFormatted}`
    : `${dateInfo.labelPrefix} ${dateFormatted}`;

  row.innerHTML = `
    <td class="table-rank"><div class="table-rank-wrap"><span>#${rankNum}</span><span class="media-type-badge ${badgeClass}">${badgeLabel}</span></div></td>
    <td class="table-creator-td">
      <div class="table-creator-cell">
        <div class="table-creator-avatar" aria-hidden="true">${initial}</div>
        <button type="button" class="table-creator-filter-btn ${isCreatorFiltered ? 'is-active' : ''}" data-action="filter-creator" title="${creatorFilterTitle}" aria-label="${creatorFilterAria}" aria-pressed="${isCreatorFiltered}"${creatorId ? '' : ' disabled'}><span class="handle-text">${safeCreator}</span></button>
      </div>
    </td>
    <td class="table-caption-cell"><div class="table-caption-clamp" title="${safeCaption}">${safeCaption}</div></td>
    <td class="table-date-cell"><div class="table-date-wrap"><span class="table-date-text">${escapeHtml(tableDateLabel)}</span>${sourcePillHtml}</div></td>
    <td class="table-status-td">
      <div class="table-status-group">
        <span class="table-later-badge"${isWatchLater ? '' : ' hidden'}>Later</span>
        <button type="button" class="status-pill-toggle ${isWatched ? 'status-pill-watched' : 'status-pill-unwatched'}" data-id="${reel.id}" title="${pillTitle}" aria-label="${pillAria}" aria-pressed="${isWatched}"${isPending ? ' disabled aria-busy="true"' : ''}>
          ${renderStatusPillContent(effectiveStatus)}
        </button>
      </div>
    </td>
    <td class="table-actions-td">
      <div class="table-actions-cell">
        <button type="button" class="table-action-icon-btn btn-table-play" title="Open ${badgeLabel} in Feed" aria-label="Open ${itemWord}${creatorInfo.isAttributedName ? ` by ${safeAriaTarget}` : ''} in feed">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
        <button type="button" class="table-action-icon-btn btn-table-bookmark ${isWatchLater ? 'active' : ''}" title="${listLaterTitle}" aria-label="${listLaterAria}" aria-pressed="${isWatchLater}"${isPending ? ' disabled aria-busy="true"' : ''}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
        </button>
        <a class="table-action-icon-btn" href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" title="Open ${badgeLabel} on Instagram" aria-label="Open ${itemWord}${creatorInfo.isAttributedName ? ` by ${safeAriaTarget}` : ''} on Instagram">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </a>
      </div>
    </td>
  `;

  row.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('button')) return;
    openReelsFeed(reel, row.querySelector('.btn-table-play'));
  });

  const rowCreatorFilterBtn = row.querySelector('[data-action="filter-creator"]');
  if (rowCreatorFilterBtn && creatorId) {
    rowCreatorFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextId = state.filters.creatorId === creatorId ? '' : creatorId;
      if (nextId && reel.creator) {
        state.selectedCreator = reel.creator;
      }
      selectCreator(nextId);
      announceStatus(nextId ? `Filtered items by ${creatorFilterSubject}.` : 'Cleared creator filter.');
    });
  }

  const tablePlayBtn = row.querySelector('.btn-table-play');
  tablePlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openReelsFeed(reel, tablePlayBtn);
  });

  row.querySelector('.btn-table-bookmark').addEventListener('click', (e) => {
    e.stopPropagation();
    const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
    const nextStatus = latestStatus === 'watch_later' ? 'unwatched' : 'watch_later';
    updateReelStatus(reel.id, nextStatus);
  });

  row.querySelector('.status-pill-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
    toggleWatchedStatus(reel.id, latestStatus);
  });

  return row;
}

/**
 * Renders reel poster cards in grid view and table rows in list view with accessible, non-nested controls.
 * @param {{ append?: boolean; newReels?: Array<object> }} [options]
 */
function renderReels(options = {}) {
  hasInitialReelsSettled = true;
  const isAppend = Boolean(options.append && Array.isArray(options.newReels));
  const typeLabels = getMediaUnitLabels(state.filters.mediaType, state.filters.source);

  if (!isAppend) {
    resetGridThumbnailHydration();
    renderActiveFilterChips();
    reelsGrid.innerHTML = '';
    reelsTableBody.innerHTML = '';
  }

  if (state.reels.length === 0) {
    resultsCount.textContent = `0 ${typeLabels.scopedPlural} match your view`;
    const filtersActive = hasActiveFilters();
    const subFiltersActive = hasActiveFilters(false);
    const isVaultEmpty = !filtersActive && state.total === 0;
    if (creatorsStripContainer) {
      creatorsStripContainer.classList.toggle('is-hidden', isVaultEmpty);
    }
    let emptyTitle = 'Your Vault Is Empty';
    let emptyDesc = 'You scroll through 1,000 reels a day. DM any reel or post to @er_reel_er on Instagram, or import saved_posts.json to keep the ones worth revisiting.';
    let emptyActionHtml = '<button type="button" class="nav-btn nav-btn-primary" data-action="empty-import">Import saved_posts.json</button>';

    if (subFiltersActive) {
      emptyTitle = `No Matching ${typeLabels.titlePlural}`;
      emptyDesc = `No ${typeLabels.scopedPlural} match the active category, type, creator, date, status, or keyword filters.`;
      emptyActionHtml = '<button type="button" class="nav-btn nav-btn-primary" data-action="reset-all-filters">Reset Filters</button>';
    } else if (state.filters.source === 'bot') {
      emptyTitle = 'No Bot-Sent Items Yet';
      emptyDesc = 'DM any Reel or Post link to @er_reel_er on Instagram to track it here with Watch Later reminders, without adding it to your Instagram Saved collection.';
      emptyActionHtml = filtersActive
        ? '<button type="button" class="nav-btn nav-btn-primary" data-action="reset-all-filters">Show All Items</button>'
        : emptyActionHtml;
    } else if (state.filters.source === 'instagram') {
      emptyTitle = 'No Saved on IG Items Yet';
      emptyDesc = 'Import Instagram’s saved_posts.json export to populate your Instagram Saved collection. Re-import exports anytime to sync new saves.';
      emptyActionHtml = '<button type="button" class="nav-btn nav-btn-primary" data-action="empty-import">Import saved_posts.json</button>';
    }

    let emptyHtml;
    if (isVaultEmpty) {
      emptyHtml = `
        <div class="vault-empty-state ftue-onboarding-card">
          <div class="ftue-hero-badge">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
              <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
            </svg>
            <span>Welcome to Reeler</span>
          </div>
          <div class="empty-title-text ftue-title">Your Private Vault is Ready</div>
          <div class="empty-desc-text ftue-desc">
            You scroll through hundreds of reels every day. Save the ones that actually inspire or teach you, organized automatically with creator tags, captions, and reminders.
          </div>
          <div class="ftue-steps-grid">
            <div class="ftue-step-card">
              <div class="ftue-step-num">1</div>
              <div class="ftue-step-content">
                <div class="ftue-step-title">Share Any Reel</div>
                <div class="ftue-step-text">Tap Share on any Instagram Reel or Post you want to remember.</div>
              </div>
            </div>
            <div class="ftue-step-card">
              <div class="ftue-step-num">2</div>
              <div class="ftue-step-content">
                <div class="ftue-step-title">DM @er_reel_er</div>
                <div class="ftue-step-text">Send the link directly to our bot in your Instagram DMs.</div>
              </div>
            </div>
            <div class="ftue-step-card">
              <div class="ftue-step-num">3</div>
              <div class="ftue-step-content">
                <div class="ftue-step-title">Indexed Instantly</div>
                <div class="ftue-step-text">Your reel appears here with instant search, creator tags, and reminders.</div>
              </div>
            </div>
          </div>
          <div class="state-actions-row ftue-actions-row">
            <a href="https://ig.me/m/er_reel_er" target="_blank" rel="noopener noreferrer" class="nav-btn nav-btn-primary ftue-btn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              Message @er_reel_er
            </a>
            <button type="button" class="nav-btn nav-btn-secondary ftue-btn" data-action="empty-import">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
              Import saved_posts.json
            </button>
            <button type="button" class="nav-btn nav-btn-ghost ftue-btn" data-action="copy-bot-handle">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              Copy Bot Handle
            </button>
          </div>
        </div>
      `;
    } else {
      emptyHtml = `
        <div class="vault-empty-state">
          <div class="empty-title-text">${emptyTitle}</div>
          <div class="empty-desc-text">${emptyDesc}</div>
          <div class="state-actions-row">
            ${emptyActionHtml}
          </div>
        </div>
      `;
    }
    reelsGrid.innerHTML = emptyHtml;
    if (reelsTable) reelsTable.hidden = true;
    if (reelsTableContainer) reelsTableContainer.classList.add('is-empty-state');
    if (reelsTableState) {
      reelsTableState.hidden = false;
      reelsTableState.innerHTML = emptyHtml;
    }

    vaultContainerEl?.querySelectorAll('[data-action="reset-all-filters"]').forEach((btn) => {
      btn.addEventListener('click', clearAllFilters);
    });
    vaultContainerEl?.querySelectorAll('[data-action="empty-import"]').forEach((btn) => {
      btn.addEventListener('click', () => importBtn.click());
    });
    vaultContainerEl?.querySelectorAll('[data-action="copy-bot-handle"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText('@er_reel_er');
            showToast('Copied @er_reel_er to clipboard!', 'success');
          } else {
            showToast('Instagram handle: @er_reel_er', 'info');
          }
        } catch (_) {
          showToast('Instagram handle: @er_reel_er', 'info');
        }
      });
    });
    return;
  }

  if (creatorsStripContainer) creatorsStripContainer.classList.remove('is-hidden');
  if (reelsTable) reelsTable.hidden = false;
  if (reelsTableContainer) reelsTableContainer.classList.remove('is-empty-state');
  if (reelsTableState) {
    reelsTableState.hidden = true;
    reelsTableState.innerHTML = '';
  }

  const baseOffset = state.initialPageOffset || 0;
  const rangeStart = baseOffset + 1;
  const rangeEnd = Math.min(baseOffset + state.reels.length, state.total);
  resultsCount.textContent = `Showing ${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${state.total.toLocaleString()} ${typeLabels.scopedUnit(state.total)}`;

  const itemsToRender = isAppend ? options.newReels : state.reels;
  const startIndex = isAppend ? (state.reels.length - options.newReels.length) : 0;

  for (let idx = 0; idx < itemsToRender.length; idx++) {
    const reel = itemsToRender[idx];
    const rankNum = (baseOffset + startIndex + idx + 1).toLocaleString();
    const card = createGridCard(reel, rankNum);
    const row = createTableRow(reel, rankNum);
    reelsGrid.appendChild(card);
    reelsTableBody.appendChild(row);
  }

  if (state.viewMode === 'grid') {
    observeGridCardsForThumbnails();
  }
}

/**
 * Patches matching catalog card and list row controls in place when status changes,
 * preserving active focus without re-rendering all DOM nodes.
 * @param {string} reelId
 * @param {'unwatched' | 'watch_later' | 'watched'} newStatus
 */
function syncCatalogReelStatus(reelId, newStatus) {
  const escapedId = CSS.escape(String(reelId));
  const isWatchLater = newStatus === 'watch_later';
  const isWatched = newStatus === 'watched';
  const reel = state.reels.find((r) => r.id === reelId);
  const itemWord = getSavedMediaType(reel) === 'post' ? 'post' : 'reel';
  const creatorInfo = getCreatorDisplayInfo(reel?.creator);
  const ariaTarget = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `this ${itemWord}`;
  const pillTitle = getStatusPillTitle(newStatus);
  const pillAria = getStatusPillAriaLabel(newStatus, ariaTarget);
  const pillHtml = renderStatusPillContent(newStatus);

  const card = reelsGrid.querySelector(`.vault-poster-card[data-id="${escapedId}"]`);
  if (card) {
    const bookmark = card.querySelector('.card-bookmark-btn');
    if (bookmark) {
      bookmark.classList.toggle('active', isWatchLater);
      bookmark.setAttribute('aria-pressed', String(isWatchLater));
      bookmark.setAttribute('title', getLaterButtonTitle(newStatus, 'card'));
      bookmark.setAttribute('aria-label', getLaterButtonAriaLabel(newStatus, ariaTarget, 'card'));
      const svg = bookmark.querySelector('svg');
      if (svg) svg.setAttribute('fill', isWatchLater ? 'currentColor' : 'none');
    }
    const laterBadge = card.querySelector('.card-later-badge');
    if (laterBadge) {
      laterBadge.hidden = !isWatchLater;
    }
    const pill = card.querySelector('.status-pill-toggle');
    if (pill) {
      pill.className = `status-pill-toggle ${isWatched ? 'status-pill-watched' : 'status-pill-unwatched'}`;
      pill.innerHTML = pillHtml;
      pill.setAttribute('title', pillTitle);
      pill.setAttribute('aria-label', pillAria);
      pill.setAttribute('aria-pressed', String(isWatched));
    }
  }

  const row = reelsTableBody.querySelector(`.table-row[data-id="${escapedId}"]`);
  if (row) {
    const bookmark = row.querySelector('.btn-table-bookmark');
    if (bookmark) {
      bookmark.classList.toggle('active', isWatchLater);
      bookmark.setAttribute('aria-pressed', String(isWatchLater));
      bookmark.setAttribute('title', getLaterButtonTitle(newStatus, 'list'));
      bookmark.setAttribute('aria-label', getLaterButtonAriaLabel(newStatus, ariaTarget, 'list'));
      const svg = bookmark.querySelector('svg');
      if (svg) svg.setAttribute('fill', isWatchLater ? 'currentColor' : 'none');
    }
    const laterBadge = row.querySelector('.table-later-badge');
    if (laterBadge) {
      laterBadge.hidden = !isWatchLater;
    }
    const pill = row.querySelector('.status-pill-toggle');
    if (pill) {
      pill.className = `status-pill-toggle ${isWatched ? 'status-pill-watched' : 'status-pill-unwatched'}`;
      pill.innerHTML = pillHtml;
      pill.setAttribute('title', pillTitle);
      pill.setAttribute('aria-label', pillAria);
      pill.setAttribute('aria-pressed', String(isWatched));
    }
  }
}

/**
 * Applies pending busy/disabled states across catalog and feed status controls for an in-flight update.
 * @param {string} reelId
 * @param {boolean} isPending
 */
function syncReelStatusPendingState(reelId, isPending) {
  const escapedId = CSS.escape(String(reelId));
  const controls = document.querySelectorAll(
    `.vault-poster-card[data-id="${escapedId}"] .card-bookmark-btn, ` +
    `.vault-poster-card[data-id="${escapedId}"] .status-pill-toggle, ` +
    `.table-row[data-id="${escapedId}"] .btn-table-bookmark, ` +
    `.table-row[data-id="${escapedId}"] .status-pill-toggle, ` +
    `.feed-reel-slide[data-reel-id="${escapedId}"] [data-action="feed-toggle-watched"], ` +
    `.feed-reel-slide[data-reel-id="${escapedId}"] [data-action="feed-toggle-later"]`
  );
  controls.forEach((btn) => {
    btn.disabled = isPending;
    if (isPending) {
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.removeAttribute('aria-busy');
    }
  });
}

/**
 * Sends a status update to the server, guards duplicate overlapping writes per reel,
 * patches catalog and feed controls in place, offers Undo on direct Watched <-> Watch Later swaps,
 * and surfaces errors visibly.
 * @param {string} reelId
 * @param {'unwatched' | 'watch_later' | 'watched'} newStatus
 * @param {{ previousStatus?: 'unwatched' | 'watch_later' | 'watched', suppressUndoToast?: boolean }} [options]
 */
async function updateReelStatus(reelId, newStatus, options = {}) {
  if (pendingStatusIds.has(reelId)) {
    return;
  }
  const existingTarget = state.reels.find((r) => r.id === reelId);
  const previousStatus = options.previousStatus ?? existingTarget?.watch_status ?? 'unwatched';
  pendingStatusIds.add(reelId);
  pendingStatusValues.set(reelId, newStatus);
  syncReelStatusPendingState(reelId, true);

  try {
    const res = await vaultFetch(`/api/reels/${encodeURIComponent(reelId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!res.ok) {
      let errText = `Server returned ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) errText = data.error;
      } catch (_) {
        /* ignore non-JSON body */
      }
      throw new Error(errText);
    }

    const target = state.reels.find((r) => r.id === reelId);
    if (target) target.watch_status = newStatus;

    syncFeedSlideStatus(reelId, newStatus);
    syncCatalogReelStatus(reelId, newStatus);
    const liveTarget = getCreatorDisplayInfo(target?.creator).accessibleName;
    announceStatus(`Marked ${liveTarget} as ${formatStatusLabel(newStatus)}.`);
    loadStats();

    const swappedFrom = (previousStatus === 'watched' && newStatus === 'watch_later')
      ? 'Watched'
      : ((previousStatus === 'watch_later' && newStatus === 'watched') ? 'Watch Later' : '');
    if (!options.suppressUndoToast && swappedFrom) {
      const swapTargetLabel = newStatus === 'watch_later' ? 'Watch Later' : 'Watched';
      showToast(`Moved to ${swapTargetLabel} (cleared ${swappedFrom}).`, 'info', {
        actionLabel: 'Undo',
        onAction: () => updateReelStatus(reelId, previousStatus, { suppressUndoToast: true }),
      });
    }
  } catch (e) {
    console.error('Failed to update status:', e);
    showToast(`Could not update watch status: ${e?.message || 'Request failed'}.`, 'error', {
      actionLabel: 'Retry',
      onAction: () => updateReelStatus(reelId, newStatus, options),
    });
  } finally {
    pendingStatusIds.delete(reelId);
    pendingStatusValues.delete(reelId);
    syncReelStatusPendingState(reelId, false);
  }
}

/**
 * Directly toggles a reel between Watched and Unwatched in a single click.
 * @param {string} reelId
 * @param {string} currentStatus
 */
async function toggleWatchedStatus(reelId, currentStatus) {
  const nextStatus = currentStatus === 'watched' ? 'unwatched' : 'watched';
  await updateReelStatus(reelId, nextStatus);
}

// ==============================================================================
// FULLSCREEN REELS VERTICAL SNAP-FEED LOGIC (Adaptive Aspect Framing)
// ==============================================================================

let feedIntersectionObserver = null;
const metaInFlightMap = new Map();
const MAX_CLIENT_META_CACHE = 500;
let metaRefreshSeq = 0;
const metaRefreshVersions = new Map();
const metaNoThumbExpiry = new Map();
let lastMetaRateLimitUntil = 0;

/**
 * Fetches server-side media kind & natural cover aspect ratio for a shortcode with structured status,
 * ref-counted cancellation, optional cache bypass for expired-cover refreshes, and full Retry-After tracking.
 * @param {string} shortcode
 * @param {AbortSignal} [signal]
 * @param {'p' | 'reel'} [preferredType]
 * @param {{ bypassCache?: boolean, requireThumbnail?: boolean }} [options]
 * @returns {Promise<{ status: 'ok' | 'rate_limited' | 'transient_error' | 'aborted', data: { isClips: boolean | null, mediaKind: string, thumbAspectRatio: number | null, thumbnailUrl: string | null } | null, retryAfterMs: number }>}
 */
async function fetchShortcodeMetaWithStatus(shortcode, signal, preferredType, options = {}) {
  const bypassCache = Boolean(options?.bypassCache);
  const requireThumbnail = Boolean(options?.requireThumbnail);
  if (!shortcode) return { status: 'transient_error', data: null, retryAfterMs: 0 };
  if (signal?.aborted) return { status: 'aborted', data: null, retryAfterMs: 0 };
  if (!bypassCache && state.metaCache.has(shortcode)) {
    const cached = state.metaCache.get(shortcode);
    if (!requireThumbnail || cached?.thumbnailUrl) {
      return { status: 'ok', data: cached, retryAfterMs: 0 };
    }
    const noThumbUntil = metaNoThumbExpiry.get(shortcode) || 0;
    if (noThumbUntil > Date.now()) {
      return { status: 'ok', data: cached, retryAfterMs: 0 };
    }
    metaNoThumbExpiry.delete(shortcode);
  }

  const inFlightKey = bypassCache
    ? `refresh:${shortcode}`
    : requireThumbnail
      ? `thumb:${shortcode}`
      : shortcode;
  let entry = metaInFlightMap.get(inFlightKey);
  if (entry?.controller.signal.aborted) {
    metaInFlightMap.delete(inFlightKey);
    entry = undefined;
  }

  if (!entry) {
    const controller = new AbortController();
    const startRefreshVersion = bypassCache
      ? ++metaRefreshSeq
      : (metaRefreshVersions.get(shortcode) || 0);
    const promise = (async () => {
      try {
        const params = new URLSearchParams();
        if (preferredType === 'p' || preferredType === 'reel') {
          params.set('type', preferredType);
        }
        if (bypassCache) {
          params.set('refresh', '1');
        }
        if (requireThumbnail) {
          params.set('thumb', '1');
        }
        const qs = params.toString() ? `?${params.toString()}` : '';
        const fetchOpts = (bypassCache || requireThumbnail)
          ? { signal: controller.signal, cache: 'no-store' }
          : { signal: controller.signal };
        const res = await fetch(`/api/reels/${encodeURIComponent(shortcode)}/meta${qs}`, fetchOpts);
        if (res.status === 429) {
          const retryAfterHeader = Number(res.headers.get('retry-after'));
          const retryMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? Math.max(2000, retryAfterHeader * 1000)
            : 5000;
          lastMetaRateLimitUntil = Math.max(lastMetaRateLimitUntil, Date.now() + retryMs);
          return { status: 'rate_limited', data: null, retryAfterMs: retryMs };
        }
        if (!res.ok) {
          return { status: 'transient_error', data: null, retryAfterMs: 0 };
        }
        const data = await res.json();
        if (data && (data.thumbnailUrl !== null || data.isClips !== null)) {
          const currentVersion = metaRefreshVersions.get(shortcode) || 0;
          const shouldCommitCache = bypassCache
            ? startRefreshVersion > currentVersion
            : startRefreshVersion === currentVersion;
          if (shouldCommitCache) {
            if (bypassCache && data.thumbnailUrl) {
              if (metaRefreshVersions.size >= MAX_CLIENT_META_CACHE && !metaRefreshVersions.has(shortcode)) {
                const oldestVersionKey = metaRefreshVersions.keys().next().value;
                if (oldestVersionKey) metaRefreshVersions.delete(oldestVersionKey);
              }
              metaRefreshVersions.set(shortcode, startRefreshVersion);
            }
            if (state.metaCache.size >= MAX_CLIENT_META_CACHE && !state.metaCache.has(shortcode)) {
              const oldestKey = state.metaCache.keys().next().value;
              if (oldestKey) state.metaCache.delete(oldestKey);
            }
            const existingClientCache = state.metaCache.get(shortcode);
            const preserveExistingCover = Boolean(
              !data.thumbnailUrl && existingClientCache?.thumbnailUrl
            );
            if (!preserveExistingCover) {
              state.metaCache.set(shortcode, data);
              if (data.thumbnailUrl) {
                metaNoThumbExpiry.delete(shortcode);
              } else {
                if (metaNoThumbExpiry.size >= MAX_CLIENT_META_CACHE && !metaNoThumbExpiry.has(shortcode)) {
                  const oldestNoThumb = metaNoThumbExpiry.keys().next().value;
                  if (oldestNoThumb) metaNoThumbExpiry.delete(oldestNoThumb);
                }
                metaNoThumbExpiry.set(shortcode, Date.now() + GRID_THUMB_UNAVAILABLE_TTL_MS);
              }
            }
          }
        }
        return { status: 'ok', data, retryAfterMs: 0 };
      } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) {
          return { status: 'aborted', data: null, retryAfterMs: 0 };
        }
        return { status: 'transient_error', data: null, retryAfterMs: 0 };
      } finally {
        if (metaInFlightMap.get(inFlightKey) === entry) {
          metaInFlightMap.delete(inFlightKey);
        }
      }
    })();

    entry = { promise, controller, waiters: 0 };
    metaInFlightMap.set(inFlightKey, entry);
  }

  entry.waiters++;
  let released = false;
  const releaseWaiter = () => {
    if (released) return;
    released = true;
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0) {
      entry.controller.abort();
    }
  };

  if (signal) {
    signal.addEventListener('abort', releaseWaiter, { once: true });
  }

  try {
    if (!signal) {
      return await entry.promise;
    }
    return await new Promise((resolve) => {
      const onAbort = () => resolve({ status: 'aborted', data: null, retryAfterMs: 0 });
      if (signal.aborted) {
        resolve({ status: 'aborted', data: null, retryAfterMs: 0 });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (outcome) => {
          signal.removeEventListener('abort', onAbort);
          resolve(signal.aborted ? { status: 'aborted', data: null, retryAfterMs: 0 } : outcome);
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve({ status: 'transient_error', data: null, retryAfterMs: 0 });
        }
      );
    });
  } finally {
    if (signal) {
      signal.removeEventListener('abort', releaseWaiter);
    }
    if (!released) {
      released = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
    }
  }
}

/**
 * Fetches server-side media kind & natural cover aspect ratio for a shortcode when DB thumbnail/efg is missing.
 * @param {string} shortcode
 * @param {AbortSignal} [signal]
 * @param {'p' | 'reel'} [preferredType]
 * @returns {Promise<{ isClips: boolean | null, mediaKind: string, thumbAspectRatio: number | null, thumbnailUrl: string | null } | null>}
 */
async function fetchShortcodeMeta(shortcode, signal, preferredType) {
  const outcome = await fetchShortcodeMetaWithStatus(shortcode, signal, preferredType);
  return outcome.status === 'ok' ? outcome.data : null;
}

// ==============================================================================
// LAZY VIEWPORT GRID THUMBNAIL HYDRATION (Archive-Imported & Expired Covers)
// ==============================================================================

const MAX_GRID_THUMB_CONCURRENCY = 3;
const MAX_GRID_UNAVAILABLE_TRACKED = 500;
const GRID_THUMB_UNAVAILABLE_TTL_MS = 60 * 1000;
const MAX_GRID_REPLACED_TRACKED = 500;
let gridThumbnailObserver = null;
let gridThumbAbortController = null;
let gridThumbGeneration = 0;
let gridThumbActiveCount = 0;
let gridThumbResumeTimer = null;
const gridThumbQueue = [];
let gridThumbQueuedCards = new WeakSet();
const gridCardHydrationMap = new WeakMap();
const gridThumbUnavailableShortcodes = new Map();
const gridThumbPendingRefresh = new Set();
const gridThumbWaitingCards = new Map();
const gridThumbRefreshedExpired = new Set();
const gridThumbReplacedUrls = new Map();

/**
 * Cancels all in-flight and queued grid thumbnail hydrations (e.g. on page change, filter, or vault switch).
 */
function resetGridThumbnailHydration() {
  gridThumbGeneration++;
  if (gridThumbResumeTimer) {
    clearTimeout(gridThumbResumeTimer);
    gridThumbResumeTimer = null;
  }
  if (gridThumbAbortController) {
    gridThumbAbortController.abort();
    gridThumbAbortController = null;
  }
  if (gridThumbnailObserver) {
    gridThumbnailObserver.disconnect();
    gridThumbnailObserver = null;
  }
  gridThumbQueue.length = 0;
  gridThumbQueuedCards = new WeakSet();
  gridThumbPendingRefresh.clear();
  gridThumbWaitingCards.clear();
  gridThumbActiveCount = 0;
}

/**
 * Adds a duplicate grid card to wait for an already-pending cover refresh of the same shortcode.
 * @param {string} shortcode
 * @param {object} waiterEntry
 */
function addGridThumbRefreshWaiter(shortcode, waiterEntry) {
  if (!shortcode || !waiterEntry?.card) return;
  let waiters = gridThumbWaitingCards.get(shortcode);
  if (!waiters) {
    waiters = new Set();
    gridThumbWaitingCards.set(shortcode, waiters);
  }
  waiters.add(waiterEntry);
}

/**
 * Releases a pending refresh marker and either hydrates waiting duplicate cards, promotes a connected waiter,
 * or clears waiters when the refresh failed.
 * @param {string} shortcode
 * @param {number} generation
 * @param {{ loadedMeta?: object, promoteWaiter?: boolean }} [options]
 */
function releasePendingGridThumbRefresh(shortcode, generation, options = {}) {
  gridThumbPendingRefresh.delete(shortcode);
  const waiters = gridThumbWaitingCards.get(shortcode);
  gridThumbWaitingCards.delete(shortcode);
  if (!waiters || waiters.size === 0 || generation !== gridThumbGeneration) return;
  if (options.loadedMeta) {
    for (const waiter of waiters) {
      if (waiter.card.isConnected && !waiter.card.classList.contains('has-thumbnail')) {
        applyHydratedGridThumbnail(waiter, options.loadedMeta, generation);
      }
    }
    return;
  }
  if (options.promoteWaiter && !isGridThumbUnavailable(shortcode)) {
    const connected = Array.from(waiters).filter(
      (w) => w.card.isConnected && !w.card.classList.contains('has-thumbnail')
    );
    if (connected.length > 0) {
      const [leader, ...rest] = connected;
      gridThumbPendingRefresh.add(shortcode);
      if (rest.length > 0) {
        gridThumbWaitingCards.set(shortcode, new Set(rest));
      }
      gridThumbQueuedCards.delete(leader.card);
      registerGridCardForThumbnailHydration(leader.card, leader.reel, leader.altText, leader.isPost, {
        bypassCache: true,
        failedUrl: leader.failedUrl,
        failedStoredUrl: leader.failedStoredUrl,
      });
    }
  }
}

/**
 * Returns true if a shortcode is currently within its negative-cache unavailable window.
 * @param {string} shortcode
 * @returns {boolean}
 */
function isGridThumbUnavailable(shortcode) {
  if (!shortcode) return false;
  const expiresAt = gridThumbUnavailableShortcodes.get(shortcode);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    gridThumbUnavailableShortcodes.delete(shortcode);
    return false;
  }
  return true;
}

/**
 * Tracks a shortcode whose cover metadata resolved empty or failed to load for the negative-cache window.
 * @param {string} shortcode
 */
function markGridThumbUnavailable(shortcode) {
  if (!shortcode) return;
  if (gridThumbUnavailableShortcodes.size >= MAX_GRID_UNAVAILABLE_TRACKED) {
    const oldest = gridThumbUnavailableShortcodes.keys().next().value;
    if (oldest) gridThumbUnavailableShortcodes.delete(oldest);
  }
  gridThumbUnavailableShortcodes.set(shortcode, Date.now() + GRID_THUMB_UNAVAILABLE_TTL_MS);
}

/**
 * Retains a verified replacement URL scoped to a failed stored URL so catalog reloads do not regress.
 * @param {string | null | undefined} failedStoredUrl
 * @param {string} replacementUrl
 */
function recordReplacedGridThumbUrl(failedStoredUrl, replacementUrl) {
  if (!failedStoredUrl || !replacementUrl || failedStoredUrl === replacementUrl) return;
  if (gridThumbReplacedUrls.size >= MAX_GRID_REPLACED_TRACKED) {
    const oldest = gridThumbReplacedUrls.keys().next().value;
    if (oldest) gridThumbReplacedUrls.delete(oldest);
  }
  gridThumbReplacedUrls.set(failedStoredUrl, replacementUrl);
}

/**
 * Builds a composite key scoping completed cover refreshes to both shortcode and the failed URL.
 * @param {string} shortcode
 * @param {string | null | undefined} failedUrl
 * @returns {string}
 */
function makeGridThumbRefreshKey(shortcode, failedUrl) {
  return `${shortcode}\0${failedUrl || ''}`;
}

/**
 * Returns true if the specific failed cover URL for a shortcode has already been refreshed.
 * @param {string} shortcode
 * @param {string | null | undefined} failedUrl
 * @returns {boolean}
 */
function hasRefreshedGridThumb(shortcode, failedUrl) {
  if (!shortcode) return false;
  return gridThumbRefreshedExpired.has(makeGridThumbRefreshKey(shortcode, failedUrl));
}

/**
 * Records a bounded completed cover refresh keyed by shortcode and failed cover URL.
 * @param {string} shortcode
 * @param {string | null | undefined} failedUrl
 */
function markRefreshedGridThumb(shortcode, failedUrl) {
  if (!shortcode) return;
  const key = makeGridThumbRefreshKey(shortcode, failedUrl);
  if (gridThumbRefreshedExpired.size >= MAX_GRID_REPLACED_TRACKED && !gridThumbRefreshedExpired.has(key)) {
    const oldest = gridThumbRefreshedExpired.values().next().value;
    if (oldest !== undefined) gridThumbRefreshedExpired.delete(oldest);
  }
  gridThumbRefreshedExpired.add(key);
}

/**
 * Registers a monogram grid poster card for lazy viewport thumbnail hydration.
 * @param {HTMLElement} card
 * @param {object} reel
 * @param {string} altText
 * @param {boolean} isPost
 * @param {{ bypassCache?: boolean, failedUrl?: string | null, failedStoredUrl?: string | null }} [options]
 */
function registerGridCardForThumbnailHydration(card, reel, altText, isPost, options = {}) {
  const shortcode = reel?.shortcode ? String(reel.shortcode).trim() : '';
  if (!card || !shortcode) return;
  gridCardHydrationMap.set(card, {
    card,
    reel,
    shortcode,
    altText,
    isPost,
    bypassCache: Boolean(options?.bypassCache),
    suppressRefreshRetry: Boolean(options?.suppressRefreshRetry),
    failedUrl: options?.failedUrl || null,
    failedStoredUrl: options?.failedStoredUrl || null,
    retriedAfter429: false,
    retriedAfterError: false,
  });
  if (state.viewMode !== 'grid' || !card.isConnected || isGridThumbUnavailable(shortcode)) return;
  if (gridThumbnailObserver) {
    gridThumbnailObserver.observe(card);
  } else {
    observeGridCardsForThumbnails();
  }
}

/**
 * Applies a freshly resolved thumbnail URL to a grid poster card, keeping the monogram visible until the image paints.
 * @param {{ card: HTMLElement, reel: object, shortcode: string, altText: string, isPost: boolean, failedUrl?: string | null, failedStoredUrl?: string | null, bypassCache?: boolean, suppressRefreshRetry?: boolean }} entry
 * @param {{ thumbnailUrl?: string | null, isClips?: boolean | null }} meta
 * @param {number} generation
 */
function applyHydratedGridThumbnail(entry, meta, generation) {
  const { card, reel, shortcode, altText, isPost, failedUrl, failedStoredUrl, bypassCache, suppressRefreshRetry } = entry;
  if (generation !== gridThumbGeneration) return;
  if (!card.isConnected) {
    if (bypassCache) releasePendingGridThumbRefresh(shortcode, generation, { promoteWaiter: true });
    return;
  }
  const cleanUrl = sanitizeMediaUrl(meta?.thumbnailUrl);
  if (!cleanUrl || isPlaceholderMediaUrl(cleanUrl)) {
    if (bypassCache) releasePendingGridThumbRefresh(shortcode, generation);
    markGridThumbUnavailable(shortcode);
    return;
  }

  const mediaBox = card.querySelector('.poster-media-box');
  if (!mediaBox) {
    if (bypassCache) releasePendingGridThumbRefresh(shortcode, generation, { promoteWaiter: true });
    return;
  }

  // Remove any previously hidden broken img before mounting the fresh cover
  mediaBox.querySelectorAll('.poster-actual-img').forEach((node) => node.remove());

  const img = document.createElement('img');
  img.className = 'poster-actual-img';
  img.referrerPolicy = 'no-referrer';
  img.alt = altText;
  img.loading = 'eager';

  let revealed = false;
  const revealLoadedCover = () => {
    if (revealed || generation !== gridThumbGeneration || !card.isConnected) return;
    revealed = true;
    if (bypassCache) {
      markRefreshedGridThumb(shortcode, failedUrl || failedStoredUrl);
      releasePendingGridThumbRefresh(shortcode, generation, { loadedMeta: meta });
    }
    reel.thumbnail_url = cleanUrl;
    if (failedStoredUrl) {
      recordReplacedGridThumbUrl(failedStoredUrl, cleanUrl);
    }
    if (!mediaBox.querySelector('.poster-top-scrim')) {
      const topScrim = document.createElement('div');
      topScrim.className = 'poster-top-scrim';
      img.insertAdjacentElement('afterend', topScrim);
    }
    if (!mediaBox.querySelector(':scope > .poster-bottom-scrim')) {
      const bottomScrim = document.createElement('div');
      bottomScrim.className = 'poster-bottom-scrim';
      const topScrim = mediaBox.querySelector('.poster-top-scrim');
      (topScrim || img).insertAdjacentElement('afterend', bottomScrim);
    }
    const cueThumb = card.querySelector('.poster-cue-thumb');
    if (cueThumb) {
      cueThumb.textContent = (isPost || meta?.isClips === false) ? 'Open' : 'Watch';
    }
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      state.thumbRatioCache.set(shortcode, img.naturalWidth / img.naturalHeight);
    }
    card.classList.remove('is-monogram');
    card.classList.add('has-thumbnail');
    card.querySelector('.monochrome-poster-art')?.setAttribute('aria-hidden', 'true');
    requestAnimationFrame(() => {
      if (img.isConnected) img.classList.add('is-loaded');
    });
  };

  img.addEventListener('load', revealLoadedCover, { once: true });
  img.addEventListener('error', () => {
    img.remove();
    if (generation !== gridThumbGeneration) return;
    if (bypassCache) {
      releasePendingGridThumbRefresh(shortcode, generation);
    }
    if (!card.isConnected) return;
    card.classList.remove('has-thumbnail');
    card.classList.add('is-monogram');
    card.querySelector('.monochrome-poster-art')?.removeAttribute('aria-hidden');
    if (
      !bypassCache &&
      !suppressRefreshRetry &&
      !hasRefreshedGridThumb(shortcode, cleanUrl) &&
      !isGridThumbUnavailable(shortcode)
    ) {
      if (gridThumbPendingRefresh.has(shortcode)) {
        addGridThumbRefreshWaiter(shortcode, {
          card,
          reel,
          shortcode,
          altText,
          isPost,
          bypassCache: false,
          suppressRefreshRetry: true,
          failedUrl: cleanUrl,
          failedStoredUrl: failedStoredUrl || null,
        });
        return;
      }
      const cachedMeta = state.metaCache.get(shortcode);
      if (cachedMeta && sanitizeMediaUrl(cachedMeta.thumbnailUrl) === cleanUrl) {
        state.metaCache.delete(shortcode);
      }
      gridThumbPendingRefresh.add(shortcode);
      gridThumbQueuedCards.delete(card);
      registerGridCardForThumbnailHydration(card, reel, altText, isPost, {
        bypassCache: true,
        failedUrl: cleanUrl,
        failedStoredUrl: failedStoredUrl || null,
      });
      return;
    }
    markGridThumbUnavailable(shortcode);
  }, { once: true });

  const monogramArt = mediaBox.querySelector('.monochrome-poster-art');
  if (monogramArt) {
    monogramArt.insertAdjacentElement('afterend', img);
  } else {
    mediaBox.prepend(img);
  }
  img.src = cleanUrl;
  if (img.complete && img.naturalWidth > 0) {
    revealLoadedCover();
  }
}

/**
 * Drains queued visible grid cards up to MAX_GRID_THUMB_CONCURRENCY, respecting 429 Retry-After pauses.
 */
function drainGridThumbnailQueue() {
  if (state.viewMode !== 'grid') return;
  const generation = gridThumbGeneration;
  const now = Date.now();
  if (lastMetaRateLimitUntil > now) {
    if (!gridThumbResumeTimer && gridThumbQueue.length > 0) {
      const waitMs = Math.min(15000, Math.max(500, lastMetaRateLimitUntil - now));
      gridThumbResumeTimer = setTimeout(() => {
        gridThumbResumeTimer = null;
        if (generation === gridThumbGeneration) {
          drainGridThumbnailQueue();
        }
      }, waitMs);
    }
    return;
  }

  if (!gridThumbAbortController) {
    gridThumbAbortController = new AbortController();
  }
  const signal = gridThumbAbortController.signal;

  while (gridThumbActiveCount < MAX_GRID_THUMB_CONCURRENCY && gridThumbQueue.length > 0) {
    const entry = gridThumbQueue.shift();
    if (!entry || !entry.card.isConnected || entry.card.classList.contains('has-thumbnail')) {
      if (entry?.bypassCache) {
        releasePendingGridThumbRefresh(entry.shortcode, generation, { promoteWaiter: true });
      }
      continue;
    }
    if (isGridThumbUnavailable(entry.shortcode)) {
      if (entry.bypassCache) {
        releasePendingGridThumbRefresh(entry.shortcode, generation);
      }
      continue;
    }

    gridThumbActiveCount++;
    const preferredType = entry.isPost ? 'p' : 'reel';

    fetchShortcodeMetaWithStatus(entry.shortcode, signal, preferredType, {
      bypassCache: entry.bypassCache,
      requireThumbnail: true,
    })
      .then((outcome) => {
        if (generation !== gridThumbGeneration) return;
        if (signal.aborted || outcome.status === 'aborted') {
          if (entry.bypassCache) {
            releasePendingGridThumbRefresh(entry.shortcode, generation);
          }
          return;
        }
        if (outcome.status === 'ok') {
          if (outcome.data && outcome.data.thumbnailUrl) {
            applyHydratedGridThumbnail(entry, outcome.data, generation);
          } else {
            if (entry.bypassCache) {
              releasePendingGridThumbRefresh(entry.shortcode, generation);
            }
            markGridThumbUnavailable(entry.shortcode);
          }
          return;
        }
        if (outcome.status === 'rate_limited') {
          if (!entry.retriedAfter429) {
            entry.retriedAfter429 = true;
            gridThumbQueue.unshift(entry);
          } else if (entry.bypassCache) {
            releasePendingGridThumbRefresh(entry.shortcode, generation);
          }
          return;
        }
        // Transient non-429 error (e.g. 503/network blip): separate bounded retry without consuming 429 quota
        if (!entry.retriedAfterError) {
          entry.retriedAfterError = true;
          gridThumbQueue.push(entry);
        } else {
          gridThumbQueuedCards.delete(entry.card);
          if (entry.bypassCache) {
            releasePendingGridThumbRefresh(entry.shortcode, generation);
          }
        }
      })
      .finally(() => {
        if (generation !== gridThumbGeneration) return;
        gridThumbActiveCount = Math.max(0, gridThumbActiveCount - 1);
        drainGridThumbnailQueue();
      });
  }
}

/**
 * Attaches an IntersectionObserver to rendered monogram grid cards so only visible (and near-viewport) cards hydrate covers.
 */
function observeGridCardsForThumbnails() {
  if (state.viewMode !== 'grid' || !reelsGrid) return;
  const cards = Array.from(reelsGrid.querySelectorAll('.vault-poster-card.is-monogram'));
  const pendingCards = cards.filter((card) => {
    const entry = gridCardHydrationMap.get(card);
    return Boolean(entry && !isGridThumbUnavailable(entry.shortcode));
  });
  if (pendingCards.length === 0) return;

  if (!gridThumbAbortController) {
    gridThumbAbortController = new AbortController();
  }

  if (typeof IntersectionObserver !== 'function') {
    for (const card of pendingCards.slice(0, 8)) {
      const entry = gridCardHydrationMap.get(card);
      if (entry && !gridThumbQueuedCards.has(card)) {
        gridThumbQueuedCards.add(card);
        gridThumbQueue.push(entry);
      }
    }
    drainGridThumbnailQueue();
    return;
  }

  if (gridThumbnailObserver) {
    gridThumbnailObserver.disconnect();
  }
  const obsGeneration = gridThumbGeneration;
  gridThumbnailObserver = new IntersectionObserver((entries, obs) => {
    if (obs !== gridThumbnailObserver || obsGeneration !== gridThumbGeneration || state.viewMode !== 'grid') {
      return;
    }
    let added = false;
    for (const obsEntry of entries) {
      if (!obsEntry.isIntersecting) continue;
      const card = obsEntry.target;
      obs.unobserve(card);
      const data = gridCardHydrationMap.get(card);
      if (!data || gridThumbQueuedCards.has(card) || card.classList.contains('has-thumbnail')) {
        continue;
      }
      gridThumbQueuedCards.add(card);
      gridThumbQueue.push(data);
      added = true;
    }
    if (added) {
      drainGridThumbnailQueue();
    }
  }, {
    root: null,
    rootMargin: '200px 0px',
    threshold: 0.01,
  });

  for (const card of pendingCards) {
    gridThumbnailObserver.observe(card);
  }
}

/**
 * Resolves the best known aspect classification inputs for a reel slide.
 * @param {object} reel
 */
function getSlideAspectInput(reel) {
  const shortcode = reel?.shortcode || '';
  const cached = state.aspectCache.get(shortcode);
  const serverMeta = state.metaCache.get(shortcode);
  const cleanThumb = sanitizeMediaUrl(reel?.thumbnail_url);
  const thumbMeta = ReelerGeometry.parseThumbMeta(cleanThumb);
  const savedTypeHint = getSavedMediaType(reel) === 'post' ? false : null;

  return {
    embedRatio: cached?.embedRatio ?? null,
    isClips: cached?.isClips ?? serverMeta?.isClips ?? thumbMeta.isClips ?? savedTypeHint,
    thumbAspectRatio: cached?.thumbAspectRatio ?? serverMeta?.thumbAspectRatio ?? state.thumbRatioCache.get(shortcode) ?? null,
  };
}

/**
 * Computes and applies adaptive container, control-dock width, action rail, and unscaled iframe geometry.
 * @param {HTMLElement} slide
 * @param {object} reel
 * @param {{ embedRatio?: number | null, isClips?: boolean | null, thumbAspectRatio?: number | null }} [overrideInput]
 */
function applySlideStage(slide, reel, overrideInput) {
  if (!slide || !reel) return null;
  const input = overrideInput || getSlideAspectInput(reel);
  const stage = ReelerGeometry.computeAdaptiveStage({
    embedRatio: input.embedRatio ?? null,
    isClips: input.isClips ?? null,
    thumbAspectRatio: input.thumbAspectRatio ?? null,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  slide.classList.toggle('is-side-dock', Boolean(stage.useSideDock));
  slide.classList.toggle('is-docked-meta', stage.useDockedMeta);
  slide.classList.toggle('is-compact-rail', stage.useCompactRail);

  const wrapper = slide.querySelector('.reel-stage-wrapper');
  const slot = slide.querySelector('.reel-media-slot');
  const viewport = slide.querySelector('.reel-media-viewport');
  const iframe = slide.querySelector('.reel-player-iframe');
  const overlay = slide.querySelector('.reel-overlay-content');

  if (wrapper) {
    wrapper.style.width = stage.useSideDock ? 'auto' : `${stage.controlsW}px`;
  }
  if (slot) {
    slot.style.width = stage.useSideDock ? 'auto' : `${stage.viewW}px`;
    slot.style.height = stage.useSideDock ? 'auto' : `${stage.viewH}px`;
  }
  if (overlay) {
    overlay.style.width = stage.useSideDock ? `${stage.sideDockMetaW}px` : '';
  }
  if (viewport) {
    viewport.style.width = `${stage.viewW}px`;
    viewport.style.height = `${stage.viewH}px`;
  }
  if (iframe && iframe.dataset.probing !== '1') {
    iframe.style.width = `${stage.iframeW}px`;
    iframe.style.height = `${stage.iframeH}px`;
    iframe.style.left = `${stage.iframeLeft}px`;
    iframe.style.top = `${stage.iframeTop}px`;
  }

  return stage;
}

/**
 * Upgrades or sets the poster underlay image inside a slide viewport if a working URL becomes available.
 * @param {HTMLElement} slide
 * @param {object} reel
 * @param {string} url
 * @param {{ recordRatio?: boolean }} [options]
 */
function setSlidePosterUrl(slide, reel, url, { recordRatio = true } = {}) {
  const viewport = slide?.querySelector('.reel-media-viewport');
  const shortcode = reel?.shortcode || '';
  if (!viewport || !url) return;
  let posterImg = viewport.querySelector('.reel-poster-underlay');
  if (!posterImg) {
    posterImg = document.createElement('img');
    posterImg.referrerPolicy = 'no-referrer';
    posterImg.className = 'reel-poster-underlay';
    posterImg.alt = '';
    posterImg.setAttribute('aria-hidden', 'true');
    const iframeBox = viewport.querySelector('.reel-iframe-container');
    viewport.insertBefore(posterImg, iframeBox || null);
  }
  posterImg.hidden = false;
  posterImg.classList.remove('is-loaded');

  const onPosterLoad = () => {
    posterImg.classList.add('is-loaded');
    if (recordRatio && posterImg.naturalWidth > 0 && posterImg.naturalHeight > 0 && shortcode) {
      state.thumbRatioCache.set(shortcode, posterImg.naturalWidth / posterImg.naturalHeight);
      const iframe = slide.querySelector('.reel-player-iframe');
      if (!iframe || iframe.dataset.probing === '1') {
        applySlideStage(slide, reel);
      }
    }
  };

  posterImg.src = url;
  if (posterImg.complete && posterImg.naturalWidth > 0) {
    onPosterLoad();
  } else {
    posterImg.addEventListener('load', onPosterLoad, { once: true });
  }
  posterImg.addEventListener('error', () => {
    posterImg.hidden = true;
    posterImg.classList.remove('is-loaded');
  }, { once: true });
}

/**
 * Cleanly unmounts any active embed iframe, timers, and message listeners inside an iframe container.
 * @param {HTMLElement | null} iframeBox
 */
function unmountSlideIframe(iframeBox) {
  if (!iframeBox) return;
  if (typeof iframeBox.__cleanup === 'function') {
    iframeBox.__cleanup();
    iframeBox.__cleanup = null;
  }
  const focusBtn = iframeBox.closest('.reel-media-viewport')?.querySelector('[data-action="focus-embed-player"]');
  if (focusBtn) {
    focusBtn.hidden = false;
    focusBtn.disabled = true;
  }
  if (iframeBox.firstChild) {
    iframeBox.innerHTML = '';
  }
}

/**
 * Mounts an Instagram embed iframe and dynamically measures its true media aspect ratio
 * using two-width MEASURE events before revealing the player at exact 1:1 unscaled framing.
 * Displays a delayed probe pill if slow, and surfaces a fallback card if the embed fails to mount.
 * @param {HTMLElement} slide
 * @param {object} reel
 */
function mountFeedIframe(slide, reel) {
  const iframeBox = slide?.querySelector('.reel-iframe-container');
  if (!iframeBox || !reel?.shortcode || iframeBox.querySelector('iframe')) return;

  unmountSlideIframe(iframeBox);

  const shortcode = reel.shortcode;
  const cached = state.aspectCache.get(shortcode);
  const cleanThumb = sanitizeMediaUrl(reel.thumbnail_url);
  const hasRealThumbnail = Boolean(cleanThumb && !isPlaceholderMediaUrl(cleanThumb));
  const thumbMeta = ReelerGeometry.parseThumbMeta(cleanThumb);
  const preferredType = getSavedMediaType(reel) === 'post' ? 'p' : 'reel';
  const savedTypeHint = preferredType === 'p' ? false : null;

  let knownIsClips = cached?.isClips ?? state.metaCache.get(shortcode)?.isClips ?? thumbMeta.isClips ?? savedTypeHint;
  let knownThumbRatio = cached?.thumbAspectRatio ?? state.metaCache.get(shortcode)?.thumbAspectRatio ?? state.thumbRatioCache.get(shortcode) ?? null;

  const viewport = slide.querySelector('.reel-media-viewport');
  const posterImg = slide.querySelector('.reel-poster-underlay');
  const posterBroken = posterImg && posterImg.hidden;
  const probeIndicator = slide.querySelector('.reel-probe-indicator');
  const fallbackBox = slide.querySelector('.reel-embed-fallback');
  const focusPlayerBtn = slide.querySelector('[data-action="focus-embed-player"]');
  if (probeIndicator) probeIndicator.classList.remove('is-visible');
  if (fallbackBox) fallbackBox.hidden = true;
  if (focusPlayerBtn) {
    focusPlayerBtn.hidden = false;
    focusPlayerBtn.disabled = true;
  }
  if (viewport) viewport.scrollTop = 0;
  iframeBox.scrollTop = 0;

  const originParam = encodeURIComponent(window.location.origin || '');
  const pathParam = encodeURIComponent((window.location.pathname || '/').substring(0, 100));
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/?cr=1&rd=${originParam}&rp=${pathParam}`;
  iframe.className = 'reel-player-iframe';
  iframe.tabIndex = -1;
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('loading', 'eager');
  const frameCreator = getCreatorDisplayInfo(reel.creator);
  iframe.setAttribute(
    'title',
    frameCreator.isAttributedName ? `Instagram post by ${frameCreator.accessibleName}` : 'Embedded Instagram post'
  );
  let iframeLoaded = false;
  iframe.addEventListener('load', () => {
    iframeLoaded = true;
  });
  iframe.addEventListener('error', () => {
    finalizeAndReveal(null, false, 0, true);
  }, { once: true });

  const abortController = new AbortController();
  let metaPromise = null;
  if (knownIsClips === null || !hasRealThumbnail || posterBroken) {
    metaPromise = fetchShortcodeMeta(shortcode, abortController.signal, preferredType).then((meta) => {
      if (!meta || abortController.signal.aborted) return meta;
      if (knownIsClips === null && meta.isClips !== undefined) {
        knownIsClips = meta.isClips;
      }
      if (knownThumbRatio === null && typeof meta.thumbAspectRatio === 'number') {
        knownThumbRatio = meta.thumbAspectRatio;
      }
      const currentPoster = slide.querySelector('.reel-poster-underlay');
      const nowBroken = !currentPoster || currentPoster.hidden;
      if (meta.thumbnailUrl && (!hasRealThumbnail || nowBroken)) {
        setSlidePosterUrl(slide, reel, meta.thumbnailUrl, { recordRatio: meta.isClips === true });
      }
      const slideIdx = parseInt(slide.getAttribute('data-index') || '-1', 10);
      if (feedModal.classList.contains('active') && slideIdx === state.currentFeedIndex && feedCounterKicker) {
        feedCounterKicker.textContent = formatFeedCounterKicker(reel, slideIdx, state.reels.length);
      }
      if (iframe.dataset.probing === '1') {
        applySlideStage(slide, reel, {
          embedRatio: null,
          isClips: knownIsClips,
          thumbAspectRatio: knownThumbRatio,
        });
      }
      return meta;
    });
  }

  let settled = false;
  let phase = cached?.embedRatio ? 'cached' : 'w1';
  let mounted = false;
  let h1 = null;
  let safetyTimer = null;
  let revealTimer = null;
  let probeIndicatorTimer = null;

  if (probeIndicator && phase !== 'cached') {
    probeIndicatorTimer = setTimeout(() => {
      if (!settled && !abortController.signal.aborted) {
        probeIndicator.classList.add('is-visible');
      }
    }, 900);
  }

  /**
   * Clears temporary loading indicators once probing settles or aborts.
   */
  const clearProbeUi = () => {
    if (probeIndicatorTimer) {
      clearTimeout(probeIndicatorTimer);
      probeIndicatorTimer = null;
    }
    if (probeIndicator) {
      probeIndicator.classList.remove('is-visible');
    }
  };

  /**
   * Applies final geometry, persists cache when measured cleanly, and reveals the iframe or fallback.
   * @param {number | null} embedRatio
   * @param {boolean} persist
   * @param {number} [settleDelayMs=0]
   * @param {boolean} [showFallback=false]
   */
  const finalizeAndReveal = (embedRatio, persist, settleDelayMs = 0, showFallback = false) => {
    if (settled || abortController.signal.aborted) return;
    delete iframe.dataset.probing;
    clearProbeUi();

    if (showFallback && !mounted && fallbackBox) {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (focusPlayerBtn) {
        focusPlayerBtn.hidden = true;
        focusPlayerBtn.disabled = true;
      }
      iframe.hidden = true;
      fallbackBox.hidden = false;

      // Late recovery: if a slow frame completes load or emits a message late, replace fallback and reveal
      const onLateRecover = () => {
        if (abortController.signal.aborted) return;
        iframeLoaded = true;
        fallbackBox.hidden = true;
        iframe.hidden = false;
        settled = false;
        finalizeAndReveal(cached?.embedRatio ?? null, false, 40, false);
      };

      iframe.addEventListener('load', onLateRecover, { once: true });
      return;
    }

    settled = true;

    if (persist && typeof embedRatio === 'number') {
      persistAspectCacheEntry(shortcode, {
        embedRatio,
        isClips: knownIsClips,
        thumbAspectRatio: knownThumbRatio,
      });
    }

    const stage = applySlideStage(slide, reel, {
      embedRatio,
      isClips: knownIsClips,
      thumbAspectRatio: knownThumbRatio,
    });

    /**
     * Marks the embed iframe visible after geometry settles while keeping Tab traversal
     * isolated until the user explicitly activates `.feed-focus-player-btn`.
     */
    const revealNow = () => {
      revealTimer = null;
      if (!abortController.signal.aborted) {
        iframe.tabIndex = -1;
        iframe.classList.add('is-ready');
        if (focusPlayerBtn) {
          focusPlayerBtn.hidden = false;
          focusPlayerBtn.disabled = false;
        }
        if (viewport) viewport.scrollTop = 0;
        iframeBox.scrollTop = 0;
      }
    };

    const waitMs = stage && settleDelayMs > 0 && stage.iframeW !== ReelerGeometry.PROBE_WIDTH_2
      ? settleDelayMs
      : (settleDelayMs > 0 ? 48 : 0);

    cleanupListeners();

    if (waitMs > 0) {
      revealTimer = setTimeout(revealNow, waitMs);
    } else {
      requestAnimationFrame(revealNow);
    }
  };

  /**
   * Handles incoming Instagram embed postMessages during cached mount and two-width MEASURE probing.
   * @param {MessageEvent} event
   */
  const onMessage = async (event) => {
    if (event.source !== iframe.contentWindow) return;
    if (!/^https:\/\/(?:www\.)?instagram\.com$/i.test(event.origin)) return;

    const msg = ReelerGeometry.parseEmbedMessage(event.data);
    if (!msg) return;

    // Any valid postMessage from Instagram confirms the frame is mounted
    mounted = true;

    if (fallbackBox && !fallbackBox.hidden) {
      fallbackBox.hidden = true;
      iframe.hidden = false;
      settled = false;
      finalizeAndReveal(cached?.embedRatio ?? null, false, 40, false);
      return;
    }

    if (phase === 'cached') {
      finalizeAndReveal(cached.embedRatio, false, 40, false);
      return;
    }

    if (phase === 'aborted') {
      finalizeAndReveal(cached?.embedRatio ?? null, false, 40, false);
      return;
    }

    if (phase === 'w1') {
      if (msg.height && msg.height > 150) {
        h1 = msg.height;
        phase = 'w2';
        iframe.style.width = `${ReelerGeometry.PROBE_WIDTH_2}px`;
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = setTimeout(() => {
            phase = 'aborted';
            finalizeAndReveal(null, false, 0, false);
          }, 3500);
        }
      }
      return;
    }

    if (phase === 'w2' && msg.type === 'MEASURE' && msg.height) {
      const measuredRatio = ReelerGeometry.computeEmbedRatioFromHeights(
        ReelerGeometry.PROBE_WIDTH_1,
        h1,
        ReelerGeometry.PROBE_WIDTH_2,
        msg.height
      );
      if (measuredRatio === null) {
        return; // Ignore stale W1 MEASURE event
      }

      phase = 'done';
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (measuredRatio >= 0.76 && measuredRatio <= 0.84 && knownIsClips === null && metaPromise) {
        await Promise.race([
          metaPromise,
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      }

      finalizeAndReveal(measuredRatio, true, 80, false);
    }
  };

  /**
   * Removes window message listener and cancels the safety timeout for this embed instance.
   */
  function cleanupListeners() {
    window.removeEventListener('message', onMessage);
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  /**
   * Aborts pending fetches, clears reveal/probe timers, and detaches listeners on unmount.
   */
  iframeBox.__cleanup = () => {
    abortController.abort();
    clearProbeUi();
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    cleanupListeners();
  };

  window.addEventListener('message', onMessage);

  if (phase === 'cached') {
    applySlideStage(slide, reel, cached);
    const stage = ReelerGeometry.computeAdaptiveStage({
      embedRatio: cached.embedRatio,
      isClips: knownIsClips,
      thumbAspectRatio: knownThumbRatio,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    iframe.style.width = `${stage.iframeW}px`;
    iframe.style.height = `${stage.iframeH}px`;
    iframe.style.left = `${stage.iframeLeft}px`;
    iframe.style.top = `${stage.iframeTop}px`;
    iframeBox.appendChild(iframe);

    safetyTimer = setTimeout(() => {
      finalizeAndReveal(cached.embedRatio, false, 0, !mounted && !iframeLoaded);
    }, 2500);
  } else {
    iframe.dataset.probing = '1';
    iframe.style.width = `${ReelerGeometry.PROBE_WIDTH_1}px`;
    iframe.style.height = '1500px';
    iframe.style.left = '0px';
    iframe.style.top = `-${ReelerGeometry.HEADER_CLIP_PX}px`;
    iframeBox.appendChild(iframe);

    safetyTimer = setTimeout(() => {
      phase = 'aborted';
      finalizeAndReveal(null, false, 0, !mounted && !iframeLoaded);
    }, 6500);
  }
}

/**
 * Marks non-active feed slides inert and resets embed iframe tabIndex so keyboard Tab traversal
 * moves cleanly through modal controls without trapping focus inside offscreen or unrequested iframes.
 * @param {number} activeIndex
 */
function syncActiveSlideInert(activeIndex) {
  const slides = feedScrollTrack.querySelectorAll('.feed-reel-slide');
  slides.forEach((slideEl) => {
    const slideIdx = parseInt(slideEl.getAttribute('data-index') || '-1', 10);
    const isInert = slideIdx !== activeIndex;
    slideEl.inert = isInert;
    if (isInert) {
      slideEl.querySelectorAll('iframe.reel-player-iframe').forEach((frame) => {
        frame.tabIndex = -1;
      });
    }
  });
}

/**
 * Builds an accessible 100dvh reel slide with adaptive framing and action rail.
 * @param {object} reel
 * @param {number} index
 * @returns {HTMLElement}
 */
function createFeedSlide(reel, index) {
  const effectiveStatus = pendingStatusValues.has(reel.id) ? pendingStatusValues.get(reel.id) : reel.watch_status;
  const isPending = pendingStatusIds.has(reel.id);
  const isBotSent = reel.is_saved_on_instagram === false;
  const isPost = getSavedMediaType(reel) === 'post';
  const itemWord = isPost ? 'post' : 'reel';
  const itemBadgeTitle = isPost ? 'Post' : 'Reel';
  const feedMonogramFallback = isBotSent
    ? (isPost ? 'Bot Post' : 'Bot Reel')
    : (isPost ? 'Saved Post' : 'Saved Reel');
  const feedSourcePill = isBotSent ? '<span class="feed-source-pill is-bot">Sent to Bot</span>' : '';
  const creatorInfo = getCreatorDisplayInfo(reel.creator);
  const ariaTarget = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `this ${itemWord}`;
  const safeCreator = escapeHtml(creatorInfo.displayText);
  const safeReelUrl = escapeHtml(sanitizeExternalHref(reel.reel_url, 'https://www.instagram.com/'));
  const safeCreatorHref = escapeHtml(getSafeCreatorProfileHref(reel.creator, reel.reel_url));
  const creatorLinkTitle = escapeHtml(
    creatorInfo.hasPublicHandle
      ? `Open ${creatorInfo.displayText}'s profile on Instagram`
      : (creatorInfo.isAttributedName
        ? `Open ${creatorInfo.displayText}'s ${itemWord} on Instagram`
        : `Open ${itemWord} on Instagram`)
  );
  const { initial } = creatorInfo;
  const isWatchLater = effectiveStatus === 'watch_later';
  const isWatched = effectiveStatus === 'watched';
  const cleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
  const hasRealThumbnail = Boolean(cleanThumbnail && !isPlaceholderMediaUrl(cleanThumbnail));
  const dateInfo = getReelDisplayDate(reel);
  const dateFormatted = formatShortDate(dateInfo.iso);
  const cleanSlideCaption = stripPrivateUseChars(reel.caption).trim();
  const captionText = cleanSlideCaption || `No caption available for this ${itemWord}.`;

  const slide = document.createElement('div');
  slide.className = 'feed-reel-slide';
  slide.setAttribute('data-reel-id', reel.id);
  slide.setAttribute('data-index', String(index));
  slide.inert = index !== state.currentFeedIndex;

  slide.innerHTML = `
    <div class="reel-stage-wrapper">
      <div class="reel-media-slot">
        <div class="reel-media-viewport">
          <div class="reel-monogram-underlay" aria-hidden="true">
            <div class="feed-monogram-circle">${initial}</div>
            <div class="feed-monogram-handle">${creatorInfo.isAttributedName ? safeCreator : feedMonogramFallback}</div>
          </div>
          <div class="reel-probe-indicator" aria-hidden="true">
            <span class="reel-probe-spinner"></span>
            <span>Preparing player...</span>
          </div>
          <div class="reel-embed-fallback" hidden>
            <p class="reel-fallback-msg">Instagram embed did not load in this frame.</p>
            <div class="reel-embed-fallback-actions">
              <button type="button" class="nav-btn nav-btn-secondary" data-action="retry-embed">Retry Embed</button>
              <a href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" class="nav-btn nav-btn-primary">Open on Instagram</a>
            </div>
          </div>
          <button type="button" class="feed-focus-player-btn" data-action="focus-embed-player" disabled>${isPost ? 'Focus Instagram post embed' : 'Focus video player'}</button>
          <!-- Boundary-Masked Clean Iframe Container (Zero white Instagram chrome) -->
          <div class="reel-iframe-container" id="feed-iframe-box-${reel.id}"></div>
        </div>

        <!-- Adaptive Action Rail (Right Side on Desktop / Horizontal Strip on Compact) -->
        <div class="reel-actions-rail">
          <div class="rail-action-item">
            <button type="button" class="rail-action-btn ${isWatched ? 'active-watched' : ''}" data-action="feed-toggle-watched" title="${escapeHtml(getStatusPillTitle(effectiveStatus))} (w)" aria-label="${escapeHtml(getStatusPillTitle(effectiveStatus))}" aria-pressed="${isWatched}"${isPending ? ' disabled aria-busy="true"' : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </button>
            <span class="rail-action-sublabel">Watched</span>
          </div>

          <div class="rail-action-item">
            <button type="button" class="rail-action-btn ${isWatchLater ? 'active-later' : ''}" data-action="feed-toggle-later" title="${escapeHtml(getLaterButtonTitle(effectiveStatus, 'feed'))}" aria-label="${escapeHtml(getLaterButtonAriaLabel(effectiveStatus, ariaTarget, 'feed'))}" aria-pressed="${isWatchLater}"${isPending ? ' disabled aria-busy="true"' : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
            </button>
            <span class="rail-action-sublabel">Later</span>
          </div>

          <div class="rail-action-item">
            <button type="button" class="rail-action-btn" data-action="feed-copy-link" title="Copy ${itemBadgeTitle} Link (c)" aria-label="Copy ${itemBadgeTitle} Link">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <span class="rail-action-sublabel copy-label">Copy</span>
          </div>

          <div class="rail-action-item">
            <a href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" class="rail-action-btn" title="Open on Instagram" aria-label="Open in Instagram">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
            <span class="rail-action-sublabel">Open</span>
          </div>
        </div>
      </div>

      <!-- Overlay / Docked Details -->
      <div class="reel-overlay-content">
        <div class="reel-overlay-creator">
          <div class="reel-creator-avatar" aria-hidden="true">${initial}</div>
          <div class="reel-creator-meta">
            <a href="${safeCreatorHref}" target="_blank" rel="noopener noreferrer" class="reel-creator-handle" title="${creatorLinkTitle}"><span class="handle-text">${safeCreator}</span></a>
            <span class="reel-saved-badge">${dateInfo.labelPrefix} ${dateFormatted}${feedSourcePill}</span>
          </div>
        </div>
        <div class="reel-caption-wrap" id="caption-wrap-${reel.id}">
          <p class="reel-caption-text">${escapeHtml(captionText)}</p>
          ${captionText.length > 90 ? '<button type="button" class="reel-caption-toggle" data-action="toggle-caption" aria-label="Expand caption" aria-expanded="false">more</button>' : ''}
        </div>
      </div>
    </div>
  `;

  if (hasRealThumbnail) {
    setSlidePosterUrl(slide, reel, cleanThumbnail, { recordRatio: true });
  }

  applySlideStage(slide, reel);

  slide.addEventListener('click', async (e) => {
    const toggleCaptionBtn = e.target.closest('[data-action="toggle-caption"]');
    if (toggleCaptionBtn) {
      const wrap = slide.querySelector('.reel-caption-wrap');
      const isExp = wrap.classList.toggle('expanded');
      toggleCaptionBtn.textContent = isExp ? 'less' : 'more';
      toggleCaptionBtn.setAttribute('aria-label', isExp ? 'Collapse caption' : 'Expand caption');
      toggleCaptionBtn.setAttribute('aria-expanded', String(isExp));
      return;
    }

    const watchedBtn = e.target.closest('[data-action="feed-toggle-watched"]');
    if (watchedBtn) {
      const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
      const newStatus = latestStatus === 'watched' ? 'unwatched' : 'watched';
      await updateReelStatus(reel.id, newStatus);
      return;
    }

    const laterBtn = e.target.closest('[data-action="feed-toggle-later"]');
    if (laterBtn) {
      const latestStatus = state.reels.find((r) => r.id === reel.id)?.watch_status || reel.watch_status;
      const newStatus = latestStatus === 'watch_later' ? 'unwatched' : 'watch_later';
      await updateReelStatus(reel.id, newStatus);
      return;
    }

    const copyBtn = e.target.closest('[data-action="feed-copy-link"]');
    if (copyBtn) {
      await copySlideLink(slide, reel);
      return;
    }

    const retryEmbedBtn = e.target.closest('[data-action="retry-embed"]');
    if (retryEmbedBtn) {
      const fallback = slide.querySelector('.reel-embed-fallback');
      if (fallback) fallback.hidden = true;
      const box = slide.querySelector('.reel-iframe-container');
      unmountSlideIframe(box);
      mountFeedIframe(slide, reel);
      return;
    }

    const focusPlayerBtn = e.target.closest('[data-action="focus-embed-player"]');
    if (focusPlayerBtn) {
      const iframe = slide.querySelector('.reel-player-iframe.is-ready');
      if (iframe) {
        iframe.tabIndex = 0;
        iframe.focus({ preventScroll: true });
        announceStatus('Focused embedded Instagram player.');
      }
    }
  });

  return slide;
}

/**
 * Constructs 100dvh reel slides for the vertical snap feed with adaptive framing.
 */
function renderFeedSlides() {
  const existingBoxes = feedScrollTrack.querySelectorAll('.reel-iframe-container');
  existingBoxes.forEach((box) => unmountSlideIframe(box));
  feedScrollTrack.innerHTML = '';

  state.reels.forEach((reel, index) => {
    const slide = createFeedSlide(reel, index);
    feedScrollTrack.appendChild(slide);
  });

  setupFeedIntersectionObserver();
}

/**
 * Dynamically appends newly fetched reels as slides onto the active feed track and registers them with the observer.
 * @param {Array<object>} newReels
 */
function appendFeedSlides(newReels) {
  if (!Array.isArray(newReels) || newReels.length === 0) return;
  const startIndex = feedScrollTrack.querySelectorAll('.feed-reel-slide').length;
  newReels.forEach((reel, i) => {
    const slideIndex = startIndex + i;
    const slide = createFeedSlide(reel, slideIndex);
    feedScrollTrack.appendChild(slide);
    if (feedIntersectionObserver) {
      feedIntersectionObserver.observe(slide);
    }
  });
  updateFeedNavArrows(state.currentFeedIndex);
  const currentReel = state.reels[state.currentFeedIndex];
  feedCounterKicker.textContent = formatFeedCounterKicker(currentReel, state.currentFeedIndex, state.total || state.reels.length);
}

/**
 * Copies the canonical Instagram URL for a slide and temporarily flashes status on the Copy sublabel.
 * @param {HTMLElement} slide
 * @param {object} reel
 */
async function copySlideLink(slide, reel) {
  const copyLabel = slide?.querySelector('.copy-label');
  const url = sanitizeExternalHref(reel?.reel_url, 'https://www.instagram.com/');
  const isPost = getSavedMediaType(reel) === 'post';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(url);
    if (copyLabel) copyLabel.textContent = 'Copied!';
    announceStatus(`${isPost ? 'Post' : 'Reel'} link copied to clipboard.`);
  } catch (err) {
    console.warn('Clipboard write failed:', err);
    if (copyLabel) copyLabel.textContent = 'Failed';
    showToast('Could not copy link automatically. Use the Open link to copy manually.', 'error');
  }
  setTimeout(() => {
    if (copyLabel) copyLabel.textContent = 'Copy';
  }, 1500);
}

/**
 * Updates enabled/disabled state on the feed modal's Previous and Next slide controls.
 * @param {number} index
 */
function updateFeedNavArrows(index) {
  feedArrowUp.disabled = index <= 0;
  const hasMore = state.reels.length < state.total;
  feedArrowDown.disabled = index >= state.reels.length - 1 && !hasMore;
}

/**
 * Formats the feed modal header counter label according to resolved media kind (POST vs REEL).
 * @param {object | null | undefined} reel
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
function formatFeedCounterKicker(reel, index, total) {
  const input = getSlideAspectInput(reel);
  const kindLabel = input.isClips === false ? 'POST' : 'REEL';
  const effectiveTotal = Math.max(Number(total) || 0, Number(state.total) || 0, state.reels.length || 0);
  return `${kindLabel} ${index + 1} OF ${effectiveTotal}`;
}

/**
 * Sets up an IntersectionObserver to dynamically mount and unmount video iframes.
 */
function setupFeedIntersectionObserver() {
  if (feedIntersectionObserver) {
    feedIntersectionObserver.disconnect();
  }

  feedIntersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const slide = entry.target;
      const reelId = slide.getAttribute('data-reel-id');
      const index = parseInt(slide.getAttribute('data-index') || '0', 10);
      const reel = state.reels[index];
      const iframeBox = slide.querySelector('.reel-iframe-container');

      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        state.currentFeedIndex = index;
        state.currentFeedReelId = reelId;
        syncActiveSlideInert(index);

        feedCounterKicker.textContent = formatFeedCounterKicker(reel, index, state.total || state.reels.length);
        updateFeedNavArrows(index);

        if (reel) {
          mountFeedIframe(slide, reel);
        }

        if (index >= state.reels.length - 3 && state.reels.length < state.total && !isFeedLoadingMore) {
          loadMoreFeedReels(false);
        }
      } else if (!entry.isIntersecting || entry.intersectionRatio < 0.2) {
        unmountSlideIframe(iframeBox);
      }
    });
  }, {
    root: feedScrollTrack,
    threshold: [0.2, 0.5, 0.8],
  });

  const slides = feedScrollTrack.querySelectorAll('.feed-reel-slide');
  slides.forEach((slide) => feedIntersectionObserver.observe(slide));
}

/**
 * Toggles background catalog interactivity and screen-reader visibility when the feed modal is open.
 * @param {boolean} isLocked
 */
function setBackgroundCatalogInert(isLocked) {
  [topNavEl, vaultContainerEl].forEach((el) => {
    if (!el) return;
    el.inert = isLocked;
    if (isLocked) {
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('aria-hidden');
    }
  });
}

/**
 * Opens the fullscreen Reels snap-feed scrolled to the selected reel with synchronous background lock
 * and deterministic frame-0 focus on the close button.
 * @param {object} startReel
 * @param {HTMLElement | null} [triggerEl=null]
 */
function openReelsFeed(startReel, triggerEl = null) {
  closeShortcutsPopover(false);
  state.previouslyFocusedElement = triggerEl || document.activeElement;
  state.previouslyFocusedReelId = startReel?.id || null;

  const startIndex = Math.max(0, state.reels.findIndex((r) => r.id === startReel?.id));
  state.currentFeedIndex = startIndex;
  state.currentFeedReelId = startReel?.id || null;
  feedCounterKicker.textContent = formatFeedCounterKicker(startReel, startIndex, state.total || state.reels.length);
  updateFeedNavArrows(startIndex);

  renderFeedSlides();

  setBackgroundCatalogInert(true);
  feedModal.classList.add('active');
  feedModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  const targetSlide = startReel?.id
    ? feedScrollTrack.querySelector(`[data-reel-id="${CSS.escape(String(startReel.id))}"]`)
    : null;
  if (targetSlide) {
    targetSlide.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  // Force style resolution so visibility transitions immediately allow focus on frame 0
  void feedModal.offsetWidth;
  feedCloseBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (feedModal.classList.contains('active') && document.activeElement !== feedCloseBtn) {
      feedCloseBtn.focus({ preventScroll: true });
    }
  });
}

/**
 * Closes the fullscreen Reels snap-feed, halts audio, unlocks background catalog, and restores focus.
 */
function closeReelsFeed() {
  if (feedIntersectionObserver) {
    feedIntersectionObserver.disconnect();
  }

  const iframes = feedScrollTrack.querySelectorAll('.reel-iframe-container');
  iframes.forEach((box) => unmountSlideIframe(box));

  setBackgroundCatalogInert(false);
  feedModal.classList.remove('active');
  feedModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  state.currentFeedReelId = null;

  const prev = state.previouslyFocusedElement;
  const reelId = state.previouslyFocusedReelId || prev?.closest?.('[data-id]')?.getAttribute('data-id');
  const isPrevVisible = prev && prev.isConnected && prev.offsetParent !== null;
  const isPrevCatalogControl = Boolean(isPrevVisible && prev.closest?.('[data-id]'));
  let restoreTarget = isPrevCatalogControl ? prev : null;

  if (!restoreTarget && reelId) {
    const escapedId = CSS.escape(String(reelId));
    const selector = state.viewMode === 'list'
      ? `.table-row[data-id="${escapedId}"] .btn-table-play`
      : `.vault-poster-card[data-id="${escapedId}"] .poster-play-trigger`;
    restoreTarget = document.querySelector(selector);
  }
  if (!restoreTarget && isPrevVisible) {
    restoreTarget = prev;
  }
  if (restoreTarget && typeof restoreTarget.focus === 'function') {
    restoreTarget.focus();
  }
  state.previouslyFocusedElement = null;
  state.previouslyFocusedReelId = null;
}

/**
 * Scrolls the feed track up (-1) or down (+1) by one reel slide.
 * @param {number} direction
 */
function scrollFeedBy(direction) {
  const targetIndex = state.currentFeedIndex + direction;
  if (targetIndex >= 0 && targetIndex < state.reels.length) {
    const nextSlide = feedScrollTrack.querySelector(`[data-index="${targetIndex}"]`);
    if (nextSlide) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      nextSlide.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
  } else if (direction > 0 && targetIndex >= state.reels.length && state.reels.length < state.total) {
    loadMoreFeedReels(true);
  }
}

/**
 * Loads the next page of reels for the vertical snap feed, appending new slides without interrupting playback.
 * @param {boolean} [autoAdvance=false]
 */
async function loadMoreFeedReels(autoAdvance = false) {
  if (isFeedLoadingMore) return;
  if (state.reels.length >= state.total) return;

  const nextPage = Math.floor(state.reels.length / state.filters.limit) + 1;
  const maxPage = Math.max(1, Math.ceil(state.total / state.filters.limit) || 1);
  if (nextPage > maxPage) return;

  isFeedLoadingMore = true;
  if (autoAdvance) {
    feedArrowDown.setAttribute('aria-busy', 'true');
  }

  try {
    const prevCount = state.reels.length;
    await fetchReels({ append: true, pageOverride: nextPage, silent: true });
    if (autoAdvance && state.reels.length > prevCount) {
      scrollFeedBy(1);
    }
  } catch (err) {
    console.error('Failed to load more feed reels:', err);
  } finally {
    isFeedLoadingMore = false;
    feedArrowDown.removeAttribute('aria-busy');
    updateFeedNavArrows(state.currentFeedIndex);
  }
}

/**
 * Loads the next page of reels for continuous catalog scrolling, appending new cards/rows and updating counts.
 */
async function loadMoreCatalogReels() {
  if (isCatalogLoadingMore || isFeedLoadingMore) return;
  if (state.reels.length >= state.total) return;

  const nextPage = Math.floor(state.reels.length / state.filters.limit) + 1;
  const maxPage = Math.max(1, Math.ceil(state.total / state.filters.limit) || 1);
  if (nextPage > maxPage) return;

  isCatalogLoadingMore = true;
  const spinner = document.getElementById('catalog-scroll-spinner');
  if (spinner) spinner.hidden = false;

  try {
    await fetchReels({ append: true, pageOverride: nextPage, silent: true });
  } catch (err) {
    console.error('Failed to load more catalog reels:', err);
  } finally {
    isCatalogLoadingMore = false;
    if (spinner) spinner.hidden = true;
  }
}

/**
 * Observes the catalog sentinel element to automatically prefetch and append next page of reels as the user scrolls.
 */
function setupCatalogInfiniteObserver() {
  const sentinel = document.getElementById('catalog-sentinel');
  if (!sentinel) return;
  if (catalogIntersectionObserver) {
    catalogIntersectionObserver.disconnect();
  }

  catalogIntersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry && entry.isIntersecting) {
      if (state.reels.length > 0 && state.reels.length < state.total && !isCatalogLoadingMore) {
        loadMoreCatalogReels();
      }
    }
  }, {
    root: null,
    rootMargin: '400px 0px',
    threshold: 0.01,
  });

  catalogIntersectionObserver.observe(sentinel);
}

/**
 * Synchronizes active status styling and aria-pressed state on the action rail for a specific reel.
 * @param {string} reelId
 * @param {string} newStatus
 */
function syncFeedSlideStatus(reelId, newStatus) {
  const slide = feedScrollTrack.querySelector(`[data-reel-id="${CSS.escape(String(reelId))}"]`);
  if (!slide) return;

  const watchedBtn = slide.querySelector('[data-action="feed-toggle-watched"]');
  const laterBtn = slide.querySelector('[data-action="feed-toggle-later"]');
  const reel = state.reels.find((r) => r.id === reelId);
  const itemWord = getSavedMediaType(reel) === 'post' ? 'post' : 'reel';
  const creatorInfo = getCreatorDisplayInfo(reel?.creator);
  const ariaTarget = creatorInfo.isAttributedName ? creatorInfo.accessibleName : `this ${itemWord}`;
  const isWatched = newStatus === 'watched';
  const isLater = newStatus === 'watch_later';

  if (watchedBtn) {
    watchedBtn.classList.toggle('active-watched', isWatched);
    watchedBtn.setAttribute('aria-pressed', String(isWatched));
    watchedBtn.setAttribute('title', `${getStatusPillTitle(newStatus)} (w)`);
    watchedBtn.setAttribute('aria-label', getStatusPillTitle(newStatus));
  }
  if (laterBtn) {
    laterBtn.classList.toggle('active-later', isLater);
    laterBtn.setAttribute('aria-pressed', String(isLater));
    laterBtn.setAttribute('title', getLaterButtonTitle(newStatus, 'feed'));
    laterBtn.setAttribute('aria-label', getLaterButtonAriaLabel(newStatus, ariaTarget, 'feed'));
    const svg = laterBtn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill', isLater ? 'currentColor' : 'none');
    }
  }
}

/**
 * Updates pagination indicator text and enables/disables navigation buttons.
 * @param {number} page
 * @param {number} limit
 * @param {number} total
 */
function updatePagination(page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.max(1, Math.min(page, totalPages));
  paginationBar.classList.toggle('is-hidden', total <= limit);
  pageIndicator.textContent = `of ${totalPages.toLocaleString()}`;
  if (pageJumpInput) {
    pageJumpInput.value = String(safePage);
    pageJumpInput.dataset.maxPage = String(totalPages);
    pageJumpInput.dataset.currentPage = String(safePage);
  }
  if (pageJumpGoBtn) {
    pageJumpGoBtn.hidden = true;
  }
  prevPageBtn.disabled = safePage <= 1;
  nextPageBtn.disabled = safePage >= totalPages;
}

// --- Contextual Shortcuts & Guide Popover ---

/**
 * Opens the shortcuts & import guide popover and moves focus to its close button.
 */
function openShortcutsPopover() {
  if (!shortcutsPopover || !shortcutsHelpBtn) return;
  shortcutsPopover.hidden = false;
  shortcutsHelpBtn.setAttribute('aria-expanded', 'true');
  shortcutsCloseBtn?.focus();
}

/**
 * Closes the shortcuts & import guide popover and optionally restores focus to the Help button.
 * @param {boolean} [restoreFocus=true]
 */
function closeShortcutsPopover(restoreFocus = true) {
  if (!shortcutsPopover || !shortcutsHelpBtn || shortcutsPopover.hidden) return;
  shortcutsPopover.hidden = true;
  shortcutsHelpBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    shortcutsHelpBtn.focus();
  }
}

// --- Helpers ---

/**
 * Formats an ISO date string into a concise short date (e.g., Nov 8, 2026).
 * @param {string} isoDate
 * @returns {string}
 */
function formatShortDate(isoDate) {
  if (!isoDate) return 'Unknown';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Converts raw status tokens into user-friendly display labels.
 * @param {string} status
 * @returns {string}
 */
function formatStatusLabel(status) {
  switch (status) {
    case 'watch_later': return 'Watch Later';
    case 'watched': return 'Watched';
    default: return 'Unwatched';
  }
}

const UTF8_DECODER_FATAL = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;

/**
 * Decodes Meta export Latin-1-wrapped UTF-8 mojibake runs and strips unrenderable C1/PUA characters.
 * @param {string | null | undefined} str
 * @returns {string}
 */
function stripPrivateUseChars(str) {
  if (!str) return '';
  let text = String(str);
  if (UTF8_DECODER_FATAL) {
    text = text.replace(
      /(?:[\u00C2-\u00DF][\u0080-\u00BF]|[\u00E0-\u00EF][\u0080-\u00BF]{2}|[\u00F0-\u00F4][\u0080-\u00BF]{3})+/g,
      (chunk) => {
        try {
          const bytes = new Uint8Array(chunk.length);
          for (let i = 0; i < chunk.length; i++) {
            bytes[i] = chunk.charCodeAt(i);
          }
          return UTF8_DECODER_FATAL.decode(bytes);
        } catch (_) {
          return chunk;
        }
      }
    );
  }
  return text
    .replace(/[\u007F-\u009F]/g, '')
    .replace(/[\uE000-\uF8FF]+[\uF900-\uFAFF]+|[\uF900-\uFAFF]+[\uE000-\uF8FF]+/g, '')
    .replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu, '');
}

/**
 * Resolves consistent outbound Instagram profile URLs for validated `@handle` links across Grid, List, and Modal views,
 * falling back cleanly to the saved reel URL for unattributed or placeholder entries (or spaced display names without a handle).
 * @param {object | string | null | undefined} creatorOrHandle
 * @param {string | null | undefined} reelUrl
 * @returns {string}
 */
function getSafeCreatorProfileHref(creatorOrHandle, reelUrl) {
  const rawUsername = typeof creatorOrHandle === 'string'
    ? creatorOrHandle
    : creatorOrHandle?.username;
  const cleanHandle = extractPublicCreatorHandle(rawUsername);
  if (cleanHandle) {
    return `https://www.instagram.com/${encodeURIComponent(cleanHandle)}/`;
  }
  return sanitizeExternalHref(reelUrl, 'https://www.instagram.com/');
}

/**
 * Escapes raw strings for safe insertion into HTML templates and double-quoted attributes.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decodes raw &amp; HTML entities in media URLs and enforces HTTP/HTTPS scheme safety.
 * @param {string} url
 * @returns {string}
 */
function sanitizeMediaUrl(url) {
  if (!url) return '';
  const unescaped = String(url).replace(/&amp;/g, '&');
  return sanitizeExternalHref(unescaped, '');
}

/**
 * Returns true when a URL points to a known generic stock placeholder rather than real Instagram media.
 * @param {string} url
 * @returns {boolean}
 */
function isPlaceholderMediaUrl(url) {
  return Boolean(url && String(url).includes('photo-1618005182384'));
}

/**
 * Validates that external href targets strictly use HTTP or HTTPS protocols.
 * @param {string | null | undefined} rawUrl
 * @param {string} [fallback='https://www.instagram.com/']
 * @returns {string}
 */
function sanitizeExternalHref(rawUrl, fallback = 'https://www.instagram.com/') {
  if (!rawUrl) return fallback;
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Dispatches an obsidian dark-mode toast notification with optional action button and SVG dismiss button for errors.
 * @param {string} message
 * @param {'info' | 'success' | 'error'} type
 * @param {{ actionLabel?: string, onAction?: () => void }} [options]
 */
function showToast(message, type = 'info', options = {}) {
  let toastContainer = document.getElementById('vault-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'vault-toast-container';
    toastContainer.className = 'vault-toast-container';
    document.body.appendChild(toastContainer);
  }
  const isError = type === 'error';
  const hasAction = Boolean(options?.actionLabel && typeof options?.onAction === 'function');
  const toast = document.createElement('div');
  toast.className = `vault-toast vault-toast-${type}`;
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.innerHTML = `
    <span class="toast-dot" aria-hidden="true"></span>
    <span class="toast-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</span>
    ${hasAction ? `<button type="button" class="toast-action-btn">${escapeHtml(options.actionLabel)}</button>` : ''}
    ${isError ? '<button type="button" class="toast-dismiss-btn" aria-label="Dismiss error notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>' : ''}
  `;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  /**
   * Fades out and removes the toast element from the DOM.
   */
  const dismiss = () => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 250);
  };

  if (hasAction) {
    const actionBtn = toast.querySelector('.toast-action-btn');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        dismiss();
        options.onAction();
      });
    }
  }

  if (isError) {
    const dismissBtn = toast.querySelector('.toast-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', dismiss);
    }
  } else {
    setTimeout(dismiss, 4500);
  }
}

/**
 * Returns true if keyboard events originate inside an editable text field or select control.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Returns true if an element is visible, rendered in layout, and eligible for keyboard Tab focus.
 * Filters out controls inside `[hidden]`, `.is-hidden`, `display: none`, or `visibility: hidden`.
 * @param {Element} el
 * @returns {boolean}
 */
function isVisibleFocusable(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden], .is-hidden')) return false;
  if (el.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Executes keyboard shortcuts and Tab focus trapping while the fullscreen feed modal is active.
 * @param {KeyboardEvent} e
 */
function handleModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeReelsFeed();
    return;
  }

  if (e.key === 'Tab') {
    const activeSlide = feedScrollTrack.querySelector(`.feed-reel-slide[data-index="${state.currentFeedIndex}"]`);
    const topBarControls = Array.from(feedModal.querySelectorAll('.feed-top-bar button:not([disabled])')).filter(isVisibleFocusable);
    const slideControls = activeSlide
      ? Array.from(activeSlide.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(isVisibleFocusable)
      : [];
    const focusables = [...topBarControls, ...slideControls];
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const isInsideModal = Boolean(active && feedModal.contains(active));

    if (!isInsideModal) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
      return;
    }

    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }

  if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;

  if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'PageDown') {
    e.preventDefault();
    scrollFeedBy(1);
  } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'PageUp') {
    e.preventDefault();
    scrollFeedBy(-1);
  } else if (e.key === 'w') {
    const activeReel = state.reels[state.currentFeedIndex];
    if (activeReel) {
      e.preventDefault();
      updateReelStatus(activeReel.id, activeReel.watch_status === 'watched' ? 'unwatched' : 'watched');
    }
  } else if (e.key === 'l') {
    const activeReel = state.reels[state.currentFeedIndex];
    if (activeReel) {
      e.preventDefault();
      updateReelStatus(activeReel.id, activeReel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later');
    }
  } else if (e.key === 'c') {
    const activeReel = state.reels[state.currentFeedIndex];
    const activeSlide = feedScrollTrack.querySelector(`.feed-reel-slide[data-index="${state.currentFeedIndex}"]`);
    if (activeReel && activeSlide) {
      e.preventDefault();
      copySlideLink(activeSlide, activeReel);
    }
  }
}

// --- Event Listeners ---

/**
 * Binds UI controls, URL sync, search debounce, key listeners, shortcuts popover, and archive import handlers.
 */
function setupEventListeners() {
  // 1-hour privacy auto-logout tracking across interactions, visibility changes, and window focus
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, () => recordVaultActivity(false), { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkVaultInactivity(false);
    }
  });

  window.addEventListener('focus', () => {
    checkVaultInactivity(false);
  });

  setInterval(() => {
    checkVaultInactivity(false);
  }, 30000);
  viewModeGridBtn.addEventListener('click', () => applyViewMode('grid'));
  viewModeListBtn.addEventListener('click', () => applyViewMode('list'));

  sourceTabsButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextSource = btn.dataset.source || 'all';
      if (state.filters.source === nextSource) return;
      state.filters.source = nextSource;
      state.filters.page = 1;
      syncSourceTabsUi();
      syncKpiActiveStates();
      syncUrlState();
      loadStats();
      fetchReels();
      const label = nextSource === 'bot'
        ? 'Showing items sent to Reeler Bot.'
        : (nextSource === 'instagram' ? 'Showing Instagram Saved items only.' : 'Showing all Instagram Saved and bot-sent items.');
      announceStatus(label);
    });
  });

  mediaTypeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextType = btn.dataset.mediaType || 'all';
      if (state.filters.mediaType === nextType) return;
      state.filters.mediaType = nextType;
      state.filters.page = 1;
      syncMediaTypeToggleUi();
      syncKpiActiveStates();
      syncUrlState();
      fetchReels();
      const label = nextType === 'post'
        ? 'Showing tracked posts only.'
        : (nextType === 'reel' ? 'Showing tracked reels only.' : 'Showing all reels and posts.');
      announceStatus(label);
    });
  });

  if (creatorsMobileToggle && creatorsStripContainer) {
    creatorsMobileToggle.addEventListener('click', () => {
      const nextExpanded = !creatorsStripContainer.classList.contains('is-expanded');
      setCreatorsExpanded(nextExpanded);
    });
  }

  if (metricFilterAll) {
    metricFilterAll.addEventListener('click', () => {
      if (hasActiveFilters()) {
        clearAllFilters();
        loadStats();
        announceStatus('Filters reset. Showing all tracked items.');
      } else {
        syncKpiActiveStates();
        loadStats();
        fetchReels();
      }
    });
  }

  if (metricFilterWeek) {
    metricFilterWeek.addEventListener('click', () => {
      state.filters.datePreset = state.filters.datePreset === '7d' ? 'all' : '7d';
      datePresetSelect.value = state.filters.datePreset;
      state.filters.page = 1;
      syncKpiActiveStates();
      syncUrlState();
      loadStats();
      fetchReels();
      announceStatus(state.filters.datePreset === '7d' ? 'Filtered to items added in the last 7 days.' : 'Cleared date filter.');
    });
  }

  if (metricFilterLater) {
    metricFilterLater.addEventListener('click', () => {
      state.filters.watchStatus = state.filters.watchStatus === 'watch_later' ? 'all' : 'watch_later';
      watchFilterSelect.value = state.filters.watchStatus;
      state.filters.page = 1;
      syncKpiActiveStates();
      syncUrlState();
      loadStats();
      fetchReels();
      announceStatus(state.filters.watchStatus === 'watch_later' ? 'Filtered to Watch Later queue.' : 'Cleared Watch Later filter.');
    });
  }

  if (metricFilterWatched) {
    metricFilterWatched.addEventListener('click', () => {
      state.filters.watchStatus = state.filters.watchStatus === 'watched' ? 'all' : 'watched';
      watchFilterSelect.value = state.filters.watchStatus;
      state.filters.page = 1;
      syncKpiActiveStates();
      syncUrlState();
      loadStats();
      fetchReels();
      announceStatus(state.filters.watchStatus === 'watched' ? 'Filtered to Watched items.' : 'Cleared Watched filter.');
    });
  }

  if (shortcutsHelpBtn && shortcutsPopover) {
    shortcutsHelpBtn.addEventListener('click', () => {
      if (shortcutsPopover.hidden) {
        openShortcutsPopover();
      } else {
        closeShortcutsPopover(true);
      }
    });
    shortcutsCloseBtn?.addEventListener('click', () => closeShortcutsPopover(true));
    popoverImportBtn?.addEventListener('click', () => {
      closeShortcutsPopover(false);
      archiveFileInput.click();
    });
    document.addEventListener('click', (e) => {
      if (!shortcutsPopover.hidden && !shortcutsPopover.contains(e.target) && !shortcutsHelpBtn.contains(e.target)) {
        closeShortcutsPopover(false);
      }
    });
    document.addEventListener('focusin', (e) => {
      if (!shortcutsPopover.hidden && !shortcutsPopover.contains(e.target) && !shortcutsHelpBtn.contains(e.target)) {
        closeShortcutsPopover(false);
      }
    });
  }

  feedCloseBtn.addEventListener('click', closeReelsFeed);
  feedArrowUp.addEventListener('click', () => scrollFeedBy(-1));
  feedArrowDown.addEventListener('click', () => scrollFeedBy(1));
  feedModal.addEventListener('focusin', (e) => {
    if (e.target && e.target.matches?.('iframe.reel-player-iframe')) return;
    feedScrollTrack.querySelectorAll('iframe.reel-player-iframe').forEach((frame) => {
      if (frame.tabIndex !== -1) frame.tabIndex = -1;
    });
  });

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (!feedModal.classList.contains('active')) return;
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      const slides = feedScrollTrack.querySelectorAll('.feed-reel-slide');
      slides.forEach((slide) => {
        const index = parseInt(slide.getAttribute('data-index') || '0', 10);
        const reel = state.reels[index];
        if (reel) {
          applySlideStage(slide, reel);
        }
      });
    });
  });

  window.addEventListener('keydown', (e) => {
    if (feedModal.classList.contains('active')) {
      handleModalKeydown(e);
      return;
    }

    if (shortcutsPopover && !shortcutsPopover.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeShortcutsPopover(true);
      return;
    }

    if (isSwitchingVault && e.key === 'Escape') {
      e.preventDefault();
      cancelSwitchVault();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;

    if (e.key === '/') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === '?') {
      e.preventDefault();
      if (shortcutsPopover?.hidden) {
        openShortcutsPopover();
      } else {
        closeShortcutsPopover(true);
      }
    } else if (e.key === '[' && prevPageBtn && !prevPageBtn.disabled && !paginationBar.classList.contains('is-hidden')) {
      e.preventDefault();
      prevPageBtn.click();
    } else if (e.key === ']' && nextPageBtn && !nextPageBtn.disabled && !paginationBar.classList.contains('is-hidden')) {
      e.preventDefault();
      nextPageBtn.click();
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.preventDefault();
      clearSearchBtn.click();
    }
  });

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value;
    clearSearchBtn.hidden = !val;
    const trimmed = val.trim();
    if (trimmed) {
      resultsCount.textContent = `Searching "${trimmed}"...`;
    }
    searchTimeout = setTimeout(() => {
      state.filters.search = val;
      state.filters.page = 1;
      syncKpiActiveStates();
      syncUrlState();
      fetchReels();
    }, 180);
  });

  clearSearchBtn.addEventListener('click', () => {
    clearTimeout(searchTimeout);
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    state.filters.search = '';
    state.filters.page = 1;
    syncKpiActiveStates();
    syncUrlState();
    fetchReels();
    if (!window.matchMedia?.('(pointer: coarse)').matches) {
      searchInput.focus();
    }
  });

  if (creatorFilterInput) {
    creatorFilterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && creatorFilterInput.value) {
        e.preventDefault();
        clearCreatorFilterBtn?.click();
      }
    });

    creatorFilterInput.addEventListener('input', (e) => {
      const val = e.target.value || '';
      state.creatorQuery = val;
      if (clearCreatorFilterBtn) {
        clearCreatorFilterBtn.hidden = !val;
      }
      clearTimeout(creatorSearchTimeout);
      if (!val.trim()) {
        if (creatorsFetchController) {
          creatorsFetchController.abort();
          creatorsFetchController = null;
        }
        isCreatorSearching = false;
        if (state.topCreators.length > 0) {
          state.creators = state.topCreators;
          state.creatorMatchTotal = state.totalCreators;
          renderCreatorStrip();
        } else {
          loadCreators('');
        }
        return;
      }
      isCreatorSearching = true;
      renderCreatorStrip();
      creatorSearchTimeout = setTimeout(() => {
        loadCreators(val);
      }, 160);
    });
  }

  if (clearCreatorFilterBtn && creatorFilterInput) {
    clearCreatorFilterBtn.addEventListener('click', () => {
      clearTimeout(creatorSearchTimeout);
      if (creatorsFetchController) {
        creatorsFetchController.abort();
        creatorsFetchController = null;
      }
      isCreatorSearching = false;
      creatorFilterInput.value = '';
      state.creatorQuery = '';
      clearCreatorFilterBtn.hidden = true;
      if (state.topCreators.length > 0) {
        state.creators = state.topCreators;
        state.creatorMatchTotal = state.totalCreators;
        renderCreatorStrip();
      } else {
        loadCreators('');
      }
      if (!window.matchMedia?.('(pointer: coarse)').matches) {
        creatorFilterInput.focus();
      }
    });
  }

  datePresetSelect.addEventListener('change', (e) => {
    state.filters.datePreset = e.target.value;
    state.filters.page = 1;
    syncKpiActiveStates();
    syncUrlState();
    fetchReels();
  });

  watchFilterSelect.addEventListener('change', (e) => {
    state.filters.watchStatus = e.target.value;
    state.filters.page = 1;
    syncKpiActiveStates();
    syncUrlState();
    loadStats();
    fetchReels();
  });

  // Automatically sync stats, creators, and cards when returning to this tab after DM bot actions
  let lastAutoSyncAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (isSwitchingVault) return;
    if (vaultGateScreen && !vaultGateScreen.classList.contains('is-hidden')) return;
    if (feedModal && feedModal.classList.contains('active')) return;
    const now = Date.now();
    if (now - lastAutoSyncAt < 5000) return;
    lastAutoSyncAt = now;
    loadStats({ silent: true });
    loadCreators(state.creatorQuery, { silent: true });
    fetchReels({ silent: true });
  });

  sortBySelect.addEventListener('change', (e) => {
    state.filters.sortBy = e.target.value;
    state.filters.page = 1;
    syncUrlState();
    fetchReels();
  });

  resetCreatorBtn.addEventListener('click', () => selectCreator(''));

  prevPageBtn.addEventListener('click', () => {
    if (state.filters.page > 1) {
      state.filters.page--;
      syncUrlState();
      fetchReels();
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  });

  nextPageBtn.addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / state.filters.limit) || 1);
    if (state.filters.page < maxPage) {
      state.filters.page++;
      syncUrlState();
      fetchReels();
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  });

  if (pageJumpForm && pageJumpInput) {
    let ignoreNextPageJumpBlur = false;

    /**
     * Toggles inline Go submit visibility whenever the typed page number differs from the active page.
     */
    const updatePageJumpGoVisibility = () => {
      if (!pageJumpGoBtn) return;
      const currentPage = Math.max(1, parseInt(pageJumpInput.dataset.currentPage || String(state.filters.page), 10) || 1);
      const raw = String(pageJumpInput.value || '').trim();
      pageJumpGoBtn.hidden = !raw || raw === String(currentPage);
    };

    /**
     * Parses, clamps, and navigates to a user-entered page number on submit (Enter or Go).
     */
    const commitPageJump = () => {
      const maxPage = Math.max(1, parseInt(pageJumpInput.dataset.maxPage || '1', 10) || 1);
      const currentPage = Math.max(1, parseInt(pageJumpInput.dataset.currentPage || String(state.filters.page), 10) || 1);
      const parsed = parseInt(String(pageJumpInput.value || '').replace(/[^0-9]/g, ''), 10);
      if (pageJumpGoBtn) pageJumpGoBtn.hidden = true;
      ignoreNextPageJumpBlur = false;
      if (!Number.isFinite(parsed)) {
        pageJumpInput.value = String(currentPage);
        return;
      }
      const targetPage = Math.max(1, Math.min(parsed, maxPage));
      pageJumpInput.value = String(targetPage);
      if (targetPage === state.filters.page) return;
      pageJumpInput.dataset.currentPage = String(targetPage);
      state.filters.page = targetPage;
      syncUrlState();
      fetchReels();
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    };

    if (pageJumpGoBtn) {
      pageJumpGoBtn.addEventListener('pointerdown', () => {
        ignoreNextPageJumpBlur = true;
      });
    }

    pageJumpInput.addEventListener('input', updatePageJumpGoVisibility);

    pageJumpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      commitPageJump();
    });
    pageJumpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const currentPage = Math.max(1, parseInt(pageJumpInput.dataset.currentPage || String(state.filters.page), 10) || 1);
        pageJumpInput.value = String(currentPage);
        if (pageJumpGoBtn) pageJumpGoBtn.hidden = true;
        ignoreNextPageJumpBlur = true;
        pageJumpInput.blur();
      }
    });
    pageJumpInput.addEventListener('blur', (e) => {
      if (ignoreNextPageJumpBlur || (pageJumpGoBtn && e.relatedTarget === pageJumpGoBtn)) {
        ignoreNextPageJumpBlur = false;
        return;
      }
      const currentPage = Math.max(1, parseInt(pageJumpInput.dataset.currentPage || String(state.filters.page), 10) || 1);
      pageJumpInput.value = String(currentPage);
      if (pageJumpGoBtn) pageJumpGoBtn.hidden = true;
    });
  }

  importBtn.addEventListener('click', () => {
    archiveFileInput.click();
  });

  archiveFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      showToast(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Max allowed size is 50MB.`, 'error');
      archiveFileInput.value = '';
      return;
    }

    const originalContent = importBtn.innerHTML;
    importBtn.innerHTML = '<span>Importing...</span>';
    importBtn.disabled = true;

    try {
      const text = await file.text();
      const res = await vaultFetch('/api/archive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });

      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }

      if (!res.ok) {
        const errorMsg = data?.error || data?.errors?.join('\n') || `Server responded with status ${res.status}`;
        showToast(`Import error: ${errorMsg}`, 'error');
        return;
      }

      const imported = data?.reelsImported ?? 0;
      const alreadyIn = data?.alreadyPresent ?? 0;
      const backfilled = data?.savedAtBackfilled ?? 0;
      const promoted = data?.promotedToSaved ?? 0;
      const errCount = data?.errors?.length ?? 0;
      const summaryLines = [
        'Archive processed!',
        `• New items imported: ${imported}`,
        `• Already present: ${alreadyIn}`,
      ];
      if (promoted > 0) {
        summaryLines.push(`• Moved to Saved on IG: ${promoted}`);
      }
      if (backfilled > 0) {
        summaryLines.push(`• Saved dates backfilled: ${backfilled}`);
      }
      const summary = summaryLines.join('\n');
      if (data?.status === 'partial' || errCount > 0) {
        showToast(`${summary}\n• Items with errors: ${errCount}`, 'error');
      } else {
        showToast(summary, 'success');
      }
      state.topCreators = [];
      await Promise.all([loadStats(), loadCreators(state.creatorQuery), fetchReels()]);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      archiveFileInput.value = '';
      importBtn.innerHTML = originalContent;
      importBtn.disabled = false;
    }
  });

  setupCatalogInfiniteObserver();
}

document.addEventListener('DOMContentLoaded', init);
