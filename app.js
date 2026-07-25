"use strict";
const $ = (s) => document.querySelector(s);
const audio = $("#audio");
const state = {
  tracks: [],
  currentId: null,
  selected: new Set(),
  sortKey: null,
  sortDir: 1,
  filter: "",
  shuffle: false,
  repeat: "off",
  dragId: null,
  currentPlaylistId: null,
  currentPlaylistName: "",
  playlistDirty: false,
  loadingPlaylist: false,
  unavailableEntries: [],
  unavailableRoots: [],
  installPrompt: null,
};
const AUDIO_EXT = new Set(["mp3", "wav", "wave", "flac"]);
const textEncoder = new TextEncoder();
function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}
function ext(name) {
  return name.split(".").pop().toLowerCase();
}
function baseName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}
function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function clean(v) {
  return String(v ?? "")
    .replace(/\0/g, "")
    .trim();
}
function mimeFor(name) {
  return ext(name) === "mp3"
    ? "audio/mpeg"
    : ext(name) === "flac"
      ? "audio/flac"
      : "audio/wav";
}
function notice(msg, type = "") {
  const n = $("#notice");
  if (!n) {
    console.info(msg);
    return;
  }
  n.textContent = msg;
  n.className = `notice ${type}`.trim();
}
function latin1(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function latin1Bytes(str, len = null) {
  const a = Array.from(String(str), (c) =>
    c.charCodeAt(0) <= 255 ? c.charCodeAt(0) : 63,
  );
  if (len === null) return new Uint8Array(a);
  const out = new Uint8Array(len);
  out.set(a.slice(0, len));
  return out;
}
function readU32BE(v, o) {
  return v.getUint32(o, false);
}
function readU32LE(v, o) {
  return v.getUint32(o, true);
}
function synchsafeToInt(a, b, c, d) {
  return (a << 21) | (b << 14) | (c << 7) | d;
}
function intToSynchsafe(n) {
  return new Uint8Array([
    (n >> 21) & 127,
    (n >> 14) & 127,
    (n >> 7) & 127,
    n & 127,
  ]);
}
function concatArrays(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0),
    out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function decodeText(bytes, enc = 3) {
  if (!bytes?.length) return "";
  try {
    if (enc === 0) return clean(latin1(bytes));
    if (enc === 3) return clean(new TextDecoder("utf-8").decode(bytes));
    if (enc === 1) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return clean(new TextDecoder("utf-16le").decode(bytes.slice(2)));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        const swapped = new Uint8Array(bytes.length - 2);
        for (let i = 2; i + 1 < bytes.length; i += 2) {
          swapped[i - 2] = bytes[i + 1];
          swapped[i - 1] = bytes[i];
        }
        return clean(new TextDecoder("utf-16le").decode(swapped));
      }
      return clean(new TextDecoder("utf-16le").decode(bytes));
    }
    if (enc === 2) {
      const swapped = new Uint8Array(bytes.length);
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        swapped[i] = bytes[i + 1];
        swapped[i + 1] = bytes[i];
      }
      return clean(new TextDecoder("utf-16le").decode(swapped));
    }
  } catch {}
  return clean(latin1(bytes));
}
function parseMp3(buf) {
  const u = new Uint8Array(buf),
    v = new DataView(buf),
    m = {
      title: "",
      artist: "",
      album: "",
      year: "",
      track: "",
      genre: "",
      comment: "",
    },
    tech = {};
  let audioStart = 0,
    preserved = [];
  if (u.length >= 10 && latin1(u.slice(0, 3)) === "ID3") {
    const ver = u[3],
      flags = u[5],
      size = synchsafeToInt(u[6], u[7], u[8], u[9]);
    audioStart = Math.min(u.length, 10 + size + (flags & 0x10 ? 10 : 0));
    let p = 10;
    if (flags & 0x40) {
      const es =
        ver === 4
          ? synchsafeToInt(u[p], u[p + 1], u[p + 2], u[p + 3])
          : readU32BE(v, p);
      p += ver === 3 ? es + 4 : es;
    }
    while (p + 10 <= 10 + size && p + 10 <= u.length) {
      const id = latin1(u.slice(p, p + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs =
        ver === 4
          ? synchsafeToInt(u[p + 4], u[p + 5], u[p + 6], u[p + 7])
          : readU32BE(v, p + 4);
      if (fs <= 0 || p + 10 + fs > u.length) break;
      const flags2 = (u[p + 8] << 8) | u[p + 9],
        content = u.slice(p + 10, p + 10 + fs);
      const val = () => decodeText(content.slice(1), content[0]);
      if (id === "TIT2") m.title = val();
      else if (id === "TPE1") m.artist = val();
      else if (id === "TALB") m.album = val();
      else if (id === "TYER" || id === "TDRC") m.year = val();
      else if (id === "TRCK") m.track = val();
      else if (id === "TCON") m.genre = val();
      else if (id === "COMM") {
        let q = 4;
        while (
          q < content.length - 1 &&
          !(
            content[q] === 0 &&
            (content[q + 1] === 0 || content[0] === 0 || content[0] === 3)
          )
        )
          q++;
        m.comment = decodeText(
          content.slice(
            Math.min(
              content.length,
              q + (content[0] === 1 || content[0] === 2 ? 2 : 1),
            ),
          ),
          content[0],
        );
      } else if (!(flags2 & 0x00e0)) preserved.push({ id, content });
      p += 10 + fs;
    }
  }
  if (
    u.length >= 128 &&
    latin1(u.slice(u.length - 128, u.length - 125)) === "TAG"
  ) {
    const p = u.length - 128;
    m.title ||= clean(latin1(u.slice(p + 3, p + 33)));
    m.artist ||= clean(latin1(u.slice(p + 33, p + 63)));
    m.album ||= clean(latin1(u.slice(p + 63, p + 93)));
    m.year ||= clean(latin1(u.slice(p + 93, p + 97)));
    m.comment ||= clean(latin1(u.slice(p + 97, p + 127)));
    if (u[p + 125] === 0) m.track ||= String(u[p + 126] || "");
  }
  for (
    let p = audioStart;
    p + 4 < u.length && p < audioStart + 1024 * 1024;
    p++
  ) {
    if (u[p] === 0xff && (u[p + 1] & 0xe0) === 0xe0) {
      const version = (u[p + 1] >> 3) & 3,
        layer = (u[p + 1] >> 1) & 3,
        br = (u[p + 2] >> 4) & 15,
        sr = (u[p + 2] >> 2) & 3,
        mode = (u[p + 3] >> 6) & 3;
      const brTab =
        version === 3
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const srBase = [44100, 48000, 32000];
      if (layer === 1 && br > 0 && br < 15 && sr < 3) {
        tech.bitrate = brTab[br];
        tech.sampleRate = Math.round(
          srBase[sr] / (version === 2 ? 2 : version === 0 ? 4 : 1),
        );
        tech.channels = mode === 3 ? 1 : 2;
        break;
      }
    }
  }
  const id3v1Bytes =
    u.length >= 128 && latin1(u.slice(u.length - 128, u.length - 125)) === "TAG"
      ? 128
      : 0;
  tech.audioBytes = Math.max(0, u.length - audioStart - id3v1Bytes);
  return { metadata: m, technical: tech, mp3: { audioStart, preserved } };
}
function parseFlac(buf) {
  const u = new Uint8Array(buf);
  if (latin1(u.slice(0, 4)) !== "fLaC") throw Error("Invalid FLAC header");
  let p = 4,
    last = false,
    audioStart = 4;
  const m = {
      title: "",
      artist: "",
      album: "",
      year: "",
      track: "",
      genre: "",
      comment: "",
    },
    tech = {},
    blocks = [];
  while (!last && p + 4 <= u.length) {
    const h = u[p],
      type = h & 127;
    last = !!(h & 128);
    const len = (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3],
      data = u.slice(p + 4, p + 4 + len);
    blocks.push({ type, data });
    if (type === 0 && len >= 34) {
      const x =
        (BigInt(data[10]) << 56n) |
        (BigInt(data[11]) << 48n) |
        (BigInt(data[12]) << 40n) |
        (BigInt(data[13]) << 32n) |
        (BigInt(data[14]) << 24n) |
        (BigInt(data[15]) << 16n) |
        (BigInt(data[16]) << 8n) |
        BigInt(data[17]);
      tech.sampleRate = Number((x >> 44n) & 0xfffffn);
      tech.channels = Number((x >> 41n) & 7n) + 1;
      tech.bitDepth = Number((x >> 36n) & 31n) + 1;
      const total = Number(x & 0xfffffffffn);
      if (tech.sampleRate) tech.duration = total / tech.sampleRate;
    }
    if (type === 4 && len >= 8) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let q = 0;
      const vendorLen = dv.getUint32(q, true);
      q += 4 + vendorLen;
      if (q + 4 <= data.length) {
        const count = dv.getUint32(q, true);
        q += 4;
        for (let i = 0; i < count && q + 4 <= data.length; i++) {
          const n = dv.getUint32(q, true);
          q += 4;
          const value = new TextDecoder().decode(data.slice(q, q + n));
          q += n;
          const k = value.indexOf("=");
          if (k > 0) {
            const key = value.slice(0, k).toUpperCase(),
              val = value.slice(k + 1);
            if (key === "TITLE") m.title = val;
            else if (key === "ARTIST") m.artist = val;
            else if (key === "ALBUM") m.album = val;
            else if (key === "DATE" || key === "YEAR") m.year = val;
            else if (key === "TRACKNUMBER") m.track = val;
            else if (key === "GENRE") m.genre = val;
            else if (key === "COMMENT" || key === "DESCRIPTION")
              m.comment = val;
          }
        }
      }
    }
    p += 4 + len;
    audioStart = p;
  }
  tech.audioBytes = Math.max(0, u.length - audioStart);
  return { metadata: m, technical: tech, flac: { blocks, audioStart } };
}
function parseWav(buf) {
  const u = new Uint8Array(buf),
    v = new DataView(buf);
  if (latin1(u.slice(0, 4)) !== "RIFF" || latin1(u.slice(8, 12)) !== "WAVE")
    throw Error("Invalid WAV header");
  let p = 12,
    dataBytes = 0;
  const m = {
      title: "",
      artist: "",
      album: "",
      year: "",
      track: "",
      genre: "",
      comment: "",
    },
    tech = {},
    chunks = [];
  while (p + 8 <= u.length) {
    const id = latin1(u.slice(p, p + 4)),
      len = readU32LE(v, p + 4),
      end = Math.min(u.length, p + 8 + len),
      data = u.slice(p + 8, end);
    chunks.push({ id, data });
    if (id === "fmt " && len >= 16) {
      tech.channels = v.getUint16(p + 10, true);
      tech.sampleRate = v.getUint32(p + 12, true);
      tech.bitrate = Math.round((v.getUint32(p + 16, true) * 8) / 1000);
      tech.bitDepth = v.getUint16(p + 22, true);
    } else if (id === "data") dataBytes = len;
    else if (id === "LIST" && latin1(data.slice(0, 4)) === "INFO") {
      let q = 4;
      while (q + 8 <= data.length) {
        const sid = latin1(data.slice(q, q + 4)),
          sl = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ).getUint32(q + 4, true),
          sv = clean(new TextDecoder().decode(data.slice(q + 8, q + 8 + sl)));
        if (sid === "INAM") m.title = sv;
        else if (sid === "IART") m.artist = sv;
        else if (sid === "IPRD") m.album = sv;
        else if (sid === "ICRD") m.year = sv;
        else if (sid === "ITRK") m.track = sv;
        else if (sid === "IGNR") m.genre = sv;
        else if (sid === "ICMT") m.comment = sv;
        q += 8 + sl + (sl & 1);
      }
    }
    p += 8 + len + (len & 1);
  }
  tech.audioBytes = dataBytes;
  if (tech.bitrate)
    dataBytes && (tech.duration = dataBytes / ((tech.bitrate * 1000) / 8));
  return { metadata: m, technical: tech, wav: { chunks } };
}
async function parseFile(file) {
  const x = ext(file.name);
  if (!AUDIO_EXT.has(x)) throw Error("Unsupported file type");
  const buf = await file.arrayBuffer();
  let r =
    x === "mp3" ? parseMp3(buf) : x === "flac" ? parseFlac(buf) : parseWav(buf);
  r.buffer = buf;
  return r;
}
function updatePlaylistState() {
  const status = $("#playlistState");
  const renameButton = $("#renamePlaylist");
  const deleteButton = $("#deletePlaylist");
  if (!status) return;
  if (state.currentPlaylistId) {
    status.textContent = state.playlistDirty
      ? `${state.currentPlaylistName} · unsaved playlist changes`
      : `${state.currentPlaylistName} · saved`;
    status.className = `playlistState ${state.playlistDirty ? "dirty" : "saved"}`;
  } else {
    status.textContent = state.playlistDirty
      ? "Unsaved playlist changes"
      : "Not saved";
    status.className =
      `playlistState ${state.playlistDirty ? "dirty" : ""}`.trim();
  }
  renameButton.disabled = !state.currentPlaylistId;
  deleteButton.disabled = !state.currentPlaylistId;
  document.title = state.currentPlaylistName
    ? `${state.playlistDirty ? "* " : ""}${state.currentPlaylistName} · Music Player`
    : `${state.playlistDirty ? "* " : ""}Music Player`;
}
function markPlaylistDirty() {
  if (state.loadingPlaylist) return;
  state.playlistDirty = true;
  updatePlaylistState();
}
function clearRuntimePlaylist() {
  stop();
  audio.removeAttribute("src");
  state.currentId = null;
  updateNow(null);
  for (const t of state.tracks) URL.revokeObjectURL(t.objectUrl);
  state.tracks = [];
  state.selected.clear();
  state.unavailableEntries = [];
  state.unavailableRoots = [];
  state.sortKey = null;
  state.filter = "";
  $("#search").value = "";
  $("#currentTime").textContent = "0:00";
  $("#duration").textContent = "0:00";
  $("#seek").value = 0;
  render();
}
function hasUnsavedWork() {
  return state.playlistDirty || state.tracks.some((t) => t.dirty);
}
function confirmReplaceCurrentPlaylist(action) {
  if (!hasUnsavedWork()) return true;
  return confirm(
    `${action} will replace the current playlist. Unsaved playlist changes or metadata edits will be lost. Continue?`,
  );
}
async function ensureHandlePermission(handle, mode = "read") {
  if (!handle) return false;
  const options = { mode };
  try {
    if (!handle.queryPermission || !handle.requestPermission) return true;
    const current = await handle.queryPermission(options);
    if (current === "granted") return true;
    if (current === "denied") return false;
    return (await handle.requestPermission(options)) === "granted";
  } catch {
    return false;
  }
}
async function resolveFileFromRoot(rootHandle, pathFromRoot) {
  const parts = String(pathFromRoot || "")
    .split("/")
    .filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw Error("The saved relative path is empty.");
  let parentDirHandle = rootHandle;
  for (const part of parts) {
    parentDirHandle = await parentDirHandle.getDirectoryHandle(part);
  }
  const fileHandle = await parentDirHandle.getFileHandle(fileName);
  return {
    fileHandle,
    parentDirHandle,
    file: await fileHandle.getFile(),
  };
}
function serializeCurrentPlaylist(id, name, existingRecord = null) {
  const rootIds = new Map();
  const rootsById = new Map();
  const tracks = state.tracks.map((t) => {
    if (t.rootDirHandle && t.pathFromRoot) {
      let rootId = t.rootStorageId || rootIds.get(t.rootDirHandle);
      if (!rootId) rootId = uid();
      t.rootStorageId = rootId;
      rootIds.set(t.rootDirHandle, rootId);
      rootsById.set(rootId, {
        id: rootId,
        name: t.rootDirHandle.name || "Music folder",
        handle: t.rootDirHandle,
      });
      return {
        id: t.id,
        sourceType: "directory",
        rootId,
        fileName: t.fileName,
        relativePath: t.relativePath,
        pathFromRoot: t.pathFromRoot,
      };
    }
    if (t.handle) {
      return {
        id: t.id,
        sourceType: "file",
        fileName: t.fileName,
        relativePath: t.relativePath,
        fileHandle: t.handle,
        parentDirHandle: t.parentDirHandle || null,
      };
    }
    return {
      id: t.id,
      sourceType: "unresolved",
      fileName: t.fileName,
      relativePath: t.relativePath,
    };
  });
  const loadedIds = new Set(tracks.map((t) => t.id));
  for (const entry of state.unavailableEntries) {
    if (!loadedIds.has(entry.id)) tracks.push(entry);
  }
  const requiredUnavailableRootIds = new Set(
    state.unavailableEntries
      .filter((entry) => entry.sourceType === "directory")
      .map((entry) => entry.rootId),
  );
  for (const root of state.unavailableRoots) {
    if (requiredUnavailableRootIds.has(root.id) && !rootsById.has(root.id)) {
      rootsById.set(root.id, root);
    }
  }
  const now = new Date().toISOString();
  return {
    id,
    name,
    version: 1,
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
    roots: [...rootsById.values()],
    tracks,
  };
}
async function refreshPlaylistSelect(selectedId = state.currentPlaylistId) {
  const select = $("#playlistSelect");
  const records = await PlaylistDB.listPlaylists();
  select.innerHTML = '<option value="">Choose saved playlist…</option>';
  for (const record of records) {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${record.name} (${record.tracks?.length || 0})`;
    select.appendChild(option);
  }
  select.value = selectedId || "";
  return records;
}
async function nameExists(name, exceptId = null) {
  const records = await PlaylistDB.listPlaylists();
  return records.some(
    (record) =>
      record.id !== exceptId &&
      record.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0,
  );
}
async function requestPlaylistName(message, defaultName = "", exceptId = null) {
  const value = prompt(message, defaultName);
  if (value === null) return null;
  const name = value.trim();
  if (!name) {
    notice("A playlist name is required.", "warn");
    return null;
  }
  if (await nameExists(name, exceptId)) {
    notice(`A playlist named "${name}" already exists.`, "warn");
    return null;
  }
  return name;
}
async function savePlaylistRecord({ saveAs = false, forcedName = null } = {}) {
  try {
    let id =
      saveAs || !state.currentPlaylistId ? uid() : state.currentPlaylistId;
    let existing =
      !saveAs && state.currentPlaylistId
        ? await PlaylistDB.getPlaylist(state.currentPlaylistId)
        : null;
    let name = forcedName;
    if (!name) {
      name =
        saveAs || !state.currentPlaylistId
          ? await requestPlaylistName(
              "Playlist name:",
              state.currentPlaylistName || "My playlist",
            )
          : state.currentPlaylistName;
    }
    if (!name) return null;
    if (
      !saveAs &&
      state.currentPlaylistId &&
      (await nameExists(name, state.currentPlaylistId))
    ) {
      notice(`A playlist named "${name}" already exists.`, "warn");
      return null;
    }
    const record = serializeCurrentPlaylist(id, name, existing);
    await PlaylistDB.putPlaylist(record);
    state.currentPlaylistId = id;
    state.currentPlaylistName = name;
    state.playlistDirty = false;
    await refreshPlaylistSelect(id);
    updatePlaylistState();
    const unresolved = record.tracks.filter(
      (t) => t.sourceType === "unresolved",
    ).length;
    notice(
      unresolved
        ? `Saved "${name}". ${unresolved} track(s) lack reusable file handles and cannot be restored automatically.`
        : `Saved playlist "${name}" with ${record.tracks.length} track(s).`,
      unresolved ? "warn" : "good",
    );
    return record;
  } catch (error) {
    notice(`Could not save the playlist: ${error.message}`, "bad");
    return null;
  }
}
async function openPlaylistRecord(id) {
  if (!id) return;
  if (!confirmReplaceCurrentPlaylist("Opening another playlist")) {
    $("#playlistSelect").value = state.currentPlaylistId || "";
    return;
  }
  const record = await PlaylistDB.getPlaylist(id);
  if (!record) {
    notice("The selected playlist no longer exists.", "bad");
    await refreshPlaylistSelect();
    return;
  }
  state.loadingPlaylist = true;
  clearRuntimePlaylist();
  state.currentPlaylistId = record.id;
  state.currentPlaylistName = record.name;
  state.unavailableRoots = [...(record.roots || [])];
  const roots = new Map(state.unavailableRoots.map((root) => [root.id, root]));
  const rootPermissions = new Map();
  let restored = 0;
  let unavailable = 0;
  notice(`Opening "${record.name}"…`, "");
  try {
    for (const entry of record.tracks || []) {
      try {
        if (entry.sourceType === "directory") {
          const root = roots.get(entry.rootId);
          if (!root?.handle)
            throw Error("The saved root folder handle is missing.");
          let allowed = rootPermissions.get(entry.rootId);
          if (allowed === undefined) {
            allowed = await ensureHandlePermission(root.handle, "read");
            rootPermissions.set(entry.rootId, allowed);
          }
          if (!allowed)
            throw Error(
              `Access to ${root.name || "the music folder"} was not granted.`,
            );
          const resolved = await resolveFileFromRoot(
            root.handle,
            entry.pathFromRoot,
          );
          await addFile(
            resolved.file,
            resolved.fileHandle,
            resolved.parentDirHandle,
            entry.relativePath || `${root.name}/${entry.pathFromRoot}`,
            {
              id: entry.id,
              rootDirHandle: root.handle,
              rootStorageId: entry.rootId,
              pathFromRoot: entry.pathFromRoot,
              markPlaylistDirty: false,
              suppressRender: true,
            },
          );
        } else if (entry.sourceType === "file" && entry.fileHandle) {
          if (!(await ensureHandlePermission(entry.fileHandle, "read"))) {
            throw Error(`Access to ${entry.fileName} was not granted.`);
          }
          const file = await entry.fileHandle.getFile();
          await addFile(
            file,
            entry.fileHandle,
            entry.parentDirHandle || null,
            entry.relativePath || file.name,
            {
              id: entry.id,
              markPlaylistDirty: false,
              suppressRender: true,
            },
          );
        } else {
          throw Error("This entry was saved without a reusable file handle.");
        }
        restored++;
      } catch (error) {
        state.unavailableEntries.push(entry);
        unavailable++;
        console.warn(
          `Could not restore ${entry.fileName || entry.relativePath}:`,
          error,
        );
      }
    }
  } finally {
    state.loadingPlaylist = false;
  }
  state.playlistDirty = false;
  render();
  updatePlaylistState();
  await refreshPlaylistSelect(record.id);
  notice(
    unavailable
      ? `Opened "${record.name}": ${restored} restored, ${unavailable} unavailable. Unavailable references will be preserved when the playlist is saved.`
      : `Opened "${record.name}" with ${restored} track(s). Metadata was read fresh from the files.`,
    unavailable ? "warn" : "good",
  );
}
async function createNewPlaylist() {
  if (!confirmReplaceCurrentPlaylist("Creating a new playlist")) return;
  const name = await requestPlaylistName("New playlist name:", "New playlist");
  if (!name) return;
  state.loadingPlaylist = true;
  clearRuntimePlaylist();
  state.loadingPlaylist = false;
  state.currentPlaylistId = null;
  state.currentPlaylistName = name;
  state.playlistDirty = true;
  await savePlaylistRecord({ forcedName: name });
}
async function renameCurrentPlaylist() {
  if (!state.currentPlaylistId) return;
  const name = await requestPlaylistName(
    "Rename playlist:",
    state.currentPlaylistName,
    state.currentPlaylistId,
  );
  if (!name) return;
  const record = await PlaylistDB.getPlaylist(state.currentPlaylistId);
  if (!record) return;
  record.name = name;
  record.updatedAt = new Date().toISOString();
  await PlaylistDB.putPlaylist(record);
  state.currentPlaylistName = name;
  await refreshPlaylistSelect(record.id);
  updatePlaylistState();
  notice(`Renamed the playlist to "${name}".`, "good");
}
async function deleteCurrentPlaylist() {
  if (!state.currentPlaylistId) return;
  if (
    !confirm(
      `Delete the saved playlist "${state.currentPlaylistName}"? Audio files will not be deleted.`,
    )
  )
    return;
  await PlaylistDB.deletePlaylist(state.currentPlaylistId);
  state.currentPlaylistId = null;
  state.currentPlaylistName = "";
  state.playlistDirty =
    state.tracks.length > 0 || state.unavailableEntries.length > 0;
  await refreshPlaylistSelect();
  updatePlaylistState();
  notice(
    "The saved playlist was deleted. The currently loaded tracks remain open as an unsaved playlist.",
    "good",
  );
}
async function addFile(
  file,
  handle = null,
  parentDirHandle = null,
  relativePath = "",
  options = {},
) {
  if (!AUDIO_EXT.has(ext(file.name))) return null;
  const normalizedPath = relativePath || file.webkitRelativePath || file.name;
  const dup = state.tracks.find(
    (t) =>
      t.file.name === file.name &&
      t.file.size === file.size &&
      t.file.lastModified === file.lastModified &&
      t.relativePath === normalizedPath,
  );
  if (dup) return dup;
  const t = {
    id: options.id || uid(),
    file,
    handle,
    parentDirHandle,
    rootDirHandle: options.rootDirHandle || null,
    rootStorageId: options.rootStorageId || null,
    pathFromRoot: options.pathFromRoot || "",
    relativePath: normalizedPath,
    fileName: file.name,
    originalName: file.name,
    objectUrl: URL.createObjectURL(file),
    metadata: {
      title: "",
      artist: "",
      album: "",
      year: "",
      track: "",
      genre: "",
      comment: "",
    },
    technical: {},
    dirty: false,
    error: "",
    writable: !!handle,
  };
  state.tracks.push(t);
  if (options.markPlaylistDirty !== false) markPlaylistDirty();
  if (!options.suppressRender) render();
  try {
    const r = await parseFile(file);
    Object.assign(t.metadata, r.metadata);
    Object.assign(t.technical, r.technical);
    t.parseInfo = r;
    await loadDuration(t);
    if (!options.suppressRender) render();
  } catch (e) {
    t.error = e.message;
    if (!options.suppressRender) render();
  }
  return t;
}
function updateActualBitrate(t) {
  const duration = Number(t.technical.duration),
    audioBytes = Number(t.technical.audioBytes);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const bytes =
    Number.isFinite(audioBytes) && audioBytes > 0 ? audioBytes : t.file.size;
  t.technical.bitrate = Math.round((bytes * 8) / duration / 1000);
}
function loadDuration(t) {
  return new Promise((resolve) => {
    if (Number.isFinite(t.technical.duration)) {
      updateActualBitrate(t);
      resolve();
      return;
    }
    const a = new Audio();
    a.preload = "metadata";
    a.src = t.objectUrl;
    const done = () => {
      if (Number.isFinite(a.duration)) {
        t.technical.duration = a.duration;
        updateActualBitrate(t);
      }
      a.src = "";
      resolve();
    };
    a.addEventListener("loadedmetadata", done, { once: true });
    a.addEventListener("error", done, { once: true });
  });
}
async function addHandles(handles, parent = null, prefix = "") {
  for (const h of handles) {
    if (h.kind === "file") {
      const f = await h.getFile();
      await addFile(f, h, parent, prefix ? `${prefix}/${f.name}` : f.name);
    } else if (h.kind === "directory") {
      await walkDirectory(h, h.name, h, "");
    }
  }
}
async function walkDirectory(
  dir,
  displayPrefix = dir.name,
  rootDirHandle = dir,
  pathPrefix = "",
) {
  for await (const h of dir.values()) {
    const pathFromRoot = pathPrefix ? `${pathPrefix}/${h.name}` : h.name;
    if (h.kind === "file") {
      const f = await h.getFile();
      await addFile(f, h, dir, `${displayPrefix}/${f.name}`, {
        rootDirHandle,
        pathFromRoot,
      });
    } else {
      await walkDirectory(
        h,
        `${displayPrefix}/${h.name}`,
        rootDirHandle,
        pathFromRoot,
      );
    }
  }
}
async function chooseFiles() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const hs = await showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Audio files",
            accept: {
              "audio/mpeg": [".mp3"],
              "audio/wav": [".wav", ".wave"],
              "audio/flac": [".flac"],
            },
          },
        ],
      });
      await addHandles(hs);
      notice(`Added ${hs.length} selected file(s).`, "good");
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
      notice(
        `The native file picker was unavailable: ${e.message}. Using the standard file picker instead.`,
        "warn",
      );
    }
  }
  const fallback = $("#fallbackFiles");
  fallback.value = "";
  fallback.click();
}
async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    $("#fallbackFolder").click();
    return;
  }
  try {
    const dir = await showDirectoryPicker({ mode: "readwrite" });
    await walkDirectory(dir, dir.name, dir, "");
    notice(
      `Loaded audio files from ${dir.name}. Files have a parent-folder handle for rename support.`,
      "good",
    );
  } catch (e) {
    if (e.name !== "AbortError") {
      notice(
        `Native folder access was unavailable: ${e.message}. Using read-only folder selection instead.`,
        "warn",
      );
      $("#fallbackFolder").click();
    }
  }
}
async function handleDrop(e) {
  e.preventDefault();
  const transfer = e.dataTransfer;
  const items = [...(transfer?.items || [])].filter(
    (item) => item.kind === "file",
  );
  const candidates = items.map((item) => {
    let handlePromise = null,
      file = null;
    if (typeof item.getAsFileSystemHandle === "function") {
      try {
        handlePromise = Promise.resolve(item.getAsFileSystemHandle()).catch(
          () => null,
        );
      } catch {}
    }
    if (typeof item.getAsFile === "function") {
      try {
        file = item.getAsFile();
      } catch {}
    }
    return { handlePromise, file };
  });
  const handles = [];
  const files = [];
  for (const candidate of candidates) {
    const handle = candidate.handlePromise
      ? await candidate.handlePromise
      : null;
    if (handle) handles.push(handle);
    else if (candidate.file) files.push(candidate.file);
  }
  if (!handles.length && !files.length)
    for (const file of transfer?.files || []) if (file) files.push(file);
  for (const handle of handles) {
    if (handle.kind === "file") {
      const f = await handle.getFile();
      await addFile(f, handle, null, f.name);
    } else if (handle.kind === "directory") {
      await walkDirectory(handle, handle.name, handle, "");
    }
  }
  for (const file of files)
    await addFile(file, null, null, file.webkitRelativePath || file.name);
  notice(
    "Dropped audio files added. Write access depends on the handles supplied by your browser.",
    "good",
  );
}
function displayedTracks() {
  let a = state.tracks.filter((t) => {
    const q = state.filter.toLowerCase();
    return (
      !q ||
      [
        t.fileName,
        t.metadata.title,
        t.metadata.artist,
        t.metadata.album,
        t.relativePath,
      ].some((v) =>
        String(v || "")
          .toLowerCase()
          .includes(q),
      )
    );
  });
  if (state.sortKey) {
    const k = state.sortKey,
      d = state.sortDir;
    a = [...a].sort((x, y) => {
      let A = getSort(x, k),
        B = getSort(y, k);
      return (
        (typeof A === "number" && typeof B === "number"
          ? A - B
          : String(A).localeCompare(String(B), undefined, {
              numeric: true,
              sensitivity: "base",
            })) * d
      );
    });
  }
  return a;
}
function getSort(t, k) {
  if (k === "index") return state.tracks.indexOf(t);
  if (k === "fileName") return t.fileName;
  if (k === "path") return t.relativePath;
  if (k === "size") return t.file.size;
  if (k === "type") return ext(t.fileName);
  if (k in t.technical) return t.technical[k] || 0;
  return t.metadata[k] || "";
}
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function editableCell(t, field, group = "metadata") {
  const value = group === "root" ? t[field] : t[group][field];
  const display = clean(value) || "—";
  return `<span class="editableValue ${t.dirty ? "dirty" : ""} ${clean(value) ? "" : "emptyValue"}" data-id="${t.id}" data-group="${group}" data-field="${field}" data-full="${escapeHtml(value)}" tabindex="0" aria-label="${escapeHtml(`Edit ${field}: ${display}`)}">${escapeHtml(display)}</span>`;
}
function render() {
  const arr = displayedTracks();
  $("#count").textContent =
    `${state.tracks.length} track${state.tracks.length === 1 ? "" : "s"}${state.selected.size ? ` · ${state.selected.size} selected` : ""}`;
  const b = $("#playlistBody");
  if (!arr.length) {
    b.innerHTML = `<tr><td colspan="15" class="empty">${state.tracks.length ? "No tracks match the filter." : "No tracks in the playlist."}</td></tr>`;
    return;
  }
  b.innerHTML = arr
    .map(
      (t) =>
        `<tr data-id="${t.id}" draggable="true" class="${state.currentId === t.id ? "playing " : ""}${state.selected.has(t.id) ? "selected" : ""}"><td class="actionsCell"><div class="menu"><button class="small" data-action="play" data-id="${t.id}">Play</button><button class="small" data-action="save" data-id="${t.id}">Save</button></div></td><td><input type="checkbox" data-select="${t.id}" ${state.selected.has(t.id) ? "checked" : ""}></td><td>${state.tracks.indexOf(t) + 1}</td><td class="fileNameCell"><div class="fileNameContent"><span class="playdot ${state.currentId === t.id ? "active" : ""}"></span>${editableCell(t, "fileName", "root")}</div></td><td>${formatTime(t.technical.duration)}</td><td>${formatBytes(t.file.size)}</td><td>${ext(t.fileName).toUpperCase()}</td><td>${t.technical.bitrate ? `${Math.round(t.technical.bitrate)} kbps` : "—"}</td><td>${editableCell(t, "title")}</td><td>${editableCell(t, "artist")}</td><td>${editableCell(t, "album")}</td><td>${editableCell(t, "year")}</td><td>${editableCell(t, "track")}</td><td>${editableCell(t, "genre")}</td><td>${editableCell(t, "comment")}</td></tr>`,
    )
    .join("");
}
function track(id) {
  return state.tracks.find((t) => t.id === id);
}
function updateNow(t) {
  $("#nowTitle").textContent = t ? "Now Playing" : "Nothing playing";
  $("#nowSub").textContent = t
    ? [t.metadata.artist, t.metadata.album].filter(Boolean).join(" · ") ||
      t.relativePath
    : "Add audio files to begin";
  if ("mediaSession" in navigator && t)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.metadata.title || baseName(t.fileName),
      artist: t.metadata.artist || "",
      album: t.metadata.album || "",
    });
}
function playTrack(id, autoplay = true) {
  const t = track(id);
  if (!t) return;
  if (state.currentId !== id) {
    state.currentId = id;
    audio.src = t.objectUrl;
    audio.load();
    updateNow(t);
    render();
  }
  if (autoplay)
    audio.play().catch((e) => notice(`Playback failed: ${e.message}`, "bad"));
}
function playPause() {
  if (!state.currentId && state.tracks.length) playTrack(state.tracks[0].id);
  else if (audio.paused) audio.play();
  else audio.pause();
}
function nextTrack(direction = 1) {
  if (!state.tracks.length) return;
  let i = state.tracks.findIndex((t) => t.id === state.currentId);
  if (state.shuffle && state.tracks.length > 1) {
    let n;
    do n = Math.floor(Math.random() * state.tracks.length);
    while (n === i);
    i = n;
  } else {
    i = (i + direction + state.tracks.length) % state.tracks.length;
  }
  playTrack(state.tracks[i].id);
}
function stop() {
  audio.pause();
  audio.currentTime = 0;
}
function setDirty(t) {
  t.dirty = true;
  render();
}
async function ensurePermission(handle) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission?.(opts)) === "granted") return true;
  return (await handle.requestPermission?.(opts)) === "granted";
}
function frame(id, content) {
  const h = new Uint8Array(10);
  h.set(latin1Bytes(id, 4));
  new DataView(h.buffer).setUint32(4, content.length, false);
  return concatArrays([h, content]);
}
function utf16leBytes(val) {
  const s = String(val || ""),
    out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  const v = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++)
    v.setUint16(2 + i * 2, s.charCodeAt(i), true);
  return out;
}
function textFrame(id, val) {
  return frame(id, concatArrays([new Uint8Array([1]), utf16leBytes(val)]));
}
function buildMp3(t, buf) {
  const u = new Uint8Array(buf),
    info = t.parseInfo?.mp3 || parseMp3(buf).mp3;
  let body = u.slice(info.audioStart || 0);
  if (
    body.length >= 128 &&
    latin1(body.slice(body.length - 128, body.length - 125)) === "TAG"
  )
    body = body.slice(0, -128);
  const md = t.metadata,
    frames = [];
  if (md.title) frames.push(textFrame("TIT2", md.title));
  if (md.artist) frames.push(textFrame("TPE1", md.artist));
  if (md.album) frames.push(textFrame("TALB", md.album));
  if (md.year) frames.push(textFrame("TYER", md.year));
  if (md.track) frames.push(textFrame("TRCK", md.track));
  if (md.genre) frames.push(textFrame("TCON", md.genre));
  if (md.comment) {
    const c = concatArrays([
      new Uint8Array([1]),
      latin1Bytes("eng", 3),
      new Uint8Array([0, 0]),
      utf16leBytes(md.comment),
    ]);
    frames.push(frame("COMM", c));
  }
  for (const f of info.preserved || []) {
    if (
      ![
        "TIT2",
        "TPE1",
        "TALB",
        "TYER",
        "TDRC",
        "TRCK",
        "TCON",
        "COMM",
      ].includes(f.id)
    )
      frames.push(frame(f.id, f.content));
  }
  const payload = concatArrays([...frames, new Uint8Array(512)]),
    head = new Uint8Array(10);
  head.set(latin1Bytes("ID3", 3));
  head[3] = 3;
  head[4] = 0;
  head.set(intToSynchsafe(payload.length), 6);
  const tag = new Uint8Array(128);
  tag.set(latin1Bytes("TAG", 3));
  tag.set(latin1Bytes(md.title, 30), 3);
  tag.set(latin1Bytes(md.artist, 30), 33);
  tag.set(latin1Bytes(md.album, 30), 63);
  tag.set(latin1Bytes(md.year, 4), 93);
  tag.set(latin1Bytes(md.comment, 28), 97);
  tag[125] = 0;
  tag[126] = Math.max(0, Math.min(255, parseInt(md.track) || 0));
  tag[127] = 255;
  return concatArrays([head, payload, body, tag]);
}
function le32(n) {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n, true);
  return a;
}
function buildFlac(t, buf) {
  const parsed = t.parseInfo?.flac
      ? { flac: t.parseInfo.flac }
      : parseFlac(buf),
    blocks = parsed.flac.blocks.map((b) => ({ type: b.type, data: b.data })),
    md = t.metadata;
  let idx = blocks.findIndex((b) => b.type === 4),
    vendor = "Local Music Player",
    existing = [];
  if (idx >= 0) {
    const d = blocks[idx].data,
      v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let p = 0;
    if (d.length >= 4) {
      const n = v.getUint32(p, true);
      p += 4;
      vendor = new TextDecoder().decode(d.slice(p, p + n)) || vendor;
      p += n;
      if (p + 4 <= d.length) {
        const c = v.getUint32(p, true);
        p += 4;
        for (let i = 0; i < c && p + 4 <= d.length; i++) {
          const n2 = v.getUint32(p, true);
          p += 4;
          existing.push(new TextDecoder().decode(d.slice(p, p + n2)));
          p += n2;
        }
      }
    }
  }
  const replace = new Set([
    "TITLE",
    "ARTIST",
    "ALBUM",
    "DATE",
    "YEAR",
    "TRACKNUMBER",
    "GENRE",
    "COMMENT",
    "DESCRIPTION",
  ]);
  existing = existing.filter(
    (s) => !replace.has(s.slice(0, s.indexOf("=")).toUpperCase()),
  );
  const vals = {
    TITLE: md.title,
    ARTIST: md.artist,
    ALBUM: md.album,
    DATE: md.year,
    TRACKNUMBER: md.track,
    GENRE: md.genre,
    COMMENT: md.comment,
  };
  for (const [k, v] of Object.entries(vals)) if (v) existing.push(`${k}=${v}`);
  const vb = textEncoder.encode(vendor),
    parts = [le32(vb.length), vb, le32(existing.length)];
  for (const s of existing) {
    const b = textEncoder.encode(s);
    parts.push(le32(b.length), b);
  }
  const data = concatArrays(parts);
  if (idx >= 0) blocks[idx] = { type: 4, data };
  else blocks.push({ type: 4, data });
  const out = [latin1Bytes("fLaC", 4)];
  blocks.forEach((b, i) => {
    const h = new Uint8Array(4);
    h[0] = b.type | (i === blocks.length - 1 ? 128 : 0);
    h[1] = (b.data.length >> 16) & 255;
    h[2] = (b.data.length >> 8) & 255;
    h[3] = b.data.length & 255;
    out.push(h, b.data);
  });
  out.push(new Uint8Array(buf).slice(parsed.flac.audioStart));
  return concatArrays(out);
}
function wavChunk(id, data) {
  const h = new Uint8Array(8);
  h.set(latin1Bytes(id, 4));
  new DataView(h.buffer).setUint32(4, data.length, true);
  return concatArrays([
    h,
    data,
    data.length & 1 ? new Uint8Array([0]) : new Uint8Array(0),
  ]);
}
function buildWav(t, buf) {
  const parsed = t.parseInfo?.wav ? { wav: t.parseInfo.wav } : parseWav(buf),
    md = t.metadata,
    infos = {
      INAM: md.title,
      IART: md.artist,
      IPRD: md.album,
      ICRD: md.year,
      ITRK: md.track,
      IGNR: md.genre,
      ICMT: md.comment,
    },
    subs = [];
  for (const [id, val] of Object.entries(infos))
    if (val) {
      const d = concatArrays([latin1Bytes(val), new Uint8Array([0])]);
      subs.push(wavChunk(id, d));
    }
  const listData = concatArrays([latin1Bytes("INFO", 4), ...subs]),
    parts = [];
  for (const c of parsed.wav.chunks) {
    if (c.id === "LIST" && latin1(c.data.slice(0, 4)) === "INFO") continue;
    parts.push(wavChunk(c.id, c.data));
  }
  if (subs.length) parts.push(wavChunk("LIST", listData));
  const payload = concatArrays([latin1Bytes("WAVE", 4), ...parts]),
    head = concatArrays([
      latin1Bytes("RIFF", 4),
      le32(payload.length),
      payload,
    ]);
  return head;
}
async function buildUpdated(t) {
  const buf = await t.file.arrayBuffer();
  const x = ext(t.fileName);
  if (x === "mp3") return buildMp3(t, buf);
  if (x === "flac") return buildFlac(t, buf);
  if (x === "wav" || x === "wave") return buildWav(t, buf);
  throw Error("Unsupported format");
}
async function saveTrack(t) {
  try {
    const previousHandle = t.handle;
    const previousName = t.originalName;
    const previousRelativePath = t.relativePath;
    const bytes = await buildUpdated(t),
      rename = t.fileName !== t.originalName;
    if (rename && ext(t.fileName) !== ext(t.originalName))
      throw Error("Changing the file extension is not supported.");
    let newHandle = t.handle;
    if (rename && t.parentDirHandle) {
      if (!(await ensurePermission(t.parentDirHandle)))
        throw Error("Folder write permission was not granted.");
      try {
        const existing = await t.parentDirHandle.getFileHandle(t.fileName);
        if (
          existing &&
          t.fileName !== t.originalName &&
          !confirm(`${t.fileName} already exists. Overwrite it?`)
        )
          return;
      } catch {}
      newHandle = await t.parentDirHandle.getFileHandle(t.fileName, {
        create: true,
      });
      const w = await newHandle.createWritable();
      await w.write(bytes);
      await w.close();
      await t.parentDirHandle.removeEntry(t.originalName);
      t.handle = newHandle;
      t.originalName = t.fileName;
      t.relativePath = t.relativePath.replace(/[^/]+$/, t.fileName);
      if (t.pathFromRoot)
        t.pathFromRoot = t.pathFromRoot.replace(/[^/]+$/, t.fileName);
    } else if (rename && window.showSaveFilePicker) {
      newHandle = await showSaveFilePicker({
        suggestedName: t.fileName,
        types: [
          {
            description: "Audio file",
            accept: { [mimeFor(t.fileName)]: [`.${ext(t.fileName)}`] },
          },
        ],
      });
      const w = await newHandle.createWritable();
      await w.write(bytes);
      await w.close();
      t.handle = newHandle;
      t.originalName = t.fileName;
      t.relativePath = t.fileName;
    } else if (t.handle && (await ensurePermission(t.handle))) {
      const w = await t.handle.createWritable();
      await w.write(bytes);
      await w.close();
    } else if (window.showSaveFilePicker) {
      newHandle = await showSaveFilePicker({
        suggestedName: t.fileName,
        types: [
          {
            description: "Audio file",
            accept: { [mimeFor(t.fileName)]: [`.${ext(t.fileName)}`] },
          },
        ],
      });
      const w = await newHandle.createWritable();
      await w.write(bytes);
      await w.close();
      t.handle = newHandle;
      t.originalName = t.fileName;
    } else {
      const blob = new Blob([bytes], { type: mimeFor(t.fileName) }),
        a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = t.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    URL.revokeObjectURL(t.objectUrl);
    t.file = new File([bytes], t.fileName, {
      type: mimeFor(t.fileName),
      lastModified: Date.now(),
    });
    t.objectUrl = URL.createObjectURL(t.file);
    t.dirty = false;
    t.error = "";
    if (t.handle && !t.rootDirHandle) {
      t.parentDirHandle = t.parentDirHandle || null;
    }
    if (
      previousHandle !== t.handle ||
      previousName !== t.originalName ||
      previousRelativePath !== t.relativePath
    ) {
      markPlaylistDirty();
    }
    const r = await parseFile(t.file);
    t.parseInfo = r;
    Object.assign(t.technical, r.technical);
    updateActualBitrate(t);
    if (state.currentId === t.id) {
      const pos = audio.currentTime,
        was = !audio.paused;
      audio.src = t.objectUrl;
      audio.currentTime = pos;
      if (was) audio.play();
    }
    render();
    notice(`Saved ${t.fileName}.`, "good");
  } catch (e) {
    t.error = e.message;
    render();
    notice(`Could not save ${t.fileName}: ${e.message}`, "bad");
  }
}
async function saveMany(list) {
  for (const t of list) if (t.dirty) await saveTrack(t);
}
function removeTracks(ids, options = {}) {
  for (const id of ids) {
    const i = state.tracks.findIndex((t) => t.id === id);
    if (i >= 0) {
      if (state.currentId === id) {
        stop();
        audio.removeAttribute("src");
        state.currentId = null;
        updateNow(null);
      }
      URL.revokeObjectURL(state.tracks[i].objectUrl);
      state.tracks.splice(i, 1);
    }
  }
  state.selected.clear();
  if (options.markPlaylistDirty !== false) markPlaylistDirty();
  render();
}
$("#addFiles").onclick = chooseFiles;
$("#addFolder").onclick = chooseFolder;
$("#fallbackFiles").onchange = async (e) => {
  for (const f of e.target.files) await addFile(f);
  e.target.value = "";
};
$("#fallbackFolder").onchange = async (e) => {
  const files = [...e.target.files];
  for (const f of files)
    await addFile(f, null, null, f.webkitRelativePath || f.name);
  e.target.value = "";
  notice(
    `Loaded ${files.filter((f) => AUDIO_EXT.has(ext(f.name))).length} audio file(s) from the selected folder. This fallback is read-only; saving creates a new copy.`,
    "warn",
  );
};
function setDragState(active) {
  document.body.classList.toggle("dragging", active);
}
document.body.addEventListener("dragenter", (e) => {
  e.preventDefault();
  setDragState(true);
});
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  setDragState(true);
});
document.body.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget || !document.body.contains(e.relatedTarget))
    setDragState(false);
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  setDragState(false);
  handleDrop(e);
});
$("#playBtn").onclick = playPause;
$("#prevBtn").onclick = () => nextTrack(-1);
$("#nextBtn").onclick = () => nextTrack(1);
$("#stopBtn").onclick = stop;
$("#shuffleBtn").onclick = () => {
  state.shuffle = !state.shuffle;
  $("#shuffleBtn").classList.toggle("active", state.shuffle);
};
$("#repeatBtn").onclick = () => {
  state.repeat =
    state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  $("#repeatBtn").classList.toggle("active", state.repeat !== "off");
  $("#repeatBtn").title = `Repeat: ${state.repeat}`;
  $("#repeatBtn").textContent = state.repeat === "one" ? "↻¹" : "↻";
};
audio.onplay = () => ($("#playBtn").textContent = "⏸");
audio.onpause = () => ($("#playBtn").textContent = "▶");
audio.ontimeupdate = () => {
  if (!audio.duration) return;
  $("#seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
  $("#currentTime").textContent = formatTime(audio.currentTime);
};
audio.onloadedmetadata = () => {
  $("#duration").textContent = formatTime(audio.duration);
  const t = track(state.currentId);
  if (t) {
    t.technical.duration = audio.duration;
    updateActualBitrate(t);
    render();
  }
};
audio.onended = () => {
  if (state.repeat === "one") {
    audio.currentTime = 0;
    audio.play();
  } else if (
    state.repeat === "all" ||
    state.tracks.findIndex((t) => t.id === state.currentId) <
      state.tracks.length - 1
  )
    nextTrack(1);
};
audio.onerror = () =>
  notice("The browser could not decode this audio file.", "bad");
$("#seek").oninput = (e) => {
  if (audio.duration)
    audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
};
$("#seek").addEventListener("mousemove", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const t = audio.duration ? audio.duration * pct : 0;
  $("#seekHint").textContent = formatTime(t);
  $("#seekHint").style.left = `${pct * 100}%`;
  $("#seekHint").classList.add("show");
});
$("#seek").addEventListener("mouseleave", () =>
  $("#seekHint").classList.remove("show"),
);
$("#seek").addEventListener(
  "touchmove",
  (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(
      0,
      Math.min(1, (e.touches[0].clientX - rect.left) / rect.width),
    );
    const t = audio.duration ? audio.duration * pct : 0;
    $("#seekHint").textContent = formatTime(t);
    $("#seekHint").style.left = `${pct * 100}%`;
    $("#seekHint").classList.add("show");
  },
  { passive: true },
);
$("#volume").oninput = (e) => {
  audio.volume = Number(e.target.value);
  audio.muted = false;
};
audio.volume = 0.85;
$("#muteBtn").onclick = () => {
  audio.muted = !audio.muted;
  $("#muteBtn").textContent = audio.muted ? "🔇" : "🔊";
};
$("#speed").onchange = (e) => (audio.playbackRate = parseFloat(e.target.value));
$("#search").oninput = (e) => {
  state.filter = e.target.value;
  render();
};
$("#playlistTable thead").onclick = (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  state.sortDir = state.sortKey === th.dataset.sort ? -state.sortDir : 1;
  state.sortKey = th.dataset.sort;
  render();
};
const cellPopover = $("#cellPopover");
function hideCellPopover() {
  cellPopover.classList.add("hidden");
}
function showCellPopover(el) {
  const value = el.dataset.full || "";
  if (!value || el.scrollWidth <= el.clientWidth) {
    hideCellPopover();
    return;
  }
  cellPopover.textContent = value;
  cellPopover.classList.remove("hidden");
  const rect = el.getBoundingClientRect();
  const margin = 8;
  const maxLeft = window.innerWidth - cellPopover.offsetWidth - margin;
  const left = Math.max(margin, Math.min(rect.left, maxLeft));
  let top = rect.bottom + 6;
  if (top + cellPopover.offsetHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - cellPopover.offsetHeight - 6);
  }
  cellPopover.style.left = `${left}px`;
  cellPopover.style.top = `${top}px`;
}
function setTrackField(t, group, field, value) {
  if (group === "root") t[field] = value;
  else t[group][field] = value;
  t.dirty = true;
  if (state.currentId === t.id) updateNow(t);
}
function beginCellEdit(el) {
  const t = track(el.dataset.id);
  if (!t) return;
  hideCellPopover();
  const group = el.dataset.group;
  const field = el.dataset.field;
  const value = group === "root" ? t[field] : t[group][field];
  const row = el.closest("tr[data-id]");
  const editor = document.createElement("input");
  editor.type = "text";
  editor.className = `cellEditor ${t.dirty ? "dirty" : ""}`;
  editor.value = value || "";
  editor.dataset.id = t.id;
  editor.dataset.group = group;
  editor.dataset.field = field;
  editor.dataset.originalValue = value || "";
  editor.dataset.wasDirty = String(t.dirty);
  row.draggable = false;
  row.dataset.editing = "true";
  el.replaceWith(editor);
  editor.focus();
  editor.select();
}
function finishCellEdit(editor, cancel = false) {
  if (editor.dataset.finished === "true") return;
  editor.dataset.finished = "true";
  const t = track(editor.dataset.id);
  if (!t) return;
  const row = editor.closest("tr[data-id]");
  if (cancel) {
    const originalValue = editor.dataset.originalValue || "";
    if (editor.dataset.group === "root")
      t[editor.dataset.field] = originalValue;
    else t[editor.dataset.group][editor.dataset.field] = originalValue;
    t.dirty = editor.dataset.wasDirty === "true";
    if (state.currentId === t.id) updateNow(t);
  }
  const template = document.createElement("template");
  template.innerHTML = editableCell(
    t,
    editor.dataset.field,
    editor.dataset.group,
  ).trim();
  editor.replaceWith(template.content.firstElementChild);
  if (row) {
    row.draggable = true;
    delete row.dataset.editing;
  }
}
$("#playlistBody").oninput = (e) => {
  const editor = e.target.closest(".cellEditor");
  if (!editor) return;
  const t = track(editor.dataset.id);
  if (!t) return;
  setTrackField(t, editor.dataset.group, editor.dataset.field, editor.value);
  editor.classList.add("dirty");
};
$("#playlistBody").addEventListener("focusout", (e) => {
  const editor = e.target.closest(".cellEditor");
  if (editor) finishCellEdit(editor);
});
$("#playlistBody").addEventListener("keydown", (e) => {
  const editor = e.target.closest(".cellEditor");
  if (editor) {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishCellEdit(editor, true);
    }
    return;
  }
  const value = e.target.closest(".editableValue");
  if (value && e.key === "Enter") {
    e.preventDefault();
    beginCellEdit(value);
  }
});
$("#playlistBody").addEventListener("mouseover", (e) => {
  const value = e.target.closest(".editableValue");
  if (value) showCellPopover(value);
});
$("#playlistBody").addEventListener("mouseout", (e) => {
  if (e.target.closest(".editableValue")) hideCellPopover();
});
$(".playlistScroll").addEventListener("scroll", hideCellPopover);
window.addEventListener("resize", hideCellPopover);
$("#playlistBody").onchange = (e) => {
  if (e.target.dataset.select) {
    e.target.checked
      ? state.selected.add(e.target.dataset.select)
      : state.selected.delete(e.target.dataset.select);
    render();
  }
};
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      if (!document.execCommand("copy")) throw Error("Copy unavailable");
      el.remove();
    }
    notice("Relative location copied.", "good");
  } catch {
    notice(`Location: ${text}`, "warn");
  }
}
$("#playlistBody").onclick = (e) => {
  const editable = e.target.closest(".editableValue");
  if (editable) {
    beginCellEdit(editable);
    return;
  }
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const t = track(btn.dataset.id);
  if (!t) return;
  if (btn.dataset.action === "play") playTrack(t.id);
  if (btn.dataset.action === "save") saveTrack(t);
};
$("#playlistBody").ondragstart = (e) => {
  if (
    e.target.closest(
      'input, button, select, textarea, [contenteditable="true"]',
    )
  ) {
    e.preventDefault();
    return;
  }
  const tr = e.target.closest("tr[data-id]");
  if (tr && tr.dataset.editing !== "true") {
    state.dragId = tr.dataset.id;
    e.dataTransfer.effectAllowed = "move";
  }
};
$("#playlistBody").ondragend = () => {
  state.dragId = null;
  document
    .querySelectorAll(".dragTarget")
    .forEach((x) => x.classList.remove("dragTarget"));
};
$("#playlistBody").ondragover = (e) => {
  e.preventDefault();
  const tr = e.target.closest("tr[data-id]");
  document
    .querySelectorAll(".dragTarget")
    .forEach((x) => x.classList.remove("dragTarget"));
  tr?.classList.add("dragTarget");
};
$("#playlistBody").ondrop = (e) => {
  e.preventDefault();
  const target = e.target.closest("tr[data-id]")?.dataset.id;
  if (!state.dragId || !target || state.dragId === target) return;
  const from = state.tracks.findIndex((t) => t.id === state.dragId),
    to = state.tracks.findIndex((t) => t.id === target),
    [m] = state.tracks.splice(from, 1);
  state.tracks.splice(to, 0, m);
  state.sortKey = null;
  state.dragId = null;
  markPlaylistDirty();
  render();
};
$("#saveSelected").onclick = () =>
  saveMany(state.tracks.filter((t) => state.selected.has(t.id)));
$("#saveAll").onclick = () => saveMany(state.tracks);
$("#removeSelected").onclick = () =>
  state.selected.size &&
  confirm(
    `Remove ${state.selected.size} selected track(s) from the playlist?`,
  ) &&
  removeTracks([...state.selected]);
$("#clearAll").onclick = () => {
  if (!state.tracks.length && !state.unavailableEntries.length) return;
  if (
    !confirm(
      "Clear the entire playlist? Unsaved metadata edits and unavailable saved references will be lost.",
    )
  ) {
    return;
  }
  state.unavailableEntries = [];
  state.unavailableRoots = [];
  removeTracks(state.tracks.map((t) => t.id));
};
$("#playlistSelect").onchange = (e) => {
  const id = e.target.value;
  if (id) openPlaylistRecord(id);
};
$("#newPlaylist").onclick = createNewPlaylist;
$("#savePlaylist").onclick = () => savePlaylistRecord();
$("#savePlaylistAs").onclick = () => savePlaylistRecord({ saveAs: true });
$("#renamePlaylist").onclick = renameCurrentPlaylist;
$("#deletePlaylist").onclick = deleteCurrentPlaylist;
$("#helpBtn").onclick = () => $("#helpDialog").showModal();
$("#closeHelp").onclick = () => $("#helpDialog").close();
document.addEventListener("keydown", (e) => {
  // Ignore keyboard shortcuts while typing or editing,
  // but allow them when a range slider has focus.
  const isEditing =
    e.target.matches('input:not([type="range"]), select, textarea') ||
    e.target.isContentEditable;

  if (isEditing) return;

  if (e.code === "Space") {
    e.preventDefault();
    playPause();
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    audio.currentTime = Math.min(
      audio.duration || Infinity,
      audio.currentTime + 5,
    );
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (e.code === "ArrowUp") {
    e.preventDefault();
    audio.volume = Math.min(1, audio.volume + 0.05);
    $("#volume").value = audio.volume;
  } else if (e.code === "ArrowDown") {
    e.preventDefault();
    audio.volume = Math.max(0, audio.volume - 0.05);
    $("#volume").value = audio.volume;
  }
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => nextTrack(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(1));
}
window.addEventListener("beforeunload", (e) => {
  if (state.playlistDirty || state.tracks.some((t) => t.dirty)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function initializePwaAndPlaylists() {
  try {
    await refreshPlaylistSelect();
  } catch (error) {
    notice(`Playlist storage could not be opened: ${error.message}`, "bad");
  } finally {
    updatePlaylistState();
  }
  if (navigator.storage?.persist) {
    try {
      await navigator.storage.persist();
    } catch {}
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try {
      await navigator.serviceWorker.register("./service-worker.js");
    } catch (error) {
      console.warn("Service worker registration failed:", error);
    }
  }
  if (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone
  ) {
    $("#installBtn").classList.add("hidden");
  }
  if (location.protocol === "file:") {
    notice(
      "Standalone file mode is available for playback, but PWA installation, reliable file handles and saved-playlist restoration require HTTPS or localhost.",
      "warn",
    );
  } else if (!window.showOpenFilePicker) {
    notice(
      "Playback and IndexedDB are ready, but reusable file handles require a compatible desktop Chrome or Edge browser.",
      "warn",
    );
  } else {
    notice(
      "Ready. Add files or a folder, then use Save playlist to keep its file references in IndexedDB.",
      "good",
    );
  }
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  $("#installBtn").classList.remove("hidden");
});
$("#installBtn").onclick = async () => {
  if (!state.installPrompt) {
    notice("Use the browser menu and choose Install Music Player.", "warn");
    return;
  }
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  $("#installBtn").classList.add("hidden");
};
window.addEventListener("appinstalled", () => {
  state.installPrompt = null;
  $("#installBtn").classList.add("hidden");
  notice(
    "Music Player was installed. Windows can now offer it for MP3, WAV and FLAC files.",
    "good",
  );
});
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    const handles = launchParams.files || [];
    if (!handles.length) return;
    const firstNewIndex = state.tracks.length;
    for (const handle of handles) {
      if (handle.kind !== "file") continue;
      try {
        const file = await handle.getFile();
        await addFile(file, handle, null, file.name);
      } catch (error) {
        notice(`Could not open a launched file: ${error.message}`, "bad");
      }
    }
    const first = state.tracks[firstNewIndex];
    if (first) playTrack(first.id);
    notice(
      `Opened ${handles.length} file${handles.length === 1 ? "" : "s"} from Windows.`,
      "good",
    );
  });
}
initializePwaAndPlaylists();
