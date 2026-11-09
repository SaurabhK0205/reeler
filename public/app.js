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

const ASPECT_CACHE_STORAGE_KEY = 'reeler_aspect_cache_v1';
const ASPECT_CACHE_MAX_ENTRIES = 300;
const CREATOR_TOP_LIMIT = 12;
const CREATOR_SEARCH_LIMIT = 15;

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
    creatorId: '',
    datePreset: 'all',
    watchStatus: 'all',
    sortBy: 'newest_saved',
    search: '',
    page: 1,
    limit: 24,
  },
  creatorQuery: '',
  viewMode: readViewMode(),
  total: 0,
  reels: [],
  creators: [],
  stats: null,
  currentFeedReelId: null,
  currentFeedIndex: 0,
  previouslyFocusedElement: null,
  previouslyFocusedReelId: null,
  thumbRatioCache: new Map(),
  metaCache: new Map(),
  aspectCache: loadAspectCache(),
};

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
const statTotal = document.getElementById('stat-total');
const statCreators = document.getElementById('stat-creators');
const statWeek = document.getElementById('stat-week');
const statWatchLater = document.getElementById('stat-watch-later');
const statWatchedSub = document.getElementById('stat-watched-sub');
const metricCellLater = document.getElementById('metric-cell-later');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const datePresetSelect = document.getElementById('date-preset');
const watchFilterSelect = document.getElementById('watch-filter');
const sortBySelect = document.getElementById('sort-by');
const creatorFilterInput = document.getElementById('creator-filter-input');
const clearCreatorFilterBtn = document.getElementById('clear-creator-filter');
const creatorStripMeta = document.getElementById('creator-strip-meta');
const creatorPillsList = document.getElementById('creator-pills-list');
const resetCreatorBtn = document.getElementById('reset-creator-btn');
const reelsGrid = document.getElementById('reels-grid');
const reelsTableContainer = document.getElementById('reels-table-container');
const reelsTable = document.getElementById('reels-table');
const reelsTableBody = document.getElementById('reels-table-body');
const reelsTableState = document.getElementById('reels-table-state');
const resultsCount = document.getElementById('results-count');
const paginationBar = document.getElementById('pagination-bar');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const pageJumpForm = document.getElementById('page-jump-form');
const pageJumpInput = document.getElementById('page-jump-input');
const pageIndicator = document.getElementById('page-indicator');
const viewModeGridBtn = document.getElementById('view-mode-grid');
const viewModeListBtn = document.getElementById('view-mode-list');

// Fullscreen Reels Snap-Feed References
const feedModal = document.getElementById('reels-feed-modal');
const feedScrollTrack = document.getElementById('feed-scroll-track');
const feedCounterKicker = document.getElementById('feed-counter-kicker');
const feedShortcodeTag = document.getElementById('feed-shortcode-tag');
const feedArrowUp = document.getElementById('feed-arrow-up');
const feedArrowDown = document.getElementById('feed-arrow-down');
const feedCloseBtn = document.getElementById('feed-close-btn');

let fetchReelsAbortController = null;
let statsLoadErrorNotified = false;
let creatorsLoadErrorNotified = false;

// --- Initialization & URL State Sync ---

/**
 * Restores initial view mode and active filters from URL query parameters on page load.
 */
function restoreFiltersFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const validDates = new Set(['all', 'today', 'yesterday', '7d', '30d', '3m', '6m', 'year']);
    const validStatuses = new Set(['all', 'unwatched', 'watch_later', 'watched']);
    const validSorts = new Set(['newest_saved', 'oldest_saved', 'newest_published', 'oldest_published']);

    const view = params.get('view');
    if (view === 'list' || view === 'grid') {
      state.viewMode = view;
    }

    const creator = params.get('creator');
    if (creator) state.filters.creatorId = creator;

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
}

/**
 * Persists active filters, pagination, and view mode into the browser URL without adding history entries.
 */
function syncUrlState() {
  try {
    const params = new URLSearchParams();
    if (state.filters.creatorId) params.set('creator', state.filters.creatorId);
    if (state.filters.datePreset !== 'all') params.set('date', state.filters.datePreset);
    if (state.filters.watchStatus !== 'all') params.set('status', state.filters.watchStatus);
    if (state.filters.sortBy !== 'newest_saved') params.set('sort', state.filters.sortBy);
    if (state.filters.search.trim()) params.set('q', state.filters.search.trim());
    if (state.filters.page > 1) params.set('page', String(state.filters.page));
    if (state.viewMode === 'list') params.set('view', 'list');

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || ''}`;
    history.replaceState(null, '', nextUrl);
  } catch (_) {
    /* non-fatal */
  }
}

/**
 * Returns true if any search, creator, date, or status filter is currently active.
 * @returns {boolean}
 */
function hasActiveFilters() {
  return Boolean(
    state.filters.creatorId ||
    state.filters.datePreset !== 'all' ||
    state.filters.watchStatus !== 'all' ||
    state.filters.search.trim()
  );
}

/**
 * Resets all active search, creator, date, and watch-status filters to defaults and reloads page 1.
 */
function clearAllFilters() {
  state.filters.creatorId = '';
  state.filters.datePreset = 'all';
  state.filters.watchStatus = 'all';
  state.filters.search = '';
  state.filters.page = 1;
  state.creatorQuery = '';

  searchInput.value = '';
  clearSearchBtn.hidden = true;
  datePresetSelect.value = 'all';
  watchFilterSelect.value = 'all';
  if (creatorFilterInput) creatorFilterInput.value = '';
  if (clearCreatorFilterBtn) clearCreatorFilterBtn.hidden = true;

  syncUrlState();
  renderCreatorStrip();
  fetchReels();
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
 * Renders structural skeleton poster cards immediately on initial load so cold fetches avoid blank voids.
 */
function renderInitialSkeletons() {
  if (!reelsGrid || reelsGrid.children.length > 0 || state.viewMode !== 'grid') return;
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
}

/**
 * Initializes the vault application, restores URL state, binds events, and loads data in parallel.
 */
async function init() {
  restoreFiltersFromUrl();
  applyViewMode(state.viewMode, false);
  setupEventListeners();
  renderInitialSkeletons();
  await Promise.all([checkHealth(), loadStats(), loadCreators(), fetchReels()]);
}

/**
 * Applies grid or list view mode to the UI, updates button pressed states, and optionally syncs URL state.
 * @param {'grid' | 'list'} mode
 * @param {boolean} [shouldSyncUrl=true]
 */
function applyViewMode(mode, shouldSyncUrl = true) {
  state.viewMode = mode;
  saveViewMode(mode);

  const isGrid = mode === 'grid';
  viewModeGridBtn.classList.toggle('active', isGrid);
  viewModeGridBtn.setAttribute('aria-pressed', String(isGrid));
  viewModeListBtn.classList.toggle('active', !isGrid);
  viewModeListBtn.setAttribute('aria-pressed', String(!isGrid));

  reelsGrid.classList.toggle('is-hidden', !isGrid);
  reelsTableContainer.classList.toggle('is-hidden', isGrid);

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
      renderDbBadge('connected', 'Supabase (Cloud)', 'Cloud');
    } else {
      renderDbBadge('local', 'In-Memory Store', 'Local');
    }
  } catch (_) {
    renderDbBadge('offline', 'Offline', 'Offline');
  }
}

/**
 * Fetches summary statistics from the server and populates metric cards.
 */
async function loadStats() {
  statsBar?.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const stats = await res.json();
    state.stats = stats;
    statsLoadErrorNotified = false;

    const totalReels = Number(stats.totalReels || 0);
    const totalCreators = Number(stats.totalCreators || 0);
    const savedWeek = Number(stats.savedThisWeek || 0);
    const watchLaterCount = Number(stats.watchLaterCount || 0);
    const watchedCount = Number(stats.watchedCount || 0);

    statTotal.textContent = totalReels.toLocaleString();
    statCreators.textContent = totalCreators.toLocaleString();
    statWeek.textContent = savedWeek.toLocaleString();
    statWatchLater.textContent = watchLaterCount.toLocaleString();
    if (statWatchedSub) {
      statWatchedSub.textContent = `${watchedCount.toLocaleString()} watched`;
      statWatchedSub.hidden = false;
    }
    metricCellLater?.querySelector('[data-action="retry-stats"]')?.remove();
    if (metricCellLater) {
      metricCellLater.classList.toggle('has-pending-later', watchLaterCount > 0);
    }
  } catch (e) {
    console.error('Failed to load stats:', e);
    if (!state.stats) {
      statTotal.textContent = '—';
      statCreators.textContent = '—';
      statWeek.textContent = '—';
      statWatchLater.textContent = '—';
      if (statWatchedSub) {
        statWatchedSub.hidden = true;
        statWatchedSub.textContent = '';
      }
      if (metricCellLater && !metricCellLater.querySelector('[data-action="retry-stats"]')) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'strip-inline-retry';
        retryBtn.setAttribute('data-action', 'retry-stats');
        retryBtn.textContent = 'Retry stats';
        retryBtn.addEventListener('click', () => loadStats());
        metricCellLater.querySelector('.metric-label-row')?.appendChild(retryBtn);
      }
    }
    if (!statsLoadErrorNotified) {
      statsLoadErrorNotified = true;
      showToast('Could not load library statistics.', 'error');
    }
  } finally {
    statsBar?.setAttribute('aria-busy', 'false');
  }
}

/**
 * Fetches unique creators and populates the bounded creator filter strip.
 */
async function loadCreators() {
  try {
    const res = await fetch('/api/creators');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    state.creators = await res.json();
    creatorsLoadErrorNotified = false;
    renderCreatorStrip();
  } catch (e) {
    console.error('Failed to load creators:', e);
    if (creatorStripMeta && state.creators.length === 0) {
      creatorStripMeta.innerHTML = '<span>Creator filters unavailable</span> <button type="button" class="strip-inline-retry" data-action="retry-creators">Retry</button>';
      creatorStripMeta.querySelector('[data-action="retry-creators"]')?.addEventListener('click', () => loadCreators());
    }
    if (!creatorsLoadErrorNotified) {
      creatorsLoadErrorNotified = true;
      showToast('Could not load creator filters.', 'error');
    }
  }
}

/**
 * Renders the bounded quick-filter strip: All Creators + Top 12 creators (or top 15 matching search query),
 * always retaining the active creator selection so DOM complexity stays minimal across 4,700+ creators.
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

  const q = state.creatorQuery.trim().toLowerCase().replace(/^@/, '');
  const matching = q
    ? state.creators.filter((c) => {
        const handle = String(c.username || '').toLowerCase();
        const display = String(c.display_name || '').toLowerCase();
        return handle.includes(q) || display.includes(q);
      })
    : state.creators;

  const limit = q ? CREATOR_SEARCH_LIMIT : CREATOR_TOP_LIMIT;
  const visibleCreators = matching.slice(0, limit);

  if (state.filters.creatorId) {
    const selectedCreator = state.creators.find((c) => c.id === state.filters.creatorId);
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
      img.className = 'creator-chip-img';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
      chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = `@${c.username}`;
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
    const totalCreatorsCount = state.creators.length;
    if (totalCreatorsCount === 0) {
      creatorStripMeta.textContent = '';
    } else if (q) {
      creatorStripMeta.textContent = matching.length === 0
        ? `No creators matching "@${q}"`
        : `Showing ${Math.min(matching.length, limit)} of ${matching.length.toLocaleString()} matches`;
    } else {
      const shownCount = Math.min(totalCreatorsCount, CREATOR_TOP_LIMIT);
      creatorStripMeta.textContent = totalCreatorsCount > CREATOR_TOP_LIMIT
        ? `Showing top ${shownCount} of ${totalCreatorsCount.toLocaleString()}`
        : `${totalCreatorsCount.toLocaleString()} creators`;
    }
  }

  resetCreatorBtn.hidden = !state.filters.creatorId;
}

/**
 * Selects a creator for filtering, resets pagination to page 1, syncs URL, and fetches reels.
 * @param {string} id
 */
function selectCreator(id) {
  state.filters.creatorId = id;
  state.filters.page = 1;
  syncUrlState();
  renderCreatorStrip();
  fetchReels();
}

/**
 * Queries reels matching active filters, pagination, and search terms with abort safety and inline error recovery.
 */
async function fetchReels() {
  if (fetchReelsAbortController) {
    fetchReelsAbortController.abort();
  }
  fetchReelsAbortController = new AbortController();
  const { signal } = fetchReelsAbortController;

  resultsCount.textContent = 'Querying saved reels...';

  const params = new URLSearchParams();
  if (state.filters.creatorId) params.set('creatorId', state.filters.creatorId);
  if (state.filters.datePreset !== 'all') params.set('datePreset', state.filters.datePreset);
  if (state.filters.watchStatus !== 'all') params.set('watchStatus', state.filters.watchStatus);
  if (state.filters.sortBy) params.set('sortBy', state.filters.sortBy);
  if (state.filters.search.trim()) params.set('search', state.filters.search.trim());
  params.set('page', String(state.filters.page));
  params.set('limit', String(state.filters.limit));

  try {
    const res = await fetch(`/api/reels?${params.toString()}`, { signal });
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

    state.reels = data.reels || [];
    state.total = data.total || 0;

    renderReels();
    updatePagination(data.page, data.limit, data.total);
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.error('Failed to fetch reels:', e);
    renderFetchErrorState(e?.message || 'Unable to reach server');
  }
}

/**
 * Renders an inline, actionable recovery state cleanly inside both Grid and List canvases.
 * @param {string} errorDetail
 */
function renderFetchErrorState(errorDetail) {
  resultsCount.textContent = 'Could not load saved reels.';
  paginationBar.classList.add('is-hidden');

  const safeDetail = escapeHtml(errorDetail);
  const resetBtnHtml = hasActiveFilters()
    ? '<button type="button" class="nav-btn nav-btn-secondary" data-action="reset-all-filters">Reset Filters</button>'
    : '';
  const errorHtml = `
    <div class="vault-error-state" role="alert">
      <div class="empty-title-text">Couldn&rsquo;t Load Saved Reels</div>
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
 * Selects the authoritative timestamp string to display for a reel card/slide based on sort context.
 * @param {object} reel
 * @returns {{ labelPrefix: 'Saved' | 'Published', iso: string }}
 */
function getReelDisplayDate(reel) {
  const sort = state.filters.sortBy;
  if (sort === 'newest_published' || sort === 'oldest_published') {
    return {
      labelPrefix: 'Published',
      iso: reel.taken_at || reel.saved_at || reel.first_detected_at || '',
    };
  }
  return {
    labelPrefix: 'Saved',
    iso: reel.saved_at || reel.first_detected_at || reel.taken_at || '',
  };
}

const EXTERNAL_LINK_GLYPH = '<svg class="external-link-glyph" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
const CHECK_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

/**
 * Returns crisp inner markup for a catalog status pill button.
 * @param {string} status
 * @returns {string}
 */
function renderStatusPillContent(status) {
  const label = escapeHtml(formatStatusLabel(status));
  return status === 'watched' ? `${CHECK_ICON_SVG}<span>${label}</span>` : `<span>${label}</span>`;
}

/**
 * Returns hover tooltip text clarifying 1-click Watched toggle behavior.
 * @param {string} status
 * @returns {string}
 */
function getStatusPillTitle(status) {
  return status === 'watched' ? 'Mark as Unwatched' : 'Mark as Watched';
}

/**
 * Returns screen-reader label describing both the 1-click toggle action and current status.
 * @param {string} status
 * @param {string} creatorName
 * @returns {string}
 */
function getStatusPillAriaLabel(status, creatorName) {
  const action = status === 'watched' ? 'Mark Unwatched' : 'Mark Watched';
  return `${action} for @${creatorName} (currently ${formatStatusLabel(status)})`;
}

/**
 * Renders reel poster cards in grid view and table rows in list view with accessible, non-nested controls.
 */
function renderReels() {
  reelsGrid.innerHTML = '';
  reelsTableBody.innerHTML = '';

  if (state.reels.length === 0) {
    resultsCount.textContent = '0 saved reels match your view';
    const filtersActive = hasActiveFilters();
    const emptyTitle = filtersActive ? 'No Matching Saved Reels' : 'Your Vault Is Empty';
    const emptyDesc = filtersActive
      ? 'No saved reels match the active creator, date, status, or keyword filters.'
      : 'Import Instagram’s saved_posts.json export to start browsing and organizing your saved reels.';
    const emptyActionHtml = filtersActive
      ? '<button type="button" class="nav-btn nav-btn-primary" data-action="reset-all-filters">Reset Filters</button>'
      : '<button type="button" class="nav-btn nav-btn-primary" data-action="empty-import">Import saved_posts.json</button>';

    const emptyHtml = `
      <div class="vault-empty-state">
        <div class="empty-title-text">${emptyTitle}</div>
        <div class="empty-desc-text">${emptyDesc}</div>
        <div class="state-actions-row">
          ${emptyActionHtml}
        </div>
      </div>
    `;
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
    return;
  }

  if (reelsTable) reelsTable.hidden = false;
  if (reelsTableContainer) reelsTableContainer.classList.remove('is-empty-state');
  if (reelsTableState) {
    reelsTableState.hidden = true;
    reelsTableState.innerHTML = '';
  }

  const rangeStart = (state.filters.page - 1) * state.filters.limit + 1;
  const rangeEnd = Math.min(state.filters.page * state.filters.limit, state.total);
  const unit = state.total === 1 ? 'reel' : 'reels';
  resultsCount.textContent = `Showing ${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${state.total.toLocaleString()} saved ${unit}`;

  for (let idx = 0; idx < state.reels.length; idx++) {
    const reel = state.reels[idx];
    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreator = escapeHtml(creatorName);
    const safeReelUrl = escapeHtml(sanitizeExternalHref(reel.reel_url, 'https://www.instagram.com/'));
    const initial = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();
    const dateInfo = getReelDisplayDate(reel);
    const dateFormatted = formatShortDate(dateInfo.iso);
    const isWatchLater = reel.watch_status === 'watch_later';
    const isWatched = reel.watch_status === 'watched';
    const pillTitle = escapeHtml(getStatusPillTitle(reel.watch_status));
    const pillAria = escapeHtml(getStatusPillAriaLabel(reel.watch_status, creatorName));
    const rawCaption = reel.caption || 'No caption provided';
    const safeCaption = escapeHtml(rawCaption);
    const rankNum = (rangeStart + idx).toLocaleString();
    const cleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
    const hasRealThumbnail = Boolean(cleanThumbnail && !isPlaceholderMediaUrl(cleanThumbnail));

    // 1. Grid Poster Card (<article> + separate sibling play trigger, bookmark, profile link, and 1-click Watched toggle)
    const card = document.createElement('article');
    card.className = 'vault-poster-card';
    card.setAttribute('data-id', reel.id);

    const monogramArtHtml = `
      <div class="monochrome-poster-art">
        <div class="art-center-block">
          <div class="art-monogram-circle" aria-hidden="true">${initial}</div>
          <div class="art-reel-id">${escapeHtml(reel.shortcode || 'Saved Reel')}</div>
          <div class="art-poster-kind">Saved Post</div>
        </div>
        <div class="poster-bottom-scrim"></div>
      </div>
    `;

    const imageLayerHtml = hasRealThumbnail
      ? `
        <img class="poster-actual-img" src="${escapeHtml(cleanThumbnail)}" alt="Reel poster by @${safeCreator}" loading="lazy" />
        <div class="poster-top-scrim"></div>
        <div class="poster-bottom-scrim"></div>
      `
      : '';

    card.innerHTML = `
      <div class="poster-media-box">
        ${monogramArtHtml}
        ${imageLayerHtml}
        <button type="button" class="poster-play-trigger" aria-label="Play reel #${rankNum} by @${safeCreator} in fullscreen feed">
          <span class="play-hover-trigger" aria-hidden="true">
            <span class="play-icon-box">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </span>
          </span>
        </button>
        <div class="card-header-overlay">
          <span class="rank-tag" aria-hidden="true">#${rankNum}</span>
          <button type="button" class="card-bookmark-btn ${isWatchLater ? 'active' : ''}" title="${isWatchLater ? 'Remove from Watch Later' : 'Save to Watch Later'}" aria-label="${isWatchLater ? `Remove @${safeCreator} from Watch Later` : `Save @${safeCreator} to Watch Later`}" aria-pressed="${isWatchLater}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="card-details-box">
        <div class="card-creator-row">
          <a class="card-handle-link" href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" title="Open @${safeCreator}'s post on Instagram"><span class="handle-text">@${safeCreator}</span>${EXTERNAL_LINK_GLYPH}</a>
        </div>
        <div class="card-caption-line">${safeCaption}</div>
        <div class="card-footer-meta">
          <span class="card-date-label">${dateInfo.labelPrefix} ${dateFormatted}</span>
          <button type="button" class="status-pill-toggle status-pill-${reel.watch_status}" data-id="${reel.id}" title="${pillTitle}" aria-label="${pillAria}" aria-pressed="${isWatched}">
            ${renderStatusPillContent(reel.watch_status)}
          </button>
        </div>
      </div>
    `;

    const posterPlayTrigger = card.querySelector('.poster-play-trigger');
    posterPlayTrigger.addEventListener('click', () => {
      openReelsFeed(reel, posterPlayTrigger);
    });

    const cardBookmark = card.querySelector('.card-bookmark-btn');
    cardBookmark.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextStatus = reel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later';
      updateReelStatus(reel.id, nextStatus);
    });

    const cardStatusBtn = card.querySelector('.status-pill-toggle');
    cardStatusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchedStatus(reel.id, reel.watch_status);
    });

    const cardImg = card.querySelector('.poster-actual-img');
    if (cardImg) {
      cardImg.addEventListener('error', () => { cardImg.hidden = true; }, { once: true });
      if (reel.shortcode) {
        /**
         * Records natural thumbnail aspect ratio once loaded to inform pre-probe geometry.
         */
        const recordRatio = () => {
          if (cardImg.naturalWidth > 0 && cardImg.naturalHeight > 0) {
            state.thumbRatioCache.set(reel.shortcode, cardImg.naturalWidth / cardImg.naturalHeight);
          }
        };
        if (cardImg.complete) {
          recordRatio();
        } else {
          cardImg.addEventListener('load', recordRatio, { once: true });
        }
      }
    }

    reelsGrid.appendChild(card);

    // 2. Responsive Table Row (List View)
    const row = document.createElement('tr');
    row.className = 'table-row';
    row.setAttribute('data-id', reel.id);

    row.innerHTML = `
      <td class="table-rank">#${rankNum}</td>
      <td>
        <div class="table-creator-cell">
          <div class="table-creator-avatar" aria-hidden="true">${initial}</div>
          <a class="table-handle" href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" title="Open @${safeCreator}'s post on Instagram"><span class="handle-text">@${safeCreator}</span></a>
        </div>
      </td>
      <td class="table-caption-cell"><div class="table-caption-clamp" title="${safeCaption}">${safeCaption}</div></td>
      <td class="table-date-cell">${dateFormatted}</td>
      <td>
        <button type="button" class="status-pill-toggle status-pill-${reel.watch_status}" data-id="${reel.id}" title="${pillTitle}" aria-label="${pillAria}" aria-pressed="${isWatched}">
          ${renderStatusPillContent(reel.watch_status)}
        </button>
      </td>
      <td>
        <div class="table-actions-cell">
          <button type="button" class="table-action-icon-btn btn-table-play" title="Play Reel in Feed" aria-label="Play reel by @${safeCreator} in feed">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </button>
          <button type="button" class="table-action-icon-btn btn-table-bookmark ${isWatchLater ? 'active' : ''}" title="${isWatchLater ? 'Remove from Watch Later' : 'Add to Watch Later'}" aria-label="${isWatchLater ? `Remove @${safeCreator} from Watch Later` : `Add @${safeCreator} to Watch Later`}" aria-pressed="${isWatchLater}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <a class="table-action-icon-btn" href="${safeReelUrl}" target="_blank" rel="noopener noreferrer" title="Open on Instagram" aria-label="Open reel by @${safeCreator} on Instagram">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </a>
        </div>
      </td>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      openReelsFeed(reel, row.querySelector('.btn-table-play'));
    });

    const tablePlayBtn = row.querySelector('.btn-table-play');
    tablePlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReelsFeed(reel, tablePlayBtn);
    });

    row.querySelector('.btn-table-bookmark').addEventListener('click', (e) => {
      e.stopPropagation();
      const nextStatus = reel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later';
      updateReelStatus(reel.id, nextStatus);
    });

    row.querySelector('.status-pill-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchedStatus(reel.id, reel.watch_status);
    });

    reelsTableBody.appendChild(row);
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
  const creatorName = reel?.creator?.username || 'instagram_user';
  const pillTitle = getStatusPillTitle(newStatus);
  const pillAria = getStatusPillAriaLabel(newStatus, creatorName);
  const pillHtml = renderStatusPillContent(newStatus);

  const card = reelsGrid.querySelector(`.vault-poster-card[data-id="${escapedId}"]`);
  if (card) {
    const bookmark = card.querySelector('.card-bookmark-btn');
    if (bookmark) {
      bookmark.classList.toggle('active', isWatchLater);
      bookmark.setAttribute('aria-pressed', String(isWatchLater));
      bookmark.setAttribute('title', isWatchLater ? 'Remove from Watch Later' : 'Save to Watch Later');
      bookmark.setAttribute('aria-label', isWatchLater ? `Remove @${creatorName} from Watch Later` : `Save @${creatorName} to Watch Later`);
      const svg = bookmark.querySelector('svg');
      if (svg) svg.setAttribute('fill', isWatchLater ? 'currentColor' : 'none');
    }
    const pill = card.querySelector('.status-pill-toggle');
    if (pill) {
      pill.className = `status-pill-toggle status-pill-${newStatus}`;
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
      bookmark.setAttribute('title', isWatchLater ? 'Remove from Watch Later' : 'Add to Watch Later');
      bookmark.setAttribute('aria-label', isWatchLater ? `Remove @${creatorName} from Watch Later` : `Add @${creatorName} to Watch Later`);
      const svg = bookmark.querySelector('svg');
      if (svg) svg.setAttribute('fill', isWatchLater ? 'currentColor' : 'none');
    }
    const pill = row.querySelector('.status-pill-toggle');
    if (pill) {
      pill.className = `status-pill-toggle status-pill-${newStatus}`;
      pill.innerHTML = pillHtml;
      pill.setAttribute('title', pillTitle);
      pill.setAttribute('aria-label', pillAria);
      pill.setAttribute('aria-pressed', String(isWatched));
    }
  }
}

/**
 * Sends a status update to the server, patches catalog and feed controls in place, and surfaces errors visibly.
 * @param {string} reelId
 * @param {'unwatched' | 'watch_later' | 'watched'} newStatus
 */
async function updateReelStatus(reelId, newStatus) {
  try {
    const res = await fetch(`/api/reels/${encodeURIComponent(reelId)}/status`, {
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
    announceStatus(`Marked @${target?.creator?.username || 'reel'} as ${formatStatusLabel(newStatus)}.`);
    loadStats();
  } catch (e) {
    console.error('Failed to update status:', e);
    showToast(`Could not update watch status: ${e?.message || 'Request failed'}. Please retry.`, 'error');
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

/**
 * Fetches server-side media kind & natural cover aspect ratio for a shortcode when DB thumbnail/efg is missing.
 * Deduplicates concurrent requests and caches in state.metaCache.
 * @param {string} shortcode
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ isClips: boolean | null, mediaKind: string, thumbAspectRatio: number | null, thumbnailUrl: string | null } | null>}
 */
async function fetchShortcodeMeta(shortcode, signal) {
  if (!shortcode) return null;
  if (state.metaCache.has(shortcode)) {
    return state.metaCache.get(shortcode);
  }
  if (metaInFlightMap.has(shortcode)) {
    return metaInFlightMap.get(shortcode);
  }

  const reqPromise = (async () => {
    try {
      const res = await fetch(`/api/reels/${encodeURIComponent(shortcode)}/meta`, { signal });
      if (!res.ok) return null;
      const data = await res.json();
      state.metaCache.set(shortcode, data);
      return data;
    } catch (_) {
      return null;
    } finally {
      metaInFlightMap.delete(shortcode);
    }
  })();

  metaInFlightMap.set(shortcode, reqPromise);
  return reqPromise;
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

  return {
    embedRatio: cached?.embedRatio ?? null,
    isClips: cached?.isClips ?? serverMeta?.isClips ?? thumbMeta.isClips ?? null,
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
    posterImg.className = 'reel-poster-underlay';
    posterImg.alt = '';
    posterImg.setAttribute('aria-hidden', 'true');
    const iframeBox = viewport.querySelector('.reel-iframe-container');
    viewport.insertBefore(posterImg, iframeBox || null);
  }
  posterImg.hidden = false;
  posterImg.src = url;
  posterImg.addEventListener('load', () => {
    if (recordRatio && posterImg.naturalWidth > 0 && posterImg.naturalHeight > 0 && shortcode) {
      state.thumbRatioCache.set(shortcode, posterImg.naturalWidth / posterImg.naturalHeight);
      const iframe = slide.querySelector('.reel-player-iframe');
      if (!iframe || iframe.dataset.probing === '1') {
        applySlideStage(slide, reel);
      }
    }
  }, { once: true });
  posterImg.addEventListener('error', () => {
    posterImg.hidden = true;
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

  let knownIsClips = cached?.isClips ?? state.metaCache.get(shortcode)?.isClips ?? thumbMeta.isClips ?? null;
  let knownThumbRatio = cached?.thumbAspectRatio ?? state.metaCache.get(shortcode)?.thumbAspectRatio ?? state.thumbRatioCache.get(shortcode) ?? null;

  const posterImg = slide.querySelector('.reel-poster-underlay');
  const posterBroken = posterImg && posterImg.hidden;
  const probeIndicator = slide.querySelector('.reel-probe-indicator');
  const fallbackBox = slide.querySelector('.reel-embed-fallback');
  if (probeIndicator) probeIndicator.classList.remove('is-visible');
  if (fallbackBox) fallbackBox.hidden = true;

  const iframe = document.createElement('iframe');
  iframe.src = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/`;
  iframe.className = 'reel-player-iframe';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('loading', 'eager');
  iframe.setAttribute('title', `Instagram post by @${reel.creator?.username || 'creator'}`);

  const abortController = new AbortController();
  let metaPromise = null;
  if (knownIsClips === null || !hasRealThumbnail || posterBroken) {
    metaPromise = fetchShortcodeMeta(shortcode, abortController.signal).then((meta) => {
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
    settled = true;
    delete iframe.dataset.probing;
    clearProbeUi();

    if (showFallback && !mounted && fallbackBox) {
      cleanupListeners();
      fallbackBox.hidden = false;
      return;
    }

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
     * Marks the embed iframe visible after geometry settles.
     */
    const revealNow = () => {
      revealTimer = null;
      if (!abortController.signal.aborted) {
        iframe.classList.add('is-ready');
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

    if (phase === 'cached') {
      if (msg.type === 'MOUNTED') {
        mounted = true;
        finalizeAndReveal(cached.embedRatio, false, 80, false);
      }
      return;
    }

    if (phase === 'w1') {
      if (msg.type === 'MOUNTED') {
        mounted = true;
      }
      if (msg.type === 'MEASURE' && msg.height && msg.height > 150) {
        h1 = msg.height;
      }
      if (mounted && h1 !== null) {
        phase = 'w2';
        iframe.style.width = `${ReelerGeometry.PROBE_WIDTH_2}px`;
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = setTimeout(() => {
            phase = 'aborted';
            finalizeAndReveal(null, false, 0, false);
          }, 2500);
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

      finalizeAndReveal(measuredRatio, true, 180, false);
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
      finalizeAndReveal(cached.embedRatio, false, 0, !mounted);
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
      finalizeAndReveal(null, false, 0, !mounted);
    }, 6500);
  }
}

/**
 * Constructs 100dvh reel slides for the vertical snap feed with adaptive framing.
 */
function renderFeedSlides() {
  const existingBoxes = feedScrollTrack.querySelectorAll('.reel-iframe-container');
  existingBoxes.forEach((box) => unmountSlideIframe(box));
  feedScrollTrack.innerHTML = '';

  state.reels.forEach((reel, index) => {
    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreator = escapeHtml(creatorName);
    const safeReelUrl = escapeHtml(sanitizeExternalHref(reel.reel_url, 'https://www.instagram.com/'));
    const safeCreatorUrl = escapeHtml(`https://www.instagram.com/${encodeURIComponent(creatorName)}/`);
    const initial = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();
    const isWatchLater = reel.watch_status === 'watch_later';
    const isWatched = reel.watch_status === 'watched';
    const cleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
    const hasRealThumbnail = Boolean(cleanThumbnail && !isPlaceholderMediaUrl(cleanThumbnail));
    const dateInfo = getReelDisplayDate(reel);
    const dateFormatted = formatShortDate(dateInfo.iso);
    const captionText = reel.caption || 'No caption available for this reel.';

    const slide = document.createElement('div');
    slide.className = 'feed-reel-slide';
    slide.setAttribute('data-reel-id', reel.id);
    slide.setAttribute('data-index', String(index));

    slide.innerHTML = `
      <div class="reel-stage-wrapper">
        <div class="reel-media-slot">
          <div class="reel-media-viewport">
            <div class="reel-monogram-underlay" aria-hidden="true">
              <div class="feed-monogram-circle">${initial}</div>
              <div class="feed-monogram-handle">@${safeCreator}</div>
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
            <!-- Boundary-Masked Clean Iframe Container (Zero white Instagram chrome) -->
            <div class="reel-iframe-container" id="feed-iframe-box-${reel.id}"></div>
          </div>

          <!-- Adaptive Action Rail (Right Side on Desktop / Horizontal Strip on Compact) -->
          <div class="reel-actions-rail">
            <div class="rail-action-item">
              <button type="button" class="rail-action-btn ${isWatched ? 'active-watched' : ''}" data-action="feed-toggle-watched" title="Mark Watched (w)" aria-label="Mark Watched" aria-pressed="${isWatched}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </button>
              <span class="rail-action-sublabel">Watched</span>
            </div>

            <div class="rail-action-item">
              <button type="button" class="rail-action-btn ${isWatchLater ? 'active-later' : ''}" data-action="feed-toggle-later" title="Watch Later (l)" aria-label="Watch Later" aria-pressed="${isWatchLater}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
              </button>
              <span class="rail-action-sublabel">Later</span>
            </div>

            <div class="rail-action-item">
              <button type="button" class="rail-action-btn" data-action="feed-copy-link" title="Copy Reel Link (c)" aria-label="Copy Reel Link">
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
              <a href="${safeCreatorUrl}" target="_blank" rel="noopener noreferrer" class="reel-creator-handle" title="Open @${safeCreator}'s profile on Instagram"><span class="handle-text">@${safeCreator}</span></a>
              <span class="reel-saved-badge">${dateInfo.labelPrefix} ${dateFormatted}</span>
            </div>
          </div>
          <div class="reel-caption-wrap" id="caption-wrap-${reel.id}">
            <p class="reel-caption-text">${escapeHtml(captionText)}</p>
            ${captionText.length > 90 ? '<button type="button" class="reel-caption-toggle" data-action="toggle-caption" aria-expanded="false">more</button>' : ''}
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
        toggleCaptionBtn.setAttribute('aria-expanded', String(isExp));
        return;
      }

      const watchedBtn = e.target.closest('[data-action="feed-toggle-watched"]');
      if (watchedBtn) {
        const newStatus = reel.watch_status === 'watched' ? 'unwatched' : 'watched';
        await updateReelStatus(reel.id, newStatus);
        return;
      }

      const laterBtn = e.target.closest('[data-action="feed-toggle-later"]');
      if (laterBtn) {
        const newStatus = reel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later';
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
      }
    });

    feedScrollTrack.appendChild(slide);
  });

  setupFeedIntersectionObserver();
}

/**
 * Copies the canonical Instagram URL for a slide and temporarily flashes status on the Copy sublabel.
 * @param {HTMLElement} slide
 * @param {object} reel
 */
async function copySlideLink(slide, reel) {
  const copyLabel = slide?.querySelector('.copy-label');
  const url = sanitizeExternalHref(reel?.reel_url, 'https://www.instagram.com/');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(url);
    if (copyLabel) copyLabel.textContent = 'Copied!';
    announceStatus('Reel link copied to clipboard.');
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
  feedArrowDown.disabled = index >= state.reels.length - 1;
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

        feedCounterKicker.textContent = `REEL ${index + 1} OF ${state.reels.length}`;
        feedShortcodeTag.textContent = `ID: ${reel?.shortcode || '—'}`;
        updateFeedNavArrows(index);

        if (reel) {
          mountFeedIframe(slide, reel);
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
  feedCounterKicker.textContent = `REEL ${startIndex + 1} OF ${state.reels.length}`;
  feedShortcodeTag.textContent = `ID: ${startReel?.shortcode || '—'}`;
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
  }
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
  const isWatched = newStatus === 'watched';
  const isLater = newStatus === 'watch_later';

  if (watchedBtn) {
    watchedBtn.classList.toggle('active-watched', isWatched);
    watchedBtn.setAttribute('aria-pressed', String(isWatched));
  }
  if (laterBtn) {
    laterBtn.classList.toggle('active-later', isLater);
    laterBtn.setAttribute('aria-pressed', String(isLater));
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
 * Dispatches an obsidian dark-mode toast notification with SVG dismiss button for errors.
 * @param {string} message
 * @param {'info' | 'success' | 'error'} type
 */
function showToast(message, type = 'info') {
  let toastContainer = document.getElementById('vault-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'vault-toast-container';
    toastContainer.className = 'vault-toast-container';
    document.body.appendChild(toastContainer);
  }
  const isError = type === 'error';
  const toast = document.createElement('div');
  toast.className = `vault-toast vault-toast-${type}`;
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.innerHTML = `
    <span class="toast-dot" aria-hidden="true"></span>
    <span class="toast-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</span>
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

    e.preventDefault();
    const currentIndex = focusables.indexOf(document.activeElement);
    if (currentIndex === -1) {
      (e.shiftKey ? focusables[focusables.length - 1] : focusables[0]).focus();
    } else if (e.shiftKey) {
      const prevIndex = (currentIndex - 1 + focusables.length) % focusables.length;
      focusables[prevIndex].focus();
    } else {
      const nextIndex = (currentIndex + 1) % focusables.length;
      focusables[nextIndex].focus();
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
  viewModeGridBtn.addEventListener('click', () => applyViewMode('grid'));
  viewModeListBtn.addEventListener('click', () => applyViewMode('list'));

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
  }

  feedCloseBtn.addEventListener('click', closeReelsFeed);
  feedArrowUp.addEventListener('click', () => scrollFeedBy(-1));
  feedArrowDown.addEventListener('click', () => scrollFeedBy(1));

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

    if (shortcutsPopover && !shortcutsPopover.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShortcutsPopover(true);
        return;
      }
      if (e.key === 'Tab') {
        const popoverFocusables = Array.from(
          shortcutsPopover.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ).filter(isVisibleFocusable);
        if (popoverFocusables.length > 0) {
          e.preventDefault();
          const idx = popoverFocusables.indexOf(document.activeElement);
          if (idx === -1) {
            (e.shiftKey ? popoverFocusables[popoverFocusables.length - 1] : popoverFocusables[0]).focus();
          } else if (e.shiftKey) {
            popoverFocusables[(idx - 1 + popoverFocusables.length) % popoverFocusables.length].focus();
          } else {
            popoverFocusables[(idx + 1) % popoverFocusables.length].focus();
          }
          return;
        }
      }
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
    }
  });

  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value;
    clearSearchBtn.hidden = !val;
    searchTimeout = setTimeout(() => {
      state.filters.search = val;
      state.filters.page = 1;
      syncUrlState();
      fetchReels();
    }, 220);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    state.filters.search = '';
    state.filters.page = 1;
    syncUrlState();
    fetchReels();
    if (!window.matchMedia?.('(pointer: coarse)').matches) {
      searchInput.focus();
    }
  });

  if (creatorFilterInput) {
    creatorFilterInput.addEventListener('input', (e) => {
      state.creatorQuery = e.target.value || '';
      if (clearCreatorFilterBtn) {
        clearCreatorFilterBtn.hidden = !state.creatorQuery;
      }
      renderCreatorStrip();
    });
  }

  if (clearCreatorFilterBtn && creatorFilterInput) {
    clearCreatorFilterBtn.addEventListener('click', () => {
      creatorFilterInput.value = '';
      state.creatorQuery = '';
      clearCreatorFilterBtn.hidden = true;
      renderCreatorStrip();
      if (!window.matchMedia?.('(pointer: coarse)').matches) {
        creatorFilterInput.focus();
      }
    });
  }

  datePresetSelect.addEventListener('change', (e) => {
    state.filters.datePreset = e.target.value;
    state.filters.page = 1;
    syncUrlState();
    fetchReels();
  });

  watchFilterSelect.addEventListener('change', (e) => {
    state.filters.watchStatus = e.target.value;
    state.filters.page = 1;
    syncUrlState();
    fetchReels();
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
    /**
     * Parses, clamps, and navigates to a user-entered page number on submit or blur.
     */
    const commitPageJump = () => {
      const maxPage = Math.max(1, parseInt(pageJumpInput.dataset.maxPage || '1', 10) || 1);
      const currentPage = Math.max(1, parseInt(pageJumpInput.dataset.currentPage || String(state.filters.page), 10) || 1);
      const parsed = parseInt(String(pageJumpInput.value || '').replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(parsed)) {
        pageJumpInput.value = String(currentPage);
        return;
      }
      const targetPage = Math.max(1, Math.min(parsed, maxPage));
      pageJumpInput.value = String(targetPage);
      if (targetPage === state.filters.page) return;
      state.filters.page = targetPage;
      syncUrlState();
      fetchReels();
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    };

    pageJumpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      commitPageJump();
    });
    pageJumpInput.addEventListener('blur', commitPageJump);
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
      const res = await fetch('/api/archive/import', {
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
      const errCount = data?.errors?.length ?? 0;
      const summary = `Archive processed!\n• New reels imported: ${imported}\n• Already present: ${alreadyIn}`;
      if (data?.status === 'partial' || errCount > 0) {
        showToast(`${summary}\n• Items with errors: ${errCount}`, 'error');
      } else {
        showToast(summary, 'success');
      }
      await Promise.all([loadStats(), loadCreators(), fetchReels()]);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      archiveFileInput.value = '';
      importBtn.innerHTML = originalContent;
      importBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
