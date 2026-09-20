/**
 * The library itself: an IndexedDB store of every post you've scanned.
 * Nothing leaves your computer — there is no server anywhere in this extension.
 */

const DB_NAME = 'saved-library';
const DB_VERSION = 1;
const POSTS = 'posts';
const META = 'meta';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(POSTS)) {
        const store = db.createObjectStore(POSTS, { keyPath: 'shortcode' });
        store.createIndex('username', 'username', { unique: false });
        store.createIndex('collection', 'collection', { unique: false });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('takenAt', 'takenAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const ask = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Adds posts, or refreshes ones already in the library.
 *
 * Instagram's media links are signed and expire after a while, so a re-scan
 * deliberately overwrites them — that's how a "link expired" download is fixed.
 * Anything the user has earned (when it was first seen, whether it has been
 * downloaded) is preserved.
 */
export async function upsertPosts(posts) {
  if (!posts?.length) return { added: 0, refreshed: 0 };
  const db = await openDb();
  const transaction = db.transaction(POSTS, 'readwrite');
  const store = transaction.objectStore(POSTS);
  let added = 0;
  let refreshed = 0;

  for (const post of posts) {
    const existing = await ask(store.get(post.shortcode));
    if (existing) {
      refreshed++;
      store.put({
        ...existing,
        ...post,
        firstSeen: existing.firstSeen ?? post.firstSeen,
        // A post can sit in several collections; keep the first one we saw it in
        // unless it was only ever a right-click save.
        collection:
          existing.collection && existing.collection !== 'Right-click saves'
            ? existing.collection
            : post.collection,
        downloadedAt: existing.downloadedAt ?? null,
        downloadError: existing.downloadError ?? null,
      });
    } else {
      added++;
      store.put({ ...post, downloadedAt: null, downloadError: null });
    }
  }

  await done(transaction);
  return { added, refreshed };
}

export async function getAllPosts() {
  const db = await openDb();
  return ask(tx(db, POSTS, 'readonly').getAll());
}

export async function getPosts(shortcodes) {
  const db = await openDb();
  const store = tx(db, POSTS, 'readonly');
  const out = [];
  for (const code of shortcodes) {
    const post = await ask(store.get(code));
    if (post) out.push(post);
  }
  return out;
}

export async function patchPost(shortcode, changes) {
  const db = await openDb();
  const transaction = db.transaction(POSTS, 'readwrite');
  const store = transaction.objectStore(POSTS);
  const existing = await ask(store.get(shortcode));
  if (existing) store.put({ ...existing, ...changes });
  await done(transaction);
}

export async function countPosts() {
  const db = await openDb();
  return ask(tx(db, POSTS, 'readonly').count());
}

export async function clearLibrary() {
  const db = await openDb();
  const transaction = db.transaction(POSTS, 'readwrite');
  transaction.objectStore(POSTS).clear();
  await done(transaction);
}

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const row = await ask(tx(db, META, 'readonly').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const transaction = db.transaction(META, 'readwrite');
  transaction.objectStore(META).put({ key, value });
  await done(transaction);
}
