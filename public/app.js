// ==============================================================================
// Instagram Saved Reels Tracker - Frontend Application Logic
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
      dbBadge.textContent = '⚡ Supabase (Cloud)';
      dbBadge.className = 'badge badge-success';
    } else {
      dbBadge.textContent = '💾 In-Memory Demo Store';
      dbBadge.className = 'badge badge-neutral';
    }
  } catch (e) {
    dbBadge.textContent = '⚠️ Offline';
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const stats = await res.json();
    state.stats = stats;
    statTotal.textContent = stats.totalReels.toLocaleString();
    statCreators.textContent = stats.totalCreators.toLocaleString();
    statWeek.textContent = stats.savedThisWeek.toLocaleString();
    statWatchLater.textContent = stats.watchLaterCount.toLocaleString();
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

function renderCreatorPills() {
  creatorPillsList.innerHTML = '';

  // "All Creators" pill
  const allPill = document.createElement('div');
  allPill.className = `creator-pill ${!state.filters.creatorId ? 'active' : ''}`;
  allPill.textContent = 'All Creators';
  allPill.onclick = () => selectCreator('');
  creatorPillsList.appendChild(allPill);

  for (const c of state.creators) {
    const pill = document.createElement('div');
    pill.className = `creator-pill ${state.filters.creatorId === c.id ? 'active' : ''}`;

    if (c.profile_picture_url) {
      const img = document.createElement('img');
      img.src = c.profile_picture_url;
      img.className = 'creator-avatar-mini';
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
  resultsCount.textContent = 'Searching reels...';
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
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No Saved Reels Found</div>
        <div class="empty-subtitle">Try adjusting your filters, clearing your search, or sync new reels.</div>
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

    const creatorName = reel.creator?.username || 'instagram_user';
    const safeCreatorName = escapeHtml(creatorName);
    const avatarUrl = reel.creator?.profile_picture_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=60';
    const thumbUrl = reel.thumbnail_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400';

    const dateFormatted = formatRelativeDate(reel.taken_at);
    const statusClass = `status-${reel.watch_status}`;
    const statusLabel = formatStatusLabel(reel.watch_status);
    const reminderBadge = reel.watch_status === 'watch_later' 
      ? `<span class="reminder-pill" title="Next reminder scheduled">⏰ ${reel.reminder_interval_hours || 10}h Reminder</span>` 
      : '';

    card.innerHTML = `
      <div class="reel-thumb-container">
        <img class="reel-thumb" src="${thumbUrl}" alt="Reel thumbnail" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400'">
        <span class="reel-rank-badge">#${reel.save_order_rank} Saved</span>
        <a href="${reel.reel_url}" target="_blank" rel="noopener noreferrer" class="reel-open-overlay" title="Open Reel on Instagram">
          ↗
        </a>
      </div>
      <div class="reel-content">
        <div class="reel-creator-row">
          <img class="creator-avatar" src="${avatarUrl}" alt="${safeCreatorName}" onerror="this.src='https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=60'">
          <a class="creator-handle" href="${reel.reel_url}" target="_blank">@${safeCreatorName}</a>
          ${reminderBadge}
        </div>
        <div class="reel-caption">${escapeHtml(reel.caption || '(No caption provided)')}</div>
        <div class="reel-meta-row">
          <span>📅 ${dateFormatted}</span>
          <button class="watch-status-toggle ${statusClass}" data-id="${reel.id}" data-status="${reel.watch_status}">
            ${statusLabel}
          </button>
        </div>
      </div>
    `;

    // Watch status click event (cycles unwatched -> watch_later -> watched -> unwatched)
    const toggleBtn = card.querySelector('.watch-status-toggle');
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      cycleWatchStatus(reel.id, reel.watch_status);
    };

    reelsGrid.appendChild(card);
  }
}

async function cycleWatchStatus(reelId, currentStatus) {
  const nextStatusMap = {
    unwatched: 'watch_later',
    watch_later: 'watched',
    watched: 'unwatched',
  };
  const nextStatus = nextStatusMap[currentStatus] || 'unwatched';

  try {
    const res = await fetch(`/api/reels/${reelId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });

    if (res.ok) {
      await Promise.all([loadStats(), fetchReels()]);
    }
  } catch (e) {
    console.error('Failed to update status:', e);
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
    case 'watch_later': return '⏰ Watch Later';
    case 'watched': return '✅ Watched';
    default: return '👁️ Unwatched';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Event Listeners
function setupEventListeners() {
  // Search input with debounce
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const val = e.target.value;
    clearSearchBtn.style.display = val ? 'block' : 'none';
    searchTimeout = setTimeout(() => {
      state.filters.search = val;
      state.filters.page = 1;
      fetchReels();
    }, 280);
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

    const originalText = importBtn.innerHTML;
    importBtn.innerHTML = '<span class="btn-icon">⏳</span> Importing...';
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

      if (data && data.reelsImported === 0 && data.errors && data.errors.length > 0) {
        alert(`Import failed: No reels could be imported.\n\nErrors:\n${data.errors.join('\n')}`);
        return;
      }

      const importedCount = data?.reelsImported ?? 0;
      const creatorsCount = data?.creatorsAdded ?? 0;
      const totalScanned = data?.totalProcessed ?? 0;
      let msg = `🎉 Archive imported successfully!\n\n• Reels imported: ${importedCount}\n• Creators added: ${creatorsCount}\n• Total scanned: ${totalScanned}`;
      if (data?.errors && data.errors.length > 0) {
        msg += `\n\nWarnings/Errors:\n${data.errors.join('\n')}`;
      }
      alert(msg);
      await Promise.all([loadStats(), loadCreators(), fetchReels()]);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      archiveFileInput.value = '';
      importBtn.innerHTML = originalText;
      importBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
