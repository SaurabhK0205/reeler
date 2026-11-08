// ==============================================================================
// REELER — CINEMATIC VAULT FRONTEND LOGIC
// High-performance media curator & cinema theater modal. Zero AI slop.
// ==============================================================================

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
  total: 0,
  reels: [],
  creators: [],
  stats: null,
  currentTheaterReelId: null,
};

// DOM Elements
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
const resultsCount = document.getElementById('results-count');
const paginationBar = document.getElementById('pagination-bar');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const pageIndicator = document.getElementById('page-indicator');

// Cinema Theater Modal Elements
const theaterModal = document.getElementById('theater-modal');
const theaterBackdrop = document.getElementById('theater-backdrop');
const theaterCloseBtn = document.getElementById('theater-close-btn');
const theaterPlayerContainer = document.getElementById('theater-player-container');
const theaterAvatar = document.getElementById('theater-avatar');
const theaterCreatorName = document.getElementById('theater-creator-name');
const theaterDate = document.getElementById('theater-date');
const theaterCaption = document.getElementById('theater-caption');
const theaterExternalLink = document.getElementById('theater-external-link');
const theaterRank = document.getElementById('theater-rank');
const theaterStatusUnwatched = document.getElementById('theater-status-unwatched');
const theaterStatusLater = document.getElementById('theater-status-later');
const theaterStatusWatched = document.getElementById('theater-status-watched');

// --- Initialization ---
async function init() {
  setupEventListeners();
  await checkHealth();
  await Promise.all([loadStats(), loadCreators(), fetchReels()]);
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.database === 'supabase') {
      dbBadge.className = 'badge badge-connected';
      dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-text">Supabase (Cloud)</span>';
    } else {
      dbBadge.className = 'badge badge-local';
      dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-text">In-Memory Store</span>';
    }
  } catch (_) {
    dbBadge.className = 'badge';
    dbBadge.innerHTML = '<span class="badge-dot" aria-hidden="true"></span><span class="badge-text">Offline</span>';
  }
}

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

async function loadCreators() {
  try {
    const res = await fetch('/api/creators');
    if (!res.ok) return;
    state.creators = await res.json();
    renderCreatorPills();
  } catch (e) {
    console.error('Failed to load creators:', e);
  }
}

// Deterministic aesthetic color generator based on creator handle
function getCreatorColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hues = [210, 195, 260, 340, 160, 30, 280]; // cyan, teal, violet, rose, emerald, amber, purple
  const hue = hues[Math.abs(hash) % hues.length];
  return {
    bg: `hsl(${hue}, 60%, 18%)`,
    border: `hsl(${hue}, 70%, 45%)`,
    accent: `hsl(${hue}, 85%, 65%)`,
  };
}

function renderCreatorPills() {
  creatorPillsList.innerHTML = '';

  // "All Creators" button
  const allBtn = document.createElement('button');
  allBtn.className = `creator-pill ${!state.filters.creatorId ? 'active' : ''}`;
  allBtn.textContent = 'All Creators';
  allBtn.onclick = () => selectCreator('');
  creatorPillsList.appendChild(allBtn);

  // Top creators from server
  for (const c of state.creators) {
    const pill = document.createElement('button');
    pill.className = `creator-pill ${state.filters.creatorId === c.id ? 'active' : ''}`;

    if (c.profile_picture_url) {
      const img = document.createElement('img');
      img.src = c.profile_picture_url;
      img.className = 'creator-avatar-mini';
      img.alt = c.username;
      img.onerror = () => { img.style.display = 'none'; };
      pill.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = `@${c.username}`;
    pill.appendChild(name);

    if (c.saved_count) {
      const count = document.createElement('span');
      count.className = 'creator-count';
      count.textContent = c.saved_count;
      pill.appendChild(count);
    }

    pill.onclick = () => selectCreator(c.id);
    creatorPillsList.appendChild(pill);
  }

  resetCreatorBtn.style.display = state.filters.creatorId ? 'inline' : 'none';
}

function selectCreator(id) {
  state.filters.creatorId = id;
  state.filters.page = 1;
  renderCreatorPills();
  fetchReels();
}

async function fetchReels() {
  resultsCount.textContent = 'Searching vault...';
  reelsGrid.innerHTML = '';

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
    resultsCount.textContent = 'Failed to load reels. Please try again.';
  }
}

function renderReels() {
  reelsGrid.innerHTML = '';

  if (state.reels.length === 0) {
    resultsCount.textContent = '0 reels found';
    reelsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <div class="empty-title">No Saved Reels Found</div>
        <div class="empty-subtitle">Try adjusting your filters, clearing search keywords, or importing reels.</div>
      </div>
    `;
    return;
  }

  const rangeStart = (state.filters.page - 1) * state.filters.limit + 1;
  const rangeEnd = Math.min(state.filters.page * state.filters.limit, state.total);
  resultsCount.textContent = `Showing ${rangeStart}–${rangeEnd} of ${state.total} saved reel(s)`;

  for (const reel of state.reels) {
    const card = document.createElement('div');
    card.className = 'reel-card';
    card.setAttribute('data-id', reel.id);

    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreatorName = escapeHtml(creatorName);
    const creatorColor = getCreatorColor(creatorName);
    const monogram = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();
    const dateFormatted = formatRelativeDate(reel.taken_at || reel.saved_at);
    const statusLabel = formatStatusLabel(reel.watch_status);
    const isWatchLater = reel.watch_status === 'watch_later';

    // Poster visuals: either real imported thumbnail or our generative film poster frame
    const hasRealThumbnail = reel.thumbnail_url && !reel.thumbnail_url.includes('photo-1618005182384');
    let posterMediaHtml = '';

    if (hasRealThumbnail) {
      posterMediaHtml = `
        <img class="reel-thumb-img" src="${reel.thumbnail_url}" alt="Reel poster" loading="lazy" />
        <div class="poster-scrim-top"></div>
        <div class="poster-scrim-bottom"></div>
      `;
    } else {
      posterMediaHtml = `
        <div class="generative-poster">
          <div class="gen-poster-header">
            <span class="gen-film-strip-badge">REEL #${reel.save_order_rank || '—'}</span>
          </div>
          <div class="gen-poster-body">
            <div class="gen-monogram" style="background: ${creatorColor.bg}; border-color: ${creatorColor.border};">
              ${monogram}
            </div>
            <div class="gen-creator-name">@${safeCreatorName}</div>
            <div class="gen-caption-preview">${escapeHtml(reel.caption || 'Saved Instagram Reel')}</div>
          </div>
          <div class="poster-scrim-bottom"></div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="reel-poster-frame">
        ${posterMediaHtml}
        <div class="poster-top-bar">
          <span class="reel-rank-pill">#${reel.save_order_rank || '—'}</span>
          <button class="watch-later-quick-btn ${isWatchLater ? 'active' : ''}" title="${isWatchLater ? 'Remove from Watch Later' : 'Add to Watch Later'}" aria-label="Toggle Watch Later">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
        </div>
        <div class="poster-play-trigger" aria-label="Open Reel Theater">
          <div class="play-bubble">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </div>
        </div>
      </div>
      <div class="reel-content">
        <div class="reel-creator-row">
          <div class="creator-avatar" style="background: ${creatorColor.bg}; border-color: ${creatorColor.border}; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700;">
            ${monogram}
          </div>
          <a class="creator-handle" href="${reel.reel_url}" target="_blank" rel="noopener noreferrer">@${safeCreatorName}</a>
        </div>
        <div class="reel-caption-line">${escapeHtml(reel.caption || '(No caption provided)')}</div>
        <div class="reel-footer-row">
          <span class="reel-date">${dateFormatted}</span>
          <button class="status-badge-btn status-badge-${reel.watch_status}" data-id="${reel.id}" data-status="${reel.watch_status}">
            ${statusLabel}
          </button>
        </div>
      </div>
    `;

    // Click card to open Cinema Theater modal
    card.addEventListener('click', (e) => {
      // Don't open theater if clicking direct Instagram link
      if (e.target.closest('a')) return;
      openTheaterModal(reel);
    });

    // Quick Watch Later bookmark button
    const bookmarkBtn = card.querySelector('.watch-later-quick-btn');
    bookmarkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newStatus = reel.watch_status === 'watch_later' ? 'unwatched' : 'watch_later';
      updateReelStatus(reel.id, newStatus);
    });

    // Status badge click (cycles unwatched -> watch_later -> watched -> unwatched)
    const statusBtn = card.querySelector('.status-badge-btn');
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleWatchStatus(reel.id, reel.watch_status);
    });

    reelsGrid.appendChild(card);
  }
}

// Update single reel status in backend & refresh stats/cards
async function updateReelStatus(reelId, newStatus) {
  try {
    const res = await fetch(`/api/reels/${reelId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (res.ok) {
      // Update in state
      const target = state.reels.find((r) => r.id === reelId);
      if (target) {
        target.watch_status = newStatus;
      }
      if (state.currentTheaterReelId === reelId) {
        updateTheaterStatusButtons(newStatus);
      }
      renderReels();
      loadStats();
    }
  } catch (e) {
    console.error('Failed to update status:', e);
  }
}

async function cycleWatchStatus(reelId, currentStatus) {
  const nextStatusMap = {
    unwatched: 'watch_later',
    watch_later: 'watched',
    watched: 'unwatched',
  };
  const nextStatus = nextStatusMap[currentStatus] || 'unwatched';
  await updateReelStatus(reelId, nextStatus);
}

// ==============================================================================
// CINEMA THEATER MODAL LOGIC
// ==============================================================================

function openTheaterModal(reel) {
  state.currentTheaterReelId = reel.id;
  const creatorName = reel.creator?.username || 'instagram_user';
  const safeCreatorName = escapeHtml(creatorName);
  const creatorColor = getCreatorColor(creatorName);
  const monogram = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();

  // Populate creator info
  theaterAvatar.style.background = creatorColor.bg;
  theaterAvatar.style.borderColor = creatorColor.border;
  theaterAvatar.textContent = monogram;
  theaterCreatorName.textContent = `@${safeCreatorName}`;
  theaterCreatorName.href = `https://www.instagram.com/${creatorName}/`;
  theaterDate.textContent = `Saved ${formatRelativeDate(reel.taken_at || reel.saved_at)}`;
  theaterExternalLink.href = reel.reel_url;
  theaterRank.textContent = `Vault Record #${reel.save_order_rank || '—'}`;
  theaterCaption.textContent = reel.caption || 'No caption provided with this reel.';

  updateTheaterStatusButtons(reel.watch_status);

  // Embed Instagram Player iframe or clean player container
  theaterPlayerContainer.innerHTML = `
    <iframe
      src="https://www.instagram.com/p/${reel.shortcode}/embed/"
      title="Instagram Reel Player"
      loading="lazy"
      allowtransparency="true"
      allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
      sandbox="allow-scripts allow-same-origin allow-popups">
    </iframe>
  `;

  theaterModal.classList.add('active');
  theaterModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeTheaterModal() {
  state.currentTheaterReelId = null;
  theaterPlayerContainer.innerHTML = ''; // Stop video audio immediately
  theaterModal.classList.remove('active');
  theaterModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function updateTheaterStatusButtons(status) {
  [theaterStatusUnwatched, theaterStatusLater, theaterStatusWatched].forEach((btn) => {
    btn.classList.remove('selected');
  });
  if (status === 'watched') {
    theaterStatusWatched.classList.add('selected');
  } else if (status === 'watch_later') {
    theaterStatusLater.classList.add('selected');
  } else {
    theaterStatusUnwatched.classList.add('selected');
  }
}

function navigateTheater(direction) {
  if (!state.currentTheaterReelId || state.reels.length === 0) return;
  const currentIndex = state.reels.findIndex((r) => r.id === state.currentTheaterReelId);
  if (currentIndex === -1) return;

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < state.reels.length) {
    openTheaterModal(state.reels[nextIndex]);
  }
}

function updatePagination(page, limit, total) {
  const totalPages = Math.ceil(total / limit) || 1;
  paginationBar.style.display = total > limit ? 'flex' : 'none';
  pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  prevPageBtn.disabled = page <= 1;
  nextPageBtn.disabled = page >= totalPages;
}

// Helpers
function formatRelativeDate(isoDate) {
  if (!isoDate) return 'Unknown date';
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatStatusLabel(status) {
  switch (status) {
    case 'watch_later': return 'Watch Later';
    case 'watched': return 'Watched';
    default: return 'Unwatched';
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Event Listeners
function setupEventListeners() {
  // Theater modal close handlers
  theaterCloseBtn.addEventListener('click', closeTheaterModal);
  theaterBackdrop.addEventListener('click', closeTheaterModal);

  // Theater modal status buttons
  theaterStatusUnwatched.addEventListener('click', () => {
    if (state.currentTheaterReelId) updateReelStatus(state.currentTheaterReelId, 'unwatched');
  });
  theaterStatusLater.addEventListener('click', () => {
    if (state.currentTheaterReelId) updateReelStatus(state.currentTheaterReelId, 'watch_later');
  });
  theaterStatusWatched.addEventListener('click', () => {
    if (state.currentTheaterReelId) updateReelStatus(state.currentTheaterReelId, 'watched');
  });

  // Global keyboard shortcuts (Esc to close theater, Left/Right arrow to navigate)
  window.addEventListener('keydown', (e) => {
    if (!theaterModal.classList.contains('active')) return;
    if (e.key === 'Escape') {
      closeTheaterModal();
    } else if (e.key === 'ArrowLeft') {
      navigateTheater(-1);
    } else if (e.key === 'ArrowRight') {
      navigateTheater(1);
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
    }, 250);
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

  // Archive Import Button
  importBtn.addEventListener('click', () => {
    archiveFileInput.click();
  });

  archiveFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_FILE_SIZE) {
      alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is 50MB.`);
      archiveFileInput.value = '';
      return;
    }

    const originalContent = importBtn.innerHTML;
    importBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
        <path d="M12 2a10 10 0 0 1 10 10"></path>
      </svg>
      <span>Importing...</span>
    `;
    importBtn.disabled = true;

    try {
      const text = await file.text();

      const res = await fetch('/api/archive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });

      let data = null;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (_) {
          data = null;
        }
      }

      if (!res.ok) {
        const errorMsg = data?.error || data?.errors?.join('\n') || (res.status === 413 ? 'File too large for server limit (50MB)' : `Server responded with status ${res.status}`);
        alert(`Import error: ${errorMsg}`);
        return;
      }

      if (data && data.reelsImported === 0 && (data.alreadyPresent ?? 0) === 0 && data.errors && data.errors.length > 0) {
        alert(`Import failed: No reels could be imported.\n\nErrors:\n${data.errors.join('\n')}`);
        return;
      }

      const importedCount = data?.reelsImported ?? 0;
      const alreadyPresentCount = data?.alreadyPresent ?? 0;
      const creatorsCount = data?.creatorsAdded ?? 0;
      const totalScanned = data?.totalProcessed ?? 0;
      let msg = `Archive processed successfully!\n\n• New reels imported: ${importedCount}\n• Already in vault: ${alreadyPresentCount}\n• Creators added: ${creatorsCount}\n• Total scanned: ${totalScanned}`;
      if (data?.errors && data.errors.length > 0) {
        msg += `\n\nWarnings/Errors:\n${data.errors.join('\n')}`;
      }
      alert(msg);
      await Promise.all([loadStats(), loadCreators(), fetchReels()]);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      archiveFileInput.value = '';
      importBtn.innerHTML = originalContent;
      importBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
