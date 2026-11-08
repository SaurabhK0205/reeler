// ==============================================================================
// REELER — LINEAR MONOCHROME VAULT APPLICATION LOGIC
// Dual View (Poster Grid + Dense Table) & Fullscreen Snap Reels Feed
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
  viewMode: readViewMode(),
  total: 0,
  reels: [],
  creators: [],
  stats: null,
  currentFeedReelId: null,
  currentFeedIndex: 0,
  previouslyFocusedElement: null,
};

// DOM References
const dbBadge = document.getElementById('db-badge');
const importBtn = document.getElementById('import-btn');
const archiveFileInput = document.getElementById('archive-file-input');
const statTotal = document.getElementById('stat-total');
const statCreators = document.getElementById('stat-creators');
const statWeek = document.getElementById('stat-week');
const statWatchLater = document.getElementById('stat-watch-later');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const datePresetSelect = document.getElementById('date-preset');
const watchFilterSelect = document.getElementById('watch-filter');
const sortBySelect = document.getElementById('sort-by');
const creatorPillsList = document.getElementById('creator-pills-list');
const resetCreatorBtn = document.getElementById('reset-creator-btn');
const reelsGrid = document.getElementById('reels-grid');
const reelsTableContainer = document.getElementById('reels-table-container');
const reelsTableBody = document.getElementById('reels-table-body');
const resultsCount = document.getElementById('results-count');
const paginationBar = document.getElementById('pagination-bar');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
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

// --- Initialization ---

/**
 * Initializes the vault application, binds events, and loads data.
 */
async function init() {
  applyViewMode(state.viewMode);
  setupEventListeners();
  await checkHealth();
  await Promise.all([loadStats(), loadCreators(), fetchReels()]);
}

/**
 * Applies grid or list view mode to the UI and updates button states.
 * @param {'grid' | 'list'} mode
 */
function applyViewMode(mode) {
  state.viewMode = mode;
  saveViewMode(mode);

  if (mode === 'grid') {
    viewModeGridBtn.classList.add('active');
    viewModeListBtn.classList.remove('active');
    reelsGrid.style.display = 'grid';
    reelsTableContainer.style.display = 'none';
  } else {
    viewModeListBtn.classList.add('active');
    viewModeGridBtn.classList.remove('active');
    reelsGrid.style.display = 'none';
    reelsTableContainer.style.display = 'block';
  }
}

/**
 * Checks server and database connectivity, updating the status indicator badge.
 */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.database === 'supabase') {
      dbBadge.className = 'nav-badge connected';
      dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-label">Supabase (Cloud)</span>';
    } else {
      dbBadge.className = 'nav-badge local';
      dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-label">In-Memory Store</span>';
    }
  } catch (_) {
    dbBadge.className = 'nav-badge';
    dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-label">Offline</span>';
  }
}

/**
 * Fetches summary statistics from the server and populates metric cards.
 */
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const stats = await res.json();
    state.stats = stats;
    statTotal.textContent = Number(stats.totalReels || 0).toLocaleString();
    statCreators.textContent = Number(stats.totalCreators || 0).toLocaleString();
    statWeek.textContent = Number(stats.savedThisWeek || 0).toLocaleString();
    statWatchLater.textContent = Number(stats.watchLaterCount || 0).toLocaleString();
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

/**
 * Fetches unique creators and populates the filter strip.
 */
async function loadCreators() {
  try {
    const res = await fetch('/api/creators');
    if (!res.ok) return;
    state.creators = await res.json();
    renderCreatorStrip();
  } catch (e) {
    console.error('Failed to load creators:', e);
  }
}

/**
 * Renders the horizontal list of creator filter chips with counts.
 */
function renderCreatorStrip() {
  creatorPillsList.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = `creator-chip ${!state.filters.creatorId ? 'active' : ''}`;
  allBtn.textContent = 'All Creators';
  allBtn.onclick = () => selectCreator('');
  creatorPillsList.appendChild(allBtn);

  for (const c of state.creators) {
    const chip = document.createElement('button');
    chip.className = `creator-chip ${state.filters.creatorId === c.id ? 'active' : ''}`;

    if (c.profile_picture_url) {
      const img = document.createElement('img');
      img.src = c.profile_picture_url;
      img.className = 'creator-chip-img';
      img.alt = c.username;
      img.onerror = () => { img.style.display = 'none'; };
      chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = `@${c.username}`;
    chip.appendChild(name);

    if (c.saved_count) {
      const counter = document.createElement('span');
      counter.className = 'chip-counter';
      counter.textContent = c.saved_count;
      chip.appendChild(counter);
    }

    chip.onclick = () => selectCreator(c.id);
    creatorPillsList.appendChild(chip);
  }

  resetCreatorBtn.style.display = state.filters.creatorId ? 'inline' : 'none';
}

/**
 * Selects a creator for filtering and resets pagination to page 1.
 * @param {string} id
 */
function selectCreator(id) {
  state.filters.creatorId = id;
  state.filters.page = 1;
  renderCreatorStrip();
  fetchReels();
}

/**
 * Queries reels matching active filters, pagination, and search terms.
 */
async function fetchReels() {
  resultsCount.textContent = 'Querying vault...';
  reelsGrid.innerHTML = '';
  reelsTableBody.innerHTML = '';

  const params = new URLSearchParams();
  if (state.filters.creatorId) params.set('creatorId', state.filters.creatorId);
  if (state.filters.datePreset !== 'all') params.set('datePreset', state.filters.datePreset);
  if (state.filters.watchStatus !== 'all') params.set('watchStatus', state.filters.watchStatus);
  if (state.filters.sortBy) params.set('sortBy', state.filters.sortBy);
  if (state.filters.search.trim()) params.set('search', state.filters.search.trim());
  params.set('page', state.filters.page);
  params.set('limit', state.filters.limit);

  try {
    const res = await fetch(`/api/reels?${params.toString()}`);
    if (!res.ok) throw new Error('API request failed');
    const data = await res.json();

    state.reels = data.reels || [];
    state.total = data.total || 0;

    renderReels();
    updatePagination(data.page, data.limit, data.total);
  } catch (e) {
    console.error('Failed to fetch reels:', e);
    resultsCount.textContent = 'Failed to load reels. Please retry.';
  }
}

/**
 * Renders reel poster cards in grid view and table rows in list view.
 */
function renderReels() {
  reelsGrid.innerHTML = '';
  reelsTableBody.innerHTML = '';

  if (state.reels.length === 0) {
    resultsCount.textContent = '0 reels found';
    const emptyMarkup = `
      <div class="vault-empty-state">
        <div class="empty-title-text">No Matching Saved Reels</div>
        <div class="empty-desc-text">Try adjusting filters, clearing keywords, or importing new reels.</div>
      </div>
    `;
    reelsGrid.innerHTML = emptyMarkup;
    reelsTableBody.innerHTML = `<tr><td colspan="6" style="padding:0;">${emptyMarkup}</td></tr>`;
    return;
  }

  const rangeStart = (state.filters.page - 1) * state.filters.limit + 1;
  const rangeEnd = Math.min(state.filters.page * state.filters.limit, state.total);
  resultsCount.textContent = `Showing ${rangeStart}–${rangeEnd} of ${state.total} saved reel(s)`;

  // Render both Grid and Table DOM nodes
  for (const reel of state.reels) {
    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreator = escapeHtml(creatorName);
    const initial = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();
    const dateFormatted = formatRelativeDate(reel.taken_at || reel.saved_at);
    const isWatchLater = reel.watch_status === 'watch_later';
    const cleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
    const hasRealThumbnail = cleanThumbnail && !cleanThumbnail.includes('photo-1618005182384');

    // 1. Render Grid Poster Card
    const card = document.createElement('div');
    card.className = 'vault-poster-card';
    card.setAttribute('data-id', reel.id);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Play reel by @${creatorName}`);

    // Base artwork: always build the monochrome monogram poster as background/fallback
    const monogramArtHtml = `
      <div class="monochrome-poster-art">
        <div class="art-top-row">
          <span class="art-reel-id">REEL #${reel.save_order_rank || '—'}</span>
        </div>
        <div class="art-center-block">
          <div class="art-monogram-circle">${initial}</div>
          <div class="art-creator-text">@${safeCreator}</div>
          <div class="art-caption-quote">${escapeHtml(reel.caption || 'Saved Instagram Reel')}</div>
        </div>
        <div class="poster-bottom-scrim"></div>
      </div>
    `;

    let imageLayerHtml = '';
    if (hasRealThumbnail) {
      imageLayerHtml = `
        <img class="poster-actual-img" src="${cleanThumbnail}" alt="Reel thumbnail by @${safeCreator}" loading="lazy" onerror="this.style.display='none';" />
        <div class="poster-top-scrim"></div>
        <div class="poster-bottom-scrim"></div>
      `;
    }

    card.innerHTML = `
      <div class="poster-media-box">
        ${monogramArtHtml}
        ${imageLayerHtml}
        <div class="card-header-overlay">
          <span class="rank-tag">#${reel.save_order_rank || '—'}</span>
          <button class="card-bookmark-btn ${isWatchLater ? 'active' : ''}" title="${isWatchLater ? 'In Watch Later' : 'Add to Watch Later'}" aria-label="Toggle Watch Later">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
        </div>
        <div class="play-hover-trigger" aria-label="Play Reel in Feed">
          <div class="play-icon-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </div>
        </div>
      </div>
      <div class="card-details-box">
        <div class="card-creator-row">
          <a class="card-handle-link" href="${reel.reel_url}" target="_blank" rel="noopener noreferrer">@${safeCreator}</a>
        </div>
        <div class="card-caption-line">${escapeHtml(reel.caption || '(No caption provided)')}</div>
        <div class="card-footer-meta">
          <span class="card-date-label">${dateFormatted}</span>
          <button class="status-pill-toggle status-pill-${reel.watch_status}" data-id="${reel.id}">
            ${formatStatusLabel(reel.watch_status)}
          </button>
        </div>
      </div>
    `;

    // Click card opens fullscreen reels snap-feed
    card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('.card-bookmark-btn') || e.target.closest('.status-pill-toggle')) return;
      openReelsFeed(reel);
    });

    // Keyboard accessibility on card
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openReelsFeed(reel);
      }
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
      cycleStatus(reel.id, reel.watch_status);
    });

    reelsGrid.appendChild(card);

    // 2. Render Table Row (for List/Table View)
    const row = document.createElement('tr');
    row.className = 'table-row';
    row.setAttribute('data-id', reel.id);

    row.innerHTML = `
      <td class="table-rank">#${reel.save_order_rank || '—'}</td>
      <td>
        <div class="table-creator-cell">
          <div class="table-creator-avatar">${initial}</div>
          <a class="table-handle" href="${reel.reel_url}" target="_blank" rel="noopener noreferrer">@${safeCreator}</a>
        </div>
      </td>
      <td class="table-caption-cell">${escapeHtml(reel.caption || '(No caption)')}</td>
      <td class="table-date-cell">${dateFormatted}</td>
      <td>
        <button class="status-pill-toggle status-pill-${reel.watch_status}" data-id="${reel.id}">
          ${formatStatusLabel(reel.watch_status)}
        </button>
      </td>
      <td>
        <div class="table-actions-cell">
          <button class="table-action-icon-btn btn-table-play" title="Play Reel in Feed">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </button>
          <button class="table-action-icon-btn btn-table-bookmark ${isWatchLater ? 'active' : ''}" title="Toggle Watch Later">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <a class="table-action-icon-btn" href="${reel.reel_url}" target="_blank" rel="noopener noreferrer" title="Open on Instagram">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </a>
        </div>
      </td>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      openReelsFeed(reel);
    });

    row.querySelector('.btn-table-play').addEventListener('click', (e) => {
      e.stopPropagation();
      openReelsFeed(reel);
    });

    row.querySelector('.btn-table-bookmark').addEventListener('click', (e) => {
      e.stopPropagation();
      const nextStatus = reel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later';
      updateReelStatus(reel.id, nextStatus);
    });

    row.querySelector('.status-pill-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      cycleStatus(reel.id, reel.watch_status);
    });

    reelsTableBody.appendChild(row);
  }
}

/**
 * Sends status update to the server and refreshes local state optimistically.
 * @param {string} reelId
 * @param {'unwatched' | 'watch_later' | 'watched'} newStatus
 */
async function updateReelStatus(reelId, newStatus) {
  try {
    const res = await fetch(`/api/reels/${reelId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (res.ok) {
      const target = state.reels.find((r) => r.id === reelId);
      if (target) target.watch_status = newStatus;

      syncFeedSlideStatus(reelId, newStatus);
      renderReels();
      loadStats();
    }
  } catch (e) {
    console.error('Failed to update status:', e);
  }
}

/**
 * Cycles a reel through unwatched -> watch_later -> watched states.
 * @param {string} reelId
 * @param {string} currentStatus
 */
async function cycleStatus(reelId, currentStatus) {
  const map = {
    unwatched: 'watch_later',
    watch_later: 'watched',
    watched: 'unwatched',
  };
  await updateReelStatus(reelId, map[currentStatus] || 'unwatched');
}

// ==============================================================================
// FULLSCREEN REELS VERTICAL SNAP-FEED LOGIC (Instagram / TikTok Style)
// ==============================================================================

let feedIntersectionObserver = null;

/**
 * Constructs 100vh reel slides for the vertical snap feed.
 */
function renderFeedSlides() {
  feedScrollTrack.innerHTML = '';

  state.reels.forEach((reel, index) => {
    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreator = escapeHtml(creatorName);
    const initial = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();
    const isWatchLater = reel.watch_status === 'watch_later';
    const isWatched = reel.watch_status === 'watched';
    const cleanThumbnail = sanitizeMediaUrl(reel.thumbnail_url);
    const hasRealThumbnail = cleanThumbnail && !cleanThumbnail.includes('photo-1618005182384');
    const dateFormatted = formatRelativeDate(reel.taken_at || reel.saved_at);
    const captionText = reel.caption || 'No caption available for this reel.';

    const slide = document.createElement('div');
    slide.className = 'feed-reel-slide';
    slide.setAttribute('data-reel-id', reel.id);
    slide.setAttribute('data-index', String(index));

    let underlayHtml = '';
    if (hasRealThumbnail) {
      underlayHtml = `<div class="reel-poster-underlay" style="background-image: url('${cleanThumbnail}');"></div>`;
    } else {
      underlayHtml = `
        <div class="reel-monogram-underlay">
          <div class="feed-monogram-circle">${initial}</div>
          <div class="feed-monogram-handle">@${safeCreator}</div>
        </div>
      `;
    }

    slide.innerHTML = `
      <div class="reel-stage-wrapper">
        <div class="reel-media-viewport">
          ${underlayHtml}
          <!-- Boundary-Masked Clean Iframe Container (No white Instagram card/footer) -->
          <div class="reel-iframe-container" id="feed-iframe-box-${reel.id}"></div>
        </div>

        <!-- Overlay Details (Bottom Left) -->
        <div class="reel-overlay-content">
          <div class="reel-overlay-creator">
            <div class="reel-creator-avatar">${initial}</div>
            <div class="reel-creator-meta">
              <a href="https://www.instagram.com/${creatorName}/" target="_blank" rel="noopener noreferrer" class="reel-creator-handle">@${safeCreator}</a>
              <span class="reel-saved-badge">Saved ${dateFormatted}</span>
            </div>
          </div>
          <div class="reel-caption-wrap" id="caption-wrap-${reel.id}">
            <p class="reel-caption-text">${escapeHtml(captionText)}</p>
            ${captionText.length > 90 ? '<button class="reel-caption-toggle" data-action="toggle-caption">more</button>' : ''}
          </div>
        </div>

        <!-- Vertical Action Rail (Right Side) -->
        <div class="reel-actions-rail">
          <div class="rail-action-item">
            <button class="rail-action-btn ${isWatched ? 'active-watched' : ''}" data-action="feed-toggle-watched" title="Mark Watched" aria-label="Mark Watched">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </button>
            <span class="rail-action-sublabel">Watched</span>
          </div>

          <div class="rail-action-item">
            <button class="rail-action-btn ${isWatchLater ? 'active-later' : ''}" data-action="feed-toggle-later" title="Watch Later" aria-label="Watch Later">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
            </button>
            <span class="rail-action-sublabel">Later</span>
          </div>

          <div class="rail-action-item">
            <button class="rail-action-btn" data-action="feed-copy-link" title="Copy Reel Link" aria-label="Copy Reel Link">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <span class="rail-action-sublabel copy-label">Copy</span>
          </div>

          <div class="rail-action-item">
            <a href="${reel.reel_url}" target="_blank" rel="noopener noreferrer" class="rail-action-btn" title="Open directly in Instagram app or web" aria-label="Open in Instagram">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
            <span class="rail-action-sublabel">Open ↗</span>
          </div>
        </div>
      </div>
    `;

    // Slide internal click delegator
    slide.addEventListener('click', async (e) => {
      const toggleCaptionBtn = e.target.closest('[data-action="toggle-caption"]');
      if (toggleCaptionBtn) {
        const wrap = slide.querySelector('.reel-caption-wrap');
        const isExp = wrap.classList.toggle('expanded');
        toggleCaptionBtn.textContent = isExp ? 'less' : 'more';
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
        const copyLabel = slide.querySelector('.copy-label');
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
          await navigator.clipboard.writeText(reel.reel_url);
          if (copyLabel) copyLabel.textContent = 'Copied!';
        } catch (err) {
          console.warn('Clipboard write failed:', err);
          if (copyLabel) copyLabel.textContent = 'Failed';
        }
        setTimeout(() => { if (copyLabel) copyLabel.textContent = 'Copy'; }, 1500);
      }
    });

    feedScrollTrack.appendChild(slide);
  });

  setupFeedIntersectionObserver();
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
        // Active Reel Slide
        state.currentFeedIndex = index;
        state.currentFeedReelId = reelId;

        // Update Top HUD
        feedCounterKicker.textContent = `REEL ${index + 1} OF ${state.reels.length}`;
        feedShortcodeTag.textContent = `ID: ${reel?.shortcode || '—'}`;

        // Mount Boundary-Masked Clean Iframe if not already mounted
        if (iframeBox && !iframeBox.querySelector('iframe') && reel) {
          const iframe = document.createElement('iframe');
          iframe.src = `https://www.instagram.com/reel/${reel.shortcode}/embed/`;
          iframe.className = 'reel-player-iframe';
          iframe.setAttribute('allowfullscreen', 'true');
          iframe.setAttribute('scrolling', 'no');
          iframe.setAttribute('allowtransparency', 'true');
          iframe.setAttribute('loading', 'eager');
          iframeBox.appendChild(iframe);
        }
      } else if (!entry.isIntersecting || entry.intersectionRatio < 0.2) {
        // Unmount iframe to stop video playback and audio immediately
        if (iframeBox && iframeBox.querySelector('iframe')) {
          iframeBox.innerHTML = '';
        }
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
 * Opens the fullscreen Reels snap-feed scrolled to the selected reel.
 * @param {object} startReel
 */
function openReelsFeed(startReel) {
  state.previouslyFocusedElement = document.activeElement;
  renderFeedSlides();

  feedModal.classList.add('active');
  feedModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // Scroll directly to target reel slide
  const targetSlide = feedScrollTrack.querySelector(`[data-reel-id="${startReel.id}"]`);
  if (targetSlide) {
    targetSlide.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  // Focus close button for accessibility
  feedCloseBtn.focus();
}

/**
 * Closes the fullscreen Reels snap-feed, halts audio, and restores focus.
 */
function closeReelsFeed() {
  if (feedIntersectionObserver) {
    feedIntersectionObserver.disconnect();
  }

  // Clear all iframes immediately to silence audio
  const iframes = feedScrollTrack.querySelectorAll('.reel-iframe-container');
  iframes.forEach((box) => { box.innerHTML = ''; });

  feedModal.classList.remove('active');
  feedModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  state.currentFeedReelId = null;

  // Restore previous focus
  if (state.previouslyFocusedElement && typeof state.previouslyFocusedElement.focus === 'function') {
    state.previouslyFocusedElement.focus();
  }
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
      nextSlide.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

/**
 * Synchronizes active status styling on the action rail for a specific reel.
 * @param {string} reelId
 * @param {string} newStatus
 */
function syncFeedSlideStatus(reelId, newStatus) {
  const slide = feedScrollTrack.querySelector(`[data-reel-id="${reelId}"]`);
  if (!slide) return;

  const watchedBtn = slide.querySelector('[data-action="feed-toggle-watched"]');
  const laterBtn = slide.querySelector('[data-action="feed-toggle-later"]');

  if (watchedBtn) {
    watchedBtn.classList.toggle('active-watched', newStatus === 'watched');
  }
  if (laterBtn) {
    laterBtn.classList.toggle('active-later', newStatus === 'watch_later');
    const svgPath = laterBtn.querySelector('path');
    if (svgPath) {
      laterBtn.querySelector('svg').setAttribute('fill', newStatus === 'watch_later' ? 'currentColor' : 'none');
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
  const totalPages = Math.ceil(total / limit) || 1;
  paginationBar.style.display = total > limit ? 'flex' : 'none';
  pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  prevPageBtn.disabled = page <= 1;
  nextPageBtn.disabled = page >= totalPages;
}

// Helpers

/**
 * Formats an ISO date string into a localized short date (e.g., Nov 8, 2026).
 * @param {string} isoDate
 * @returns {string}
 */
function formatRelativeDate(isoDate) {
  if (!isoDate) return 'Unknown';
  const d = new Date(isoDate);
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
 * Escapes raw strings for safe insertion into HTML templates.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Decodes raw &amp; HTML entities in media URLs to prevent CDN query parameter corruption.
 * @param {string} url
 * @returns {string}
 */
function sanitizeMediaUrl(url) {
  if (!url) return '';
  return String(url).replace(/&amp;/g, '&');
}

/**
 * Dispatches an obsidian dark-mode toast notification with auto-dismiss or manual dismiss for errors.
 * @param {string} message
 * @param {'info' | 'success' | 'error'} type
 */
function showToast(message, type = 'info') {
  let toastContainer = document.getElementById('vault-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'vault-toast-container';
    toastContainer.className = 'vault-toast-container';
    toastContainer.setAttribute('role', 'status');
    toastContainer.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastContainer);
  }
  const isError = type === 'error';
  const toast = document.createElement('div');
  toast.className = `vault-toast vault-toast-${type}`;
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.innerHTML = `
    <span class="toast-dot" aria-hidden="true"></span>
    <span class="toast-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</span>
    ${isError ? '<button type="button" class="toast-dismiss-btn" aria-label="Dismiss error notice">✕</button>' : ''}
  `;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

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

// Event Listeners

/**
 * Binds UI controls, search debounce, key listeners, and file import handlers.
 */
function setupEventListeners() {
  // View mode switcher
  viewModeGridBtn.addEventListener('click', () => applyViewMode('grid'));
  viewModeListBtn.addEventListener('click', () => applyViewMode('list'));

  // Reels Feed modal handlers
  feedCloseBtn.addEventListener('click', closeReelsFeed);
  feedArrowUp.addEventListener('click', () => scrollFeedBy(-1));
  feedArrowDown.addEventListener('click', () => scrollFeedBy(1));

  // Global keydown navigation for the Feed
  window.addEventListener('keydown', (e) => {
    if (!feedModal.classList.contains('active')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeReelsFeed();
    } else if (e.key === 'Tab') {
      const activeSlide = feedScrollTrack.querySelector(`.feed-reel-slide[data-index="${state.currentFeedIndex}"]`);
      const topBarControls = Array.from(feedModal.querySelectorAll('.feed-top-bar button:not([disabled])'));
      const slideControls = activeSlide ? Array.from(activeSlide.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
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
    } else if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'PageDown') {
      e.preventDefault();
      scrollFeedBy(1);
    } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'PageUp') {
      e.preventDefault();
      scrollFeedBy(-1);
    }
  });

  // Search input with debounce
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value;
    clearSearchBtn.style.display = val ? 'flex' : 'none';
    searchTimeout = setTimeout(() => {
      state.filters.search = val;
      state.filters.page = 1;
      fetchReels();
    }, 220);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    state.filters.search = '';
    state.filters.page = 1;
    fetchReels();
  });

  datePresetSelect.addEventListener('change', (e) => {
    state.filters.datePreset = e.target.value;
    state.filters.page = 1;
    fetchReels();
  });

  watchFilterSelect.addEventListener('change', (e) => {
    state.filters.watchStatus = e.target.value;
    state.filters.page = 1;
    fetchReels();
  });

  sortBySelect.addEventListener('change', (e) => {
    state.filters.sortBy = e.target.value;
    state.filters.page = 1;
    fetchReels();
  });

  resetCreatorBtn.addEventListener('click', () => selectCreator(''));

  prevPageBtn.addEventListener('click', () => {
    if (state.filters.page > 1) {
      state.filters.page--;
      fetchReels();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  nextPageBtn.addEventListener('click', () => {
    state.filters.page++;
    fetchReels();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Import Archive
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
      showToast(`Archive processed!\n• New reels imported: ${imported}\n• Already present: ${alreadyIn}`, 'success');
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
