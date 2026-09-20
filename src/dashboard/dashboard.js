import { getAllPosts, getMeta } from '../lib/db.js';
import { buildXlsx } from '../lib/xlsx.js';
import { baseNameFor, folderFor, filesFor } from '../lib/naming.js';

/**
 * Rough per-file sizes, used only for the "about this much" warning shown
 * before a download starts. Instagram doesn't tell us real sizes up front.
 */
const EST_BYTES = { image: 350 * 1024, video: 5 * 1024 * 1024 };
const PAGE_SIZE = 120;

const state = {
  posts: [],
  filtered: [],
  selected: new Set(),
  rendered: 0,
  polling: null,
};

const $ = (id) => document.getElementById(id);

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, reason: chrome.runtime.lastError.message });
      else resolve(response || { ok: false });
    });
  });

// --- formatting ------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(seconds) {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function formatWhen(ms) {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function estimateBytes(posts) {
  let total = 0;
  for (const post of posts) {
    for (const media of post.media || []) total += EST_BYTES[media.kind] || EST_BYTES.image;
  }
  return total;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// --- filtering -------------------------------------------------------------

function readFilters() {
  return {
    q: $('f-search').value.trim().toLowerCase(),
    collection: $('f-collection').value,
    creator: $('f-creator').value,
    types: new Set([...document.querySelectorAll('.f-type:checked')].map((el) => el.value)),
    from: $('f-from').value ? Date.parse(`${$('f-from').value}T00:00:00`) / 1000 : null,
    to: $('f-to').value ? Date.parse(`${$('f-to').value}T23:59:59`) / 1000 : null,
    undownloadedOnly: $('f-undownloaded').checked,
    sort: $('f-sort').value,
  };
}

function applyFilters() {
  const f = readFilters();

  state.filtered = state.posts.filter((post) => {
    if (!f.types.has(post.type)) return false;
    if (f.collection && post.collection !== f.collection) return false;
    if (f.creator && post.username !== f.creator) return false;
    if (f.undownloadedOnly && post.downloadedAt) return false;
    if (f.from && (!post.takenAt || post.takenAt < f.from)) return false;
    if (f.to && (!post.takenAt || post.takenAt > f.to)) return false;
    if (f.q) {
      const haystack = `${post.caption || ''} ${post.username || ''} ${post.fullName || ''} ${post.collection || ''}`.toLowerCase();
      if (!haystack.includes(f.q)) return false;
    }
    return true;
  });

  const sorters = {
    'found-desc': (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0),
    'date-desc': (a, b) => (b.takenAt || 0) - (a.takenAt || 0),
    'date-asc': (a, b) => (a.takenAt || 0) - (b.takenAt || 0),
    creator: (a, b) => (a.username || '').localeCompare(b.username || ''),
  };
  state.filtered.sort(sorters[f.sort] || sorters['found-desc']);

  state.rendered = 0;
  $('grid').replaceChildren();
  renderMore();
  updateCounts();
}

// --- rendering -------------------------------------------------------------

function card(post) {
  const el = document.createElement('article');
  el.className = 'card' + (state.selected.has(post.shortcode) ? ' selected' : '');
  el.dataset.shortcode = post.shortcode;

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.src = post.thumbUrl || '';
  img.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = 'thumb-fallback';
    fallback.textContent = 'Preview expired — re-scan to refresh';
    img.replaceWith(fallback);
  });
  thumb.appendChild(img);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent =
    post.type === 'carousel' ? `Carousel · ${post.media?.length || 0}` : post.type === 'video' ? 'Video' : 'Photo';
  thumb.appendChild(badge);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card-check';
  check.checked = state.selected.has(post.shortcode);
  check.title = 'Select this post';
  thumb.appendChild(check);

  const toggle = () => {
    if (state.selected.has(post.shortcode)) state.selected.delete(post.shortcode);
    else state.selected.add(post.shortcode);
    check.checked = state.selected.has(post.shortcode);
    el.classList.toggle('selected', check.checked);
    updateCounts();
  };

  thumb.addEventListener('click', (event) => {
    if (event.target !== check) toggle();
    else {
      // The checkbox already flipped itself; mirror it into state.
      if (check.checked) state.selected.add(post.shortcode);
      else state.selected.delete(post.shortcode);
      el.classList.toggle('selected', check.checked);
      updateCounts();
    }
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  const creator = document.createElement('div');
  creator.className = 'card-creator';
  creator.textContent = post.username ? `@${post.username}` : 'Unknown creator';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = [formatDate(post.takenAt), post.collection].filter(Boolean).join(' · ');

  const caption = document.createElement('div');
  caption.className = 'card-caption';
  caption.textContent = post.caption || 'No caption';

  body.append(creator, meta, caption);

  if (post.downloadError) {
    const status = document.createElement('div');
    status.className = 'card-status error';
    status.textContent = post.downloadError;
    body.appendChild(status);
  } else if (post.downloadedAt) {
    const status = document.createElement('div');
    status.className = 'card-status done';
    status.textContent = '✓ Downloaded';
    body.appendChild(status);
  }

  const link = document.createElement('a');
  link.className = 'card-link';
  link.href = post.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open on Instagram';
  body.appendChild(link);

  el.append(thumb, body);
  return el;
}

function renderMore() {
  const slice = state.filtered.slice(state.rendered, state.rendered + PAGE_SIZE);
  const fragment = document.createDocumentFragment();
  for (const post of slice) fragment.appendChild(card(post));
  $('grid').appendChild(fragment);
  state.rendered += slice.length;

  $('show-more').hidden = state.rendered >= state.filtered.length;
  $('show-more').textContent = `Show more (${(state.filtered.length - state.rendered).toLocaleString()} left)`;
  $('no-match').hidden = state.filtered.length > 0 || state.posts.length === 0;
}

function updateCounts() {
  $('match-count').textContent = plural(state.filtered.length, 'post');

  const chosen = state.posts.filter((p) => state.selected.has(p.shortcode));
  if (!chosen.length) {
    $('selection-info').textContent = 'Nothing selected';
    $('download').disabled = true;
  } else {
    const files = chosen.reduce((sum, p) => sum + (p.media?.length || 0), 0);
    $('selection-info').textContent =
      `${plural(chosen.length, 'post')} selected · ${plural(files, 'file')} · roughly ${formatBytes(estimateBytes(chosen))}`;
    $('download').disabled = false;
  }
}

function fillOptions(select, values, allLabel) {
  const current = select.value;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  select.appendChild(all);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  if (values.includes(current)) select.value = current;
}

// --- loading ---------------------------------------------------------------

async function load() {
  state.posts = await getAllPosts();

  const collections = [...new Set(state.posts.map((p) => p.collection).filter(Boolean))].sort();
  const creators = [...new Set(state.posts.map((p) => p.username).filter(Boolean))].sort();
  fillOptions($('f-collection'), collections, 'All collections');
  fillOptions($('f-creator'), creators, 'All creators');

  const lastScan = await getMeta('lastScanAt');
  const downloaded = state.posts.filter((p) => p.downloadedAt).length;
  $('library-summary').textContent =
    `${plural(state.posts.length, 'post')} · ${downloaded.toLocaleString()} downloaded · last scan ${formatWhen(lastScan)}`;

  $('empty').hidden = state.posts.length > 0;
  document.querySelector('.toolbar').hidden = state.posts.length === 0;

  // Drop selections for posts that no longer exist.
  const alive = new Set(state.posts.map((p) => p.shortcode));
  for (const code of [...state.selected]) if (!alive.has(code)) state.selected.delete(code);

  applyFilters();
}

// --- downloading -----------------------------------------------------------

async function startDownload() {
  const chosen = state.posts.filter((p) => state.selected.has(p.shortcode));
  if (!chosen.length) return;

  const size = formatBytes(estimateBytes(chosen));
  const files = chosen.reduce((sum, p) => sum + (p.media?.length || 0), 0);
  const ok = confirm(
    `Download ${plural(chosen.length, 'post')} (${plural(files, 'file')}, roughly ${size})?\n\n` +
      `They'll go to your Downloads folder, under "Instagram Library", sorted into a folder per collection.\n\n` +
      `Files are fetched slowly on purpose so Instagram doesn't rate-limit your account — a large batch takes a while. Keep this tab open.`
  );
  if (!ok) return;

  const result = await send({ type: 'download:start', shortcodes: [...state.selected] });
  if (!result.ok) {
    alert(result.reason === 'busy' ? 'A download is already running.' : 'Could not start the download.');
    return;
  }
  watchProgress();
}

function watchProgress() {
  clearInterval(state.polling);
  $('progress').hidden = false;

  state.polling = setInterval(async () => {
    const status = await send({ type: 'download:status' });
    if (!status.ok) return;

    const settled = status.completed + status.failed;
    const percent = status.total ? Math.round((settled / status.total) * 100) : 0;
    $('progress-bar').style.width = `${percent}%`;
    $('progress-label').textContent = status.running ? `Downloading ${status.label}` : 'Download finished';
    $('progress-detail').textContent =
      `${settled.toLocaleString()} of ${status.total.toLocaleString()} files` +
      (status.failed ? ` · ${status.failed} failed` : '');

    if (!status.running) {
      clearInterval(state.polling);
      state.polling = null;
      await load();
      setTimeout(() => {
        $('progress').hidden = true;
      }, 4000);
    }
  }, 1000);
}

// --- Excel export ----------------------------------------------------------

const COLUMNS = [
  { header: 'Collection', width: 20 },
  { header: 'Date posted', width: 13 },
  { header: 'Creator', width: 20 },
  { header: 'Creator name', width: 24 },
  { header: 'Type', width: 11 },
  { header: 'Caption', width: 70 },
  { header: 'Likes', width: 11 },
  { header: 'Comments', width: 11 },
  { header: 'Views', width: 11 },
  { header: 'Post link', width: 44 },
  { header: 'Files', width: 8 },
  { header: 'Saved to folder', width: 32 },
  { header: 'File name', width: 40 },
  { header: 'Downloaded', width: 20 },
  { header: 'Note', width: 34 },
];

function rowFor(post) {
  const files = filesFor(post);
  return [
    post.collection || '',
    formatDate(post.takenAt),
    post.username ? `@${post.username}` : '',
    post.fullName || '',
    post.type,
    post.caption || '',
    post.likeCount,
    post.commentCount,
    post.viewCount,
    post.url,
    files.length,
    folderFor(post),
    files.length === 1 ? files[0].filename.split('/').pop() : `${baseNameFor(post)}_1…${files.length}`,
    post.downloadedAt ? formatWhen(post.downloadedAt) : 'Not downloaded',
    post.downloadError || '',
  ];
}

async function exportExcel() {
  const chosen = state.selected.size
    ? state.filtered.filter((p) => state.selected.has(p.shortcode))
    : state.filtered;

  if (!chosen.length) {
    alert('There are no posts to export. Try widening your filters.');
    return;
  }

  const bytes = buildXlsx(COLUMNS, chosen.map(rowFor), 'Saved posts');
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);

  chrome.downloads.download(
    { url, filename: `Instagram Library/saved-posts-${stamp}.xlsx`, conflictAction: 'uniquify' },
    () => {
      void chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  );
}

// --- wiring ----------------------------------------------------------------

const openSaves = () => chrome.tabs.create({ url: 'https://www.instagram.com/' });

function init() {
  for (const el of document.querySelectorAll('#filters input, #filters select')) {
    el.addEventListener(el.type === 'search' ? 'input' : 'change', applyFilters);
  }

  $('reset-filters').addEventListener('click', () => {
    $('f-search').value = '';
    $('f-collection').value = '';
    $('f-creator').value = '';
    $('f-from').value = '';
    $('f-to').value = '';
    $('f-undownloaded').checked = false;
    $('f-sort').value = 'found-desc';
    for (const el of document.querySelectorAll('.f-type')) el.checked = true;
    applyFilters();
  });

  $('select-all').addEventListener('click', () => {
    for (const post of state.filtered) state.selected.add(post.shortcode);
    applyFilters();
  });

  $('select-none').addEventListener('click', () => {
    state.selected.clear();
    applyFilters();
  });

  $('show-more').addEventListener('click', renderMore);
  $('download').addEventListener('click', startDownload);
  $('export-excel').addEventListener('click', exportExcel);
  $('open-instagram').addEventListener('click', openSaves);
  $('empty-open').addEventListener('click', openSaves);

  $('cancel-download').addEventListener('click', async () => {
    await send({ type: 'download:cancel' });
    clearInterval(state.polling);
    state.polling = null;
    $('progress').hidden = true;
    await load();
  });

  $('clear-library').addEventListener('click', async () => {
    if (!confirm('Remove every post from your library?\n\nFiles you have already downloaded stay on your computer — this only clears the list in the extension.')) return;
    await send({ type: 'library:clear' });
    state.selected.clear();
    await load();
  });

  load();

  // If a download was already running when this tab opened, pick it up.
  send({ type: 'download:status' }).then((status) => {
    if (status.ok && status.running) watchProgress();
  });
}

init();
