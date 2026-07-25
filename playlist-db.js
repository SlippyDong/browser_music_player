"use strict";

(() => {
  const DB_NAME = "standalone-music-player";
  const DB_VERSION = 1;
  const PLAYLIST_STORE = "playlists";

  let databasePromise;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          transaction.error || new Error("IndexedDB transaction was aborted."),
        );
      transaction.onerror = () =>
        reject(transaction.error || new Error("IndexedDB transaction failed."));
    });
  }

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(PLAYLIST_STORE)) {
            const store = database.createObjectStore(PLAYLIST_STORE, {
              keyPath: "id",
            });
            store.createIndex("name", "name", { unique: false });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () =>
          reject(request.error || new Error("Could not open IndexedDB."));
        request.onblocked = () =>
          reject(
            new Error(
              "IndexedDB upgrade was blocked by another open player window.",
            ),
          );
      });
    }
    return databasePromise;
  }

  async function listPlaylists() {
    const database = await openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readonly");
    const done = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(PLAYLIST_STORE).getAll(),
    );
    await done;
    return records.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }

  async function getPlaylist(id) {
    const database = await openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readonly");
    const done = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(PLAYLIST_STORE).get(id),
    );
    await done;
    return record || null;
  }

  async function putPlaylist(record) {
    const database = await openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(PLAYLIST_STORE).put(record);
    await done;
    return record;
  }

  async function deletePlaylist(id) {
    const database = await openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(PLAYLIST_STORE).delete(id);
    await done;
  }

  window.PlaylistDB = Object.freeze({
    listPlaylists,
    getPlaylist,
    putPlaylist,
    deletePlaylist,
  });
})();
