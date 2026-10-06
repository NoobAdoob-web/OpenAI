// Read-only access to WhatsApp Web's own on-computer database (IndexedDB).
// Rules: never create a database, never write, never hold it open.
// Reading it makes no network request (rules S4, S12).

/* eslint-disable @typescript-eslint/no-explicit-any */

export const WA_DB = 'model-storage';

export async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') return false;
  const list = await indexedDB.databases();
  return list.some((d) => d.name === name);
}

/** Opens an existing database read-only. Refuses to create one. */
export async function openExisting(name: string): Promise<IDBDatabase | undefined> {
  if (!(await databaseExists(name))) return undefined;
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      // Opening without a version should never upgrade an existing database.
      // If it would, back out so we never change WhatsApp's data.
      req.transaction?.abort();
      resolve(undefined);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If WhatsApp needs to upgrade its database, get out of its way at once.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(undefined);
    req.onblocked = () => resolve(undefined);
  });
}

export function storeNames(db: IDBDatabase): string[] {
  return [...db.objectStoreNames];
}

/** Visits every record in a store, read-only. Return false from `visit` to stop early. */
export function iterateStore(db: IDBDatabase, store: string, visit: (value: any) => boolean | void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      if (visit(cursor.value) === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Runs `fn` with WhatsApp's database open, and always closes it afterwards. */
export async function withWaDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> {
  const db = await openExisting(WA_DB);
  if (!db) return undefined;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
