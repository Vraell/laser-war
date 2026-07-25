const DATABASE_NAME = "laser-war-local-files";
const STORE_NAME = "handles";
const HANDLE_KEY = "match-log";
const FILE_NAME = "laser-war-live-match-logs.json";

let writeQueue = Promise.resolve(false);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readHandle() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function storeHandle(handle) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function hasWritePermission(handle, request = false) {
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return request && await handle.requestPermission(options) === "granted";
}

async function writeArchive(handle, archive) {
  if (!await hasWritePermission(handle)) return false;
  const writable = await handle.createWritable();
  await writable.write(`${JSON.stringify({
    ...archive,
    mirroredAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await writable.close();
  return true;
}

export function fileMirrorSupported() {
  return "showSaveFilePicker" in window && "indexedDB" in window;
}

export async function fileMirrorEnabled() {
  if (!fileMirrorSupported()) return false;
  const handle = await readHandle();
  return Boolean(handle && await hasWritePermission(handle));
}

export async function enableFileMirror(archive) {
  if (!fileMirrorSupported()) return false;
  const handle = await window.showSaveFilePicker({
    suggestedName: FILE_NAME,
    types: [{
      description: "Laser War match logs",
      accept: { "application/json": [".json"] },
    }],
  });
  if (!await hasWritePermission(handle, true)) return false;
  await storeHandle(handle);
  return writeArchive(handle, archive);
}

export function queueFileMirror(archive) {
  if (!fileMirrorSupported()) return Promise.resolve(false);
  writeQueue = writeQueue
    .catch(() => false)
    .then(async () => {
      const handle = await readHandle();
      return handle ? writeArchive(handle, archive) : false;
    });
  return writeQueue;
}
