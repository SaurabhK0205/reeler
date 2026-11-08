// ==============================================================================
// REELER — LINEAR MONOCHROME VAULT APPLICATION LOGIC
// Dual View (Poster Grid + Dense Table) & Native Instagram Embed Playback
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
  viewMode: localStorage.getItem('reeler_view_mode') || 'grid',
  total: 0,
  reels: [],
  creators: [],
  stats: null,
  currentModalReelId: null,
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

// Playback Modal References
const playbackModal = document.getElementById('playback-modal');
const playbackBackdrop = document.getElementById('playback-backdrop');
const playbackCloseBtn = document.getElementById('playback-close-btn');
const playbackRankKicker = document.getElementById('playback-rank-kicker');
const playbackShortcodeTag = document.getElementById('playback-shortcode-tag');
const playbackMediaContainer = document.getElementById('playback-media-container');
const playbackCreatorAvatar = document.getElementById('playback-creator-avatar');
const playbackCreatorHandle = document.getElementById('playback-creator-handle');
const playbackSavedDate = document.getElementById('playback-saved-date');
const playbackDirectIgLink = document.getElementById('playback-direct-ig-link');
const playbackFullCaption = document.getElementById('playback-full-caption');
const copyCaptionBtn = document.getElementById('copy-caption-btn');
const statusChoiceUnwatched = document.getElementById('status-choice-unwatched');
const statusChoiceLater = document.getElementById('status-choice-later');
const statusChoiceWatched = document.getElementById('status-choice-watched');

// --- Initialization ---
async function init() {
  applyViewMode(state.viewMode);
  setupEventListeners();
  await checkHealth();
  await Promise.all([loadStats(), loadCreators(), fetchReels()]);
}

function applyViewMode(mode) {
  state.viewMode = mode;
  localStorage.setItem('reeler_view_mode', mode);

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
    renderCreatorStrip();
  } catch (e) {
    console.error('Failed to load creators:', e);
  }
}

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

function selectCreator(id) {
  state.filters.creatorId = id;
  state.filters.page = 1;
  renderCreatorStrip();
  fetchReels();
}

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
    const hasRealThumbnail = reel.thumbnail_url && !reel.thumbnail_url.includes('photo-1618005182384');

    // 1. Render Grid Poster Card
    const card = document.createElement('div');
    card.className = 'vault-poster-card';
    card.setAttribute('data-id', reel.id);

    let posterArtHtml = '';
    if (hasRealThumbnail) {
      posterArtHtml = `
        <img class="poster-actual-img" src="${reel.thumbnail_url}" alt="Reel thumbnail" loading="lazy" />
        <div class="poster-top-scrim"></div>
        <div class="poster-bottom-scrim"></div>
      `;
    } else {
      posterArtHtml = `
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
    }

    card.innerHTML = `
      <div class="poster-media-box">
        ${posterArtHtml}
        <div class="card-header-overlay">
          <span class="rank-tag">#${reel.save_order_rank || '—'}</span>
          <button class="card-bookmark-btn ${isWatchLater ? 'active' : ''}" title="${isWatchLater ? 'In Watch Later' : 'Add to Watch Later'}" aria-label="Toggle Watch Later">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${isWatchLater ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
        </div>
        <div class="play-hover-trigger" aria-label="Play Reel in Theater">
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

    // Click card opens playback theater
    card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('.card-bookmark-btn') || e.target.closest('.status-pill-toggle')) return;
      openPlaybackModal(reel);
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
          <button class="table-action-icon-btn btn-table-play" title="Play Reel in Theater">
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
      openPlaybackModal(reel);
    });

    row.querySelector('.btn-table-play').addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaybackModal(reel);
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

// Update Reel Status
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

      if (state.currentModalReelId === reelId) {
        updateModalStatusButtons(newStatus);
      }
      renderReels();
      loadStats();
    }
  } catch (e) {
    console.error('Failed to update status:', e);
  }
}

async function cycleStatus(reelId, currentStatus) {
  const map = {
    unwatched: 'watch_later',
    watch_later: 'watched',
    watched: 'unwatched',
  };
  await updateReelStatus(reelId, map[currentStatus] || 'unwatched');
}

// ==============================================================================
// PLAYBACK THEATER MODAL (Official Instagram Embed.js Integration)
// ==============================================================================

function openPlaybackModal(reel) {
  state.currentModalReelId = reel.id;
  const creatorName = reel.creator?.username || 'instagram_user';
  const safeCreator = escapeHtml(creatorName);
  const initial = (creatorName.replace(/[^a-zA-Z0-9]/g, '')[0] || 'R').toUpperCase();

  // Populate Inspector Meta
  playbackRankKicker.textContent = `REEL #${reel.save_order_rank || '—'}`;
  playbackShortcodeTag.textContent = `ID: ${reel.shortcode}`;
  playbackCreatorAvatar.textContent = initial;
  playbackCreatorHandle.textContent = `@${safeCreator}`;
  playbackCreatorHandle.href = `https://www.instagram.com/${creatorName}/`;
  playbackSavedDate.textContent = `Saved ${formatRelativeDate(reel.taken_at || reel.saved_at)}`;
  playbackDirectIgLink.href = reel.reel_url;
  playbackFullCaption.textContent = reel.caption || 'No caption available for this reel.';

  updateModalStatusButtons(reel.watch_status);

  // Native Instagram Embed Blockquote
  playbackMediaContainer.innerHTML = `
    <blockquote
      class="instagram-media"
      data-instgrm-captioned
      data-instgrm-permalink="${reel.reel_url}"
      data-instgrm-version="14"
      style="background:#000; border:1px solid #1e2025; border-radius:8px; margin:0 auto; width:100%; max-width:380px;">
      <div style="padding:40px 16px; text-align:center;">
        <div style="font-size:13px; font-weight:600; color:#fff; margin-bottom:10px;">Loading Instagram Reel (${reel.shortcode})...</div>
        <a href="${reel.reel_url}" target="_blank" rel="noopener noreferrer" style="display:inline-block; padding:8px 14px; background:#fff; color:#010102; font-size:12px; font-weight:600; border-radius:4px; text-decoration:none;">
          Open on Instagram ↗
        </a>
      </div>
    </blockquote>
  `;

  // Trigger Instagram embed parser if available
  if (window.instgrm && window.instgrm.Embeds) {
    try {
      window.instgrm.Embeds.process();
    } catch (err) {
      console.warn('Instagram embeds process notice:', err);
    }
  }

  playbackModal.classList.add('active');
  playbackModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closePlaybackModal() {
  state.currentModalReelId = null;
  playbackMediaContainer.innerHTML = ''; // Stop video audio immediately
  playbackModal.classList.remove('active');
  playbackModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function updateModalStatusButtons(status) {
  [statusChoiceUnwatched, statusChoiceLater, statusChoiceWatched].forEach((btn) => {
    btn.classList.remove('selected');
  });
  if (status === 'watched') statusChoiceWatched.classList.add('selected');
  else if (status === 'watch_later') statusChoiceLater.classList.add('selected');
  else statusChoiceUnwatched.classList.add('selected');
}

function navigateModal(direction) {
  if (!state.currentModalReelId || state.reels.length === 0) return;
  const idx = state.reels.findIndex((r) => r.id === state.currentModalReelId);
  if (idx === -1) return;

  const nextIdx = idx + direction;
  if (nextIdx >= 0 && nextIdx < state.reels.length) {
    openPlaybackModal(state.reels[nextIdx]);
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
  if (!isoDate) return 'Unknown';
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
  // View mode switcher
  viewModeGridBtn.addEventListener('click', () => applyViewMode('grid'));
  viewModeListBtn.addEventListener('click', () => applyViewMode('list'));

  // Playback modal close handlers
  playbackCloseBtn.addEventListener('click', closePlaybackModal);
  playbackBackdrop.addEventListener('click', closePlaybackModal);

  // Status buttons inside modal
  statusChoiceUnwatched.addEventListener('click', () => {
    if (state.currentModalReelId) updateReelStatus(state.currentModalReelId, 'unwatched');
  });
  statusChoiceLater.addEventListener('click', () => {
    if (state.currentModalReelId) updateReelStatus(state.currentModalReelId, 'watch_later');
  });
  statusChoiceWatched.addEventListener('click', () => {
    if (state.currentModalReelId) updateReelStatus(state.currentModalReelId, 'watched');
  });

  // Copy caption button
  copyCaptionBtn.addEventListener('click', () => {
    const text = playbackFullCaption.textContent;
    if (text) {
      navigator.clipboard.writeText(text);
      copyCaptionBtn.textContent = 'Copied!';
      setTimeout(() => { copyCaptionBtn.textContent = 'Copy'; }, 1500);
    }
  });

  // Keyboard navigation (Esc to close, Left/Right arrow to navigate)
  window.addEventListener('keydown', (e) => {
    if (!playbackModal.classList.contains('active')) return;
    if (e.key === 'Escape') closePlaybackModal();
    else if (e.key === 'ArrowLeft') navigateModal(-1);
    else if (e.key === 'ArrowRight') navigateModal(1);
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
      alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Max allowed size is 50MB.`);
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
        alert(`Import error: ${errorMsg}`);
        return;
      }

      const imported = data?.reelsImported ?? 0;
      const alreadyIn = data?.alreadyPresent ?? 0;
      alert(`Archive processed!\n\n• New reels imported: ${imported}\n• Already present: ${alreadyIn}`);
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
