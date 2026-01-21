/**
 * TunesReloaded - Web-based iPod Manager
 * Main JavaScript file for UI logic and WASM integration
 */

// ============================================================================
// Global State
// ============================================================================

let ipodHandle = null;
let isConnected = false;
let allTracks = [];
let allPlaylists = [];
let currentPlaylistIndex = -1;  // -1 means "All Tracks"
let logEntries = [];
let wasmReady = false;
let Module = null;

// ============================================================================
// Logging
// ============================================================================

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, message, type };
    logEntries.push(entry);

    const logContent = document.getElementById('logContent');
    const logCount = document.getElementById('logCount');

    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerHTML = `<span class="log-timestamp">[${timestamp}]</span>${escapeHtml(message)}`;
    logContent.appendChild(div);
    logContent.scrollTop = logContent.scrollHeight;

    logCount.textContent = `(${logEntries.length})`;

    const consoleFn = type === 'error' ? console.error : type === 'warning' ? console.warn : console.log;
    consoleFn(`[TunesReloaded] ${message}`);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function toggleLogPanel() {
    const panel = document.getElementById('logPanel');
    const toggle = document.getElementById('logToggle');
    panel.classList.toggle('collapsed');
    panel.classList.toggle('expanded');
    toggle.textContent = panel.classList.contains('expanded') ? '▼' : '▲';
}

// ============================================================================
// WASM Interface - Core Functions
// ============================================================================

async function initWasm() {
    log('Loading WASM module...');
    try {
        Module = await createIPodModule({
            print: (text) => log(text, 'info'),
            printErr: (text) => log(text, 'error'),
        });
        wasmReady = true;
        log('WASM module initialized', 'success');
        enableUIIfReady();
    } catch (e) {
        log(`Failed to load WASM: ${e.message}`, 'error');
    }
}

function wasmCall(funcName, ...args) {
    if (!wasmReady) {
        log(`WASM not ready, cannot call ${funcName}`, 'error');
        return null;
    }
    try {
        const func = Module[`_${funcName}`];
        if (!func) {
            log(`WASM function not found: ${funcName}`, 'error');
            return null;
        }
        return func(...args);
    } catch (e) {
        log(`WASM call error (${funcName}): ${e.message}`, 'error');
        return null;
    }
}

function wasmGetString(ptr) {
    return ptr ? Module.UTF8ToString(ptr) : null;
}

function wasmAllocString(str) {
    const len = Module.lengthBytesUTF8(str) + 1;
    const ptr = Module._malloc(len);
    Module.stringToUTF8(str, ptr, len);
    return ptr;
}

function wasmFreeString(ptr) {
    if (ptr) Module._free(ptr);
}

/**
 * Add a track via a typed call so strings are marshaled at the correct positions.
 * Returns trackId (>=0) on success, <0 on error.
 */
function wasmAddTrack({
    title,
    artist,
    album,
    genre,
    trackNr = 0,
    cdNr = 0,
    year = 0,
    durationMs,
    bitrateKbps,
    samplerateHz,
    sizeBytes,
    filetype,
}) {
    if (!wasmReady || !Module?.ccall) return -1;

    const safeTitle = title || '';
    const safeArtist = artist || 'Unknown Artist';
    const safeAlbum = album || 'Unknown Album';
    const safeGenre = genre || '';
    const safeFiletype = filetype || 'MPEG audio file';

    const safeTrackNr = Number.isFinite(trackNr) ? trackNr : 0;
    const safeCdNr = Number.isFinite(cdNr) ? cdNr : 0;
    const safeYear = Number.isFinite(year) ? year : 0;
    const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 180000;
    const safeBitrate = Number.isFinite(bitrateKbps) && bitrateKbps > 0 ? bitrateKbps : 128;
    const safeSamplerate = Number.isFinite(samplerateHz) && samplerateHz > 0 ? samplerateHz : 44100;
    const safeSize = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;

    return Module.ccall(
        'ipod_add_track',
        'number',
        ['string','string','string','string','number','number','number','number','number','number','number','string'],
        [safeTitle, safeArtist, safeAlbum, safeGenre, safeTrackNr, safeCdNr, safeYear, safeDurationMs, safeBitrate, safeSamplerate, safeSize, safeFiletype]
    );
}

// ============================================================================
// WASM Interface - Helper Functions (DRY)
// ============================================================================

/**
 * Call WASM function with string parameters, automatically managing memory
 * @param {string} funcName - WASM function name (without _ prefix)
 * @param {Array} stringArgs - Array of string arguments
 * @param {Array} otherArgs - Array of non-string arguments
 * @returns {*} Function result
 */
function wasmCallWithStrings(funcName, stringArgs = [], otherArgs = []) {
    const stringPtrs = stringArgs.map(wasmAllocString);
    try {
        return wasmCall(funcName, ...stringPtrs, ...otherArgs);
    } finally {
        stringPtrs.forEach(wasmFreeString);
    }
}

/**
 * Get JSON from WASM function and parse it
 * @param {string} funcName - WASM function name
 * @param {...*} args - Arguments to pass to WASM function
 * @returns {Object|Array|null} Parsed JSON or null on error
 */
function wasmGetJson(funcName, ...args) {
    const jsonPtr = wasmCall(funcName, ...args);
    if (!jsonPtr) return null;
    
    const jsonStr = wasmGetString(jsonPtr);
    wasmCall('ipod_free_string', jsonPtr);
    
    if (!jsonStr) return null;
    
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        log(`Failed to parse JSON from ${funcName}: ${e.message}`, 'error');
        return null;
    }
}

/**
 * Call WASM function and handle errors
 * @param {string} funcName - WASM function name
 * @param {...*} args - Arguments
 * @returns {number} Result code (0 = success, <0 = error)
 */
function wasmCallWithError(funcName, ...args) {
    const result = wasmCall(funcName, ...args);
    if (result !== 0 && result !== null) {
        const errorPtr = wasmCall('ipod_get_last_error');
        const error = wasmGetString(errorPtr);
        log(`WASM error (${funcName}): ${error || 'Unknown error'}`, 'error');
    }
    return result;
}

// ============================================================================
// File System Operations
// ============================================================================

const MOUNTPOINT = '/iPod';

async function selectIpodFolder() {
    try {
        log('Opening folder picker...');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        ipodHandle = handle;
        log(`Selected folder: ${handle.name}`, 'success');

        const isValid = await verifyIpodStructure(handle);
        if (!isValid) {
            log('Warning: This folder may not be an iPod. Looking for iPod_Control folder...', 'warning');
        }

        await setupWasmFilesystem(handle);
        await parseDatabase();
    } catch (e) {
        if (e.name === 'AbortError') {
            log('Folder selection cancelled', 'warning');
        } else {
            log(`Error selecting folder: ${e.message}`, 'error');
        }
    }
}

async function verifyIpodStructure(handle) {
    try {
        const controlDir = await handle.getDirectoryHandle('iPod_Control', { create: false });
        const itunesDir = await controlDir.getDirectoryHandle('iTunes', { create: false });
        await itunesDir.getFileHandle('iTunesDB', { create: false });
        log('Found iPod_Control directory', 'success');
        return true;
    } catch (e) {
        return false;
    }
}

async function setupWasmFilesystem(handle) {
    log('Setting up virtual filesystem for WASM...');

    // Create mountpoint
    try { Module.FS.mkdir(MOUNTPOINT); } catch (e) {}

    // Set mountpoint in WASM
    wasmCallWithStrings('ipod_set_mountpoint', [MOUNTPOINT]);

    // Create directory structure
    const dirs = [
        `${MOUNTPOINT}/iPod_Control`,
        `${MOUNTPOINT}/iPod_Control/iTunes`,
        `${MOUNTPOINT}/iPod_Control/Device`,
        `${MOUNTPOINT}/iPod_Control/Music`
    ];
    dirs.forEach(dir => { try { Module.FS.mkdir(dir); } catch (e) {} });

    // Create Music subfolders F00-F49
    for (let i = 0; i < 50; i++) {
        const folder = `F${String(i).padStart(2, '0')}`;
        try { Module.FS.mkdir(`${MOUNTPOINT}/iPod_Control/Music/${folder}`); } catch (e) {}
    }

    await syncIpodToVirtualFS(handle);
    log('Virtual filesystem ready', 'success');
}

async function syncIpodToVirtualFS(handle) {
    log('Syncing iPod files to virtual filesystem...');

    try {
        const iPodControlHandle = await handle.getDirectoryHandle('iPod_Control');
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes');
        
        // Copy iTunesDB
        const dbFileHandle = await iTunesHandle.getFileHandle('iTunesDB');
        const dbFile = await dbFileHandle.getFile();
        const dbData = new Uint8Array(await dbFile.arrayBuffer());
        Module.FS.writeFile(`${MOUNTPOINT}/iPod_Control/iTunes/iTunesDB`, dbData);
        log(`Synced: iTunesDB (${dbData.length} bytes)`, 'info');

        // Copy SysInfo and SysInfoExtended
        try {
            const deviceHandle = await iPodControlHandle.getDirectoryHandle('Device');
            await copyDeviceFile(deviceHandle, 'SysInfo');
            await copyDeviceFile(deviceHandle, 'SysInfoExtended');
        } catch (e) {
            log(`Device directory error: ${e.message}`, 'warning');
        }

        log('File sync complete', 'success');
    } catch (e) {
        log(`Error syncing files: ${e.message}`, 'error');
        throw e;
    }
}

async function copyDeviceFile(deviceHandle, filename) {
    try {
        const fileHandle = await deviceHandle.getFileHandle(filename);
        const file = await fileHandle.getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        Module.FS.writeFile(`${MOUNTPOINT}/iPod_Control/Device/${filename}`, data);
        log(`Synced: ${filename} (${data.length} bytes)`, 'info');
    } catch (e) {
        if (filename === 'SysInfo') {
            log(`SysInfo file not found: ${e.message}`, 'warning');
        }
    }
}

// ============================================================================
// Database Operations
// ============================================================================

async function parseDatabase() {
    log('Parsing iTunesDB...');
    const result = wasmCallWithError('ipod_parse_db');
    if (result !== 0) return;

    isConnected = true;
    updateConnectionStatus(true);
    enableUIIfReady();

    await loadTracks();
    await loadPlaylists();
    log('Database loaded successfully', 'success');
}

async function loadTracks() {
    log('Loading tracks...');
    const tracks = wasmGetJson('ipod_get_all_tracks_json');
    if (tracks) {
        allTracks = tracks;
        log(`Loaded ${tracks.length} tracks`, 'success');
        renderTracks(tracks);
    }
}

async function loadPlaylists() {
    log('Loading playlists...');
    const playlists = wasmGetJson('ipod_get_all_playlists_json');
    if (playlists) {
        allPlaylists = playlists;
        log(`Loaded ${playlists.length} playlists`, 'success');
        renderPlaylists(playlists);
    }
}

async function loadPlaylistTracks(index) {
    if (index < 0 || index >= allPlaylists.length) {
        log(`Invalid playlist index: ${index}`, 'error');
        return;
    }
    
    const playlistName = allPlaylists[index].name;
    log(`Loading tracks for playlist: "${playlistName}"`, 'info');
    
    const tracks = wasmGetJson('ipod_get_playlist_tracks_json', index);
    if (tracks) {
        log(`Loaded ${tracks.length} tracks for playlist "${playlistName}"`, 'info');
        renderTracks(tracks);
    }
}

async function saveDatabase() {
    log('Saving database...');
    const result = wasmCallWithError('ipod_write_db');
    if (result !== 0) return;

    await syncVirtualFSToIpod();
    await refreshCurrentView();
    log('Database saved successfully', 'success');
}

// ============================================================================
// UI Refresh Helpers (DRY)
// ============================================================================

async function refreshCurrentView() {
    await loadPlaylists();
    if (currentPlaylistIndex === -1) {
        await loadTracks();
    } else if (currentPlaylistIndex >= 0 && currentPlaylistIndex < allPlaylists.length) {
        await loadPlaylistTracks(currentPlaylistIndex);
    } else {
        currentPlaylistIndex = -1;
        await loadTracks();
    }
}

async function refreshTracks() {
    const savedPlaylistIndex = currentPlaylistIndex;
    await loadPlaylists();
    currentPlaylistIndex = savedPlaylistIndex;
    await refreshCurrentView();
    log('Refreshed track list', 'info');
}

// ============================================================================
// File Sync Operations
// ============================================================================

async function syncVirtualFSToIpod() {
    if (!ipodHandle) return;
    log('Syncing changes to iPod...');

    try {
        await syncVirtualFileToReal(`${MOUNTPOINT}/iPod_Control/iTunes/iTunesDB`,
            ['iPod_Control', 'iTunes'], 'iTunesDB');
        await syncVirtualFileToReal(`${MOUNTPOINT}/iPod_Control/iTunes/iTunesSD`,
            ['iPod_Control', 'iTunes'], 'iTunesSD', true);
        await syncMusicFilesToReal();
        log('Sync complete', 'success');
    } catch (e) {
        log(`Sync error: ${e.message || e.toString() || 'Unknown error'}`, 'error');
    }
}

async function syncMusicFilesToReal() {
    if (!ipodHandle) return;

    try {
        const vfsMusicPath = `${MOUNTPOINT}/iPod_Control/Music`;
        let folders;
        try {
            folders = Module.FS.readdir(vfsMusicPath).filter(f => f.match(/^F\d{2}$/i));
        } catch (e) {
            return;
        }

        if (folders.length === 0) return;

        const iPodControlHandle = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const musicHandle = await iPodControlHandle.getDirectoryHandle('Music', { create: true });

        for (const folder of folders) {
            const folderPath = `${vfsMusicPath}/${folder}`;
            let files;
            try {
                files = Module.FS.readdir(folderPath).filter(f => 
                    /\.(mp3|m4a|aac|wav|aiff)$/i.test(f)
                );
            } catch (e) {
                continue;
            }

            if (files.length === 0) continue;

            const realFolderHandle = await musicHandle.getDirectoryHandle(folder, { create: true });

            for (const file of files) {
                const filePath = `${folderPath}/${file}`;
                try {
                    try {
                        await realFolderHandle.getFileHandle(file);
                        continue; // File already exists
                    } catch (e) {}

                    const fileData = Module.FS.readFile(filePath);
                    const fileHandle = await realFolderHandle.getFileHandle(file, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(fileData);
                    await writable.close();
                    log(`Synced music file: ${folder}/${file}`, 'info');
                } catch (e) {
                    log(`Could not sync ${folder}/${file}: ${e.message}`, 'warning');
                }
            }
        }
    } catch (e) {
        log(`Error syncing music files: ${e.message}`, 'warning');
    }
}

async function syncVirtualFileToReal(virtualPath, dirPath, fileName, optional = false) {
    try {
        try {
            Module.FS.stat(virtualPath);
        } catch (e) {
            if (!optional) {
                log(`File not found in virtual FS: ${virtualPath}`, 'warning');
            }
            return;
        }

        const data = Module.FS.readFile(virtualPath);
        let currentDir = ipodHandle;
        for (const dir of dirPath) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
        }

        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
        log(`Synced ${fileName} to iPod`, 'info');
    } catch (e) {
        if (!optional) {
            log(`Failed to sync ${fileName}: ${e.message}`, 'warning');
        }
    }
}

// ============================================================================
// Track Upload
// ============================================================================

async function uploadTracks() {
    try {
        const fileHandles = await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: 'Audio Files',
                accept: { 'audio/*': ['.mp3', '.m4a', '.aac', '.wav', '.aiff'] }
            }]
        });

        if (fileHandles.length === 0) return;
        log(`Selected ${fileHandles.length} files for upload`, 'info');

        document.getElementById('uploadModal').classList.add('show');

        for (let i = 0; i < fileHandles.length; i++) {
            const file = await fileHandles[i].getFile();
            updateUploadProgress(i + 1, fileHandles.length, file.name);
            await uploadSingleTrack(file);
        }

        document.getElementById('uploadModal').classList.remove('show');
        await refreshCurrentView();
        log(`Upload complete: ${fileHandles.length} tracks`, 'success');
    } catch (e) {
        document.getElementById('uploadModal').classList.remove('show');
        if (e.name !== 'AbortError') {
            log(`Upload error: ${e.message}`, 'error');
        }
    }
}

async function uploadSingleTrack(file) {
    log(`Uploading: ${file.name}`);

    const tags = await readAudioTags(file);
    const audioProps = await getAudioProperties(file);
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    const filetype = getFiletypeFromName(file.name);

    // Add track to database
    const trackId = wasmAddTrack({
        title: tags.title || file.name.replace(/\.[^/.]+$/, ''),
        artist: tags.artist,
        album: tags.album,
        genre: tags.genre,
        trackNr: tags.track || 0,
        cdNr: 0,
        year: tags.year || 0,
        durationMs: audioProps.duration,
        bitrateKbps: audioProps.bitrate,
        samplerateHz: audioProps.samplerate,
        sizeBytes: data.length,
        filetype,
    });

    if (trackId < 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    // Get destination path
    const destPathPtr = wasmCallWithStrings('ipod_get_track_dest_path', [file.name]);
    if (!destPathPtr) {
        log('Failed to get destination path', 'error');
        return;
    }

    const destPath = wasmGetString(destPathPtr);
    wasmCall('ipod_free_string', destPathPtr);

    // Write to virtual FS
    await copyFileToVirtualFS(data, destPath);

    // Finalize track
    const finalizePathPtr = wasmAllocString(destPath);
    const result = wasmCallWithError('ipod_track_finalize', trackId, finalizePathPtr);
    wasmFreeString(finalizePathPtr);

    if (result !== 0) {
        // Fallback: manual path setting
        const ipodPath = destPath.replace(/^\/iPod\//, '').replace(/\//g, ':');
        wasmCallWithStrings('ipod_track_set_path', [ipodPath], [trackId]);
    }

    // Add to current playlist if one is selected
    if (currentPlaylistIndex >= 0 && currentPlaylistIndex < allPlaylists.length) {
        const addResult = wasmCall('ipod_playlist_add_track', currentPlaylistIndex, trackId);
        if (addResult === 0) {
            log(`Added track to playlist: ${allPlaylists[currentPlaylistIndex].name}`, 'info');
        }
    }

    log(`Finalized: ${tags.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
}

function getFiletypeFromName(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'AAC audio file';
    if (lower.endsWith('.wav')) return 'WAV audio file';
    if (lower.endsWith('.aiff') || lower.endsWith('.aif')) return 'AIFF audio file';
    return 'MPEG audio file';
}

async function copyFileToVirtualFS(data, virtualPath) {
    try {
        const parts = virtualPath.split('/').filter(p => p);
        let dirPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            dirPath += '/' + parts[i];
            try { Module.FS.mkdir(dirPath); } catch (e) {}
        }
        Module.FS.writeFile(virtualPath, data);
    } catch (e) {
        log(`Virtual FS write warning: ${e.message}`, 'warning');
    }
}

function readAudioTags(file) {
    return new Promise((resolve) => {
        if (typeof jsmediatags === 'undefined') {
            resolve({
                title: file.name.replace(/\.[^/.]+$/, ''),
                artist: 'Unknown Artist',
                album: 'Unknown Album',
                genre: '',
                track: 0,
                year: 0,
            });
            return;
        }

        jsmediatags.read(file, {
            onSuccess: (tag) => {
                const tags = tag.tags;
                resolve({
                    title: tags.title || file.name.replace(/\.[^/.]+$/, ''),
                    artist: tags.artist || 'Unknown Artist',
                    album: tags.album || 'Unknown Album',
                    genre: tags.genre || '',
                    track: tags.track ? parseInt(tags.track) : 0,
                    year: tags.year ? parseInt(tags.year) : 0,
                });
            },
            onError: () => {
                const title = file.name.replace(/\.[^/.]+$/, '');
                const match = title.match(/^(.+?)\s*-\s*(.+)$/);
                resolve({
                    title: match ? match[2].trim() : title,
                    artist: match ? match[1].trim() : 'Unknown Artist',
                    album: 'Unknown Album',
                    genre: '',
                    track: 0,
                    year: 0,
                });
            }
        });
    });
}

async function getAudioProperties(file) {
    // IMPORTANT: Never return NaN/Infinity here.
    // Emscripten will coerce NaN/Infinity to 0 for int args, which produces 0:00 durations on-device.
    const DEFAULT = { duration: 180000, bitrate: 192, samplerate: 44100 }; // 3:00 fallback

    // Fast path: HTMLAudioElement metadata (sometimes reports Infinity for some MP3s)
    const meta = await new Promise((resolve) => {
        const audio = new Audio();
        audio.preload = 'metadata';

        const cleanup = () => {
            try { if (audio.src) URL.revokeObjectURL(audio.src); } catch (_) {}
            audio.removeAttribute('src');
            try { audio.load(); } catch (_) {}
        };

        audio.onloadedmetadata = () => {
            const durationSec = audio.duration;
            cleanup();
            resolve({ durationSec });
        };

        audio.onerror = () => {
            cleanup();
            resolve({ durationSec: null });
        };

        audio.src = URL.createObjectURL(file);
    });

    let durationSec = meta.durationSec;

    // Robust fallback: decode to get a real duration when metadata is missing/Infinity/NaN/0.
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        try {
            const buf = await file.arrayBuffer();
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                const ctx = new Ctx();
                const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
                durationSec = audioBuffer?.duration;
                try { await ctx.close(); } catch (_) {}
            }
        } catch (_) {
            // ignore; we'll fall back below
        }
    }

    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return DEFAULT;
    }

    const duration = Math.max(1, Math.floor(durationSec * 1000)); // ms; clamp to non-zero
    const bitrate = Math.floor((file.size * 8) / durationSec / 1000);
    return { duration, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 128, samplerate: 44100 };
}

function updateUploadProgress(current, total, filename) {
    const percent = Math.round((current / total) * 100);
    document.getElementById('uploadProgress').style.width = `${percent}%`;
    document.getElementById('uploadStatus').textContent = `Uploading ${current} of ${total}`;
    document.getElementById('uploadDetail').textContent = filename;
}

// ============================================================================
// Drag and Drop
// ============================================================================

const dropZone = document.getElementById('dropZone');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');

    if (!isConnected) {
        log('Please connect an iPod first', 'warning');
        return;
    }

    const files = Array.from(e.dataTransfer.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter(file => file && isAudioFile(file.name));

    if (files.length === 0) {
        log('No audio files found in drop', 'warning');
        return;
    }

    log(`Dropped ${files.length} files`, 'info');
    document.getElementById('uploadModal').classList.add('show');

    for (let i = 0; i < files.length; i++) {
        updateUploadProgress(i + 1, files.length, files[i].name);
        await uploadSingleTrack(files[i]);
    }

    document.getElementById('uploadModal').classList.remove('show');
    await refreshCurrentView();
});

function isAudioFile(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    return ['mp3', 'm4a', 'aac', 'wav', 'aiff'].includes(ext);
}

// ============================================================================
// UI Rendering
// ============================================================================

function renderTracks(tracks) {
    const tbody = document.getElementById('trackTableBody');
    const table = document.getElementById('trackTable');
    const emptyState = document.getElementById('emptyState');

    if (tracks.length === 0) {
        table.style.display = 'none';
        emptyState.style.display = 'flex';
        emptyState.innerHTML = `
            <div class="icon">🎵</div>
            <h2>No Tracks</h2>
            <p>Upload some music to get started</p>
        `;
        return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    tbody.innerHTML = tracks.map((track, index) => `
        <tr data-id="${track.id}" data-track-id="${track.id}">
            <td>${index + 1}</td>
            <td class="title">${escapeHtml(track.title || 'Unknown')}</td>
            <td>${escapeHtml(track.artist || 'Unknown')}</td>
            <td>${escapeHtml(track.album || 'Unknown')}</td>
            <td>${escapeHtml(track.genre || '')}</td>
            <td class="duration">${formatDuration(track.tracklen)}</td>
            <td>
                <button class="btn btn-secondary" onclick="deleteTrack(${track.id})" style="padding: 5px 10px; font-size: 0.8rem;">
                    🗑️
                </button>
            </td>
        </tr>
    `).join('');
    
    // Attach context menu handlers to track rows
    attachTrackContextMenus();
}

function renderPlaylists(playlists) {
    const list = document.getElementById('playlistList');

    let html = `
        <li class="playlist-item ${currentPlaylistIndex === -1 ? 'active' : ''}"
            onclick="selectPlaylist(-1)">
            <span>📚 All Tracks</span>
            <span class="track-count">${allTracks.length}</span>
        </li>
    `;

    // playlists is the canonical list from WASM; its indices are the indices we must use.
    html += playlists
        .map((pl, idx) => {
            if (pl.is_master) return '';
            const icon = pl.is_podcast ? '🎙️' : pl.is_smart ? '⚡' : '📁';
            return `
                <li class="playlist-item ${currentPlaylistIndex === idx ? 'active' : ''}"
                    data-playlist-index="${idx}"
                    onclick="selectPlaylist(${idx})">
                    <span>${icon} ${escapeHtml(pl.name)}</span>
                    <span class="track-count">${pl.track_count}</span>
                </li>
            `;
        })
        .join('');

    list.innerHTML = html;
    
    // Attach context menu handlers to playlist items
    attachPlaylistContextMenus();
}

function selectPlaylist(index) {
    currentPlaylistIndex = index;
    renderPlaylists(allPlaylists);

    if (index === -1) {
        renderTracks(allTracks);
    } else {
        loadPlaylistTracks(index);
    }
}

function formatDuration(ms) {
    if (!ms) return '--:--';
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function filterTracks() {
    const query = document.getElementById('searchBox').value.toLowerCase();

    if (!query) {
        if (currentPlaylistIndex === -1) {
            renderTracks(allTracks);
        } else {
            loadPlaylistTracks(currentPlaylistIndex);
        }
        return;
    }

    const filtered = allTracks.filter(track =>
        (track.title && track.title.toLowerCase().includes(query)) ||
        (track.artist && track.artist.toLowerCase().includes(query)) ||
        (track.album && track.album.toLowerCase().includes(query))
    );

    renderTracks(filtered);
}

// ============================================================================
// Playlist Management
// ============================================================================

function showNewPlaylistModal() {
    document.getElementById('newPlaylistModal').classList.add('show');
    document.getElementById('playlistName').value = '';
    document.getElementById('playlistName').focus();
}

function hideNewPlaylistModal() {
    document.getElementById('newPlaylistModal').classList.remove('show');
}

function createPlaylist() {
    const name = document.getElementById('playlistName').value.trim();
    if (!name) {
        log('Playlist name cannot be empty', 'warning');
        return;
    }

    const result = wasmCallWithStrings('ipod_create_playlist', [name]);
    if (result < 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to create playlist: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    hideNewPlaylistModal();
    loadPlaylists();
    log(`Created playlist: ${name}`, 'success');
}

/**
 * Delete a playlist by index
 * Cannot delete the master playlist
 */
async function deletePlaylist(playlistIndex) {
    if (playlistIndex < 0 || playlistIndex >= allPlaylists.length) {
        log('Invalid playlist index', 'error');
        return;
    }

    const playlist = allPlaylists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot delete master playlist', 'warning');
        return;
    }

    if (!confirm(`Are you sure you want to delete "${playlist.name}"?`)) return;

    const result = wasmCallWithError('ipod_delete_playlist', playlistIndex);
    if (result !== 0) return;

    log(`Deleted playlist: ${playlist.name}`, 'success');
    
    // If we were viewing the deleted playlist, switch to All Tracks
    if (currentPlaylistIndex === playlistIndex) {
        currentPlaylistIndex = -1;
    }
    
    await loadPlaylists();
    await refreshCurrentView();
}

// ============================================================================
// Track Management
// ============================================================================

async function deleteTrack(trackId) {
    if (!confirm('Are you sure you want to delete this track?')) return;

    const result = wasmCallWithError('ipod_remove_track', trackId);
    if (result !== 0) return;

    log(`Deleted track ID: ${trackId}`, 'success');
    await loadTracks();
    await loadPlaylists();
}

/**
 * Remove a track from the current playlist
 * Only works when viewing a non-master playlist
 * @param {number} trackId - The track ID to remove
 */
async function removeTrackFromPlaylist(trackId) {
    if (currentPlaylistIndex < 0 || currentPlaylistIndex >= allPlaylists.length) {
        log('No playlist selected', 'warning');
        return;
    }

    const playlist = allPlaylists[currentPlaylistIndex];
    if (playlist.is_master) {
        log('Cannot remove tracks from master playlist', 'warning');
        return;
    }

    if (!confirm(`Remove this track from "${playlist.name}"?`)) return;

    const result = wasmCall('ipod_playlist_remove_track', currentPlaylistIndex, trackId);
    if (result !== 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to remove track: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    log(`Removed track from playlist: ${playlist.name}`, 'success');
    await loadPlaylistTracks(currentPlaylistIndex);
    await loadPlaylists();
}

/**
 * Add a track to a specific playlist
 * @param {number} trackId - The track ID to add
 * @param {number} playlistIndex - The playlist index to add to
 */
async function addTrackToPlaylist(trackId, playlistIndex) {
    if (playlistIndex < 0 || playlistIndex >= allPlaylists.length) {
        log('Invalid playlist index', 'error');
        return;
    }

    const playlist = allPlaylists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot add tracks to master playlist directly', 'warning');
        return;
    }

    const result = wasmCall('ipod_playlist_add_track', playlistIndex, trackId);
    if (result === 0) {
        log(`Added track to playlist: ${playlist.name}`, 'success');
        await loadPlaylists(); // Refresh playlist counts
    } else {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasmGetString(errorPtr)}`, 'error');
    }
}

// ============================================================================
// Context Menu (Right-Click) Functionality
// ============================================================================

let contextMenuData = {
    type: null,        // 'playlist' or 'track'
    playlistIndex: null,
    trackId: null
};

/**
 * Show the context menu at the specified position
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function showContextMenu(x, y) {
    const menu = document.getElementById('contextMenu');
    if (!menu) {
        log('Context menu element not found when trying to show', 'error');
        return;
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('show');
}

/**
 * Hide the context menu
 */
function hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    menu.classList.remove('show');
    contextMenuData = { type: null, playlistIndex: null, trackId: null };
}

/**
 * Attach context menu handlers to playlist items
 * Right-click on a playlist shows "Delete Playlist" option
 */
function attachPlaylistContextMenus() {
    // Use event delegation on the playlist list container
    const playlistList = document.getElementById('playlistList');
    if (!playlistList) return;
    
    // Remove old listener if exists
    if (playlistList.dataset.contextMenuHandler) {
        playlistList.removeEventListener('contextmenu', playlistList._contextMenuHandler);
    }
    
    // Create new handler
    playlistList._contextMenuHandler = (e) => {
        // Find the closest playlist item
        const item = e.target.closest('.playlist-item[data-playlist-index]');
        if (!item) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const playlistIndex = parseInt(item.getAttribute('data-playlist-index'));
        const playlist = allPlaylists[playlistIndex];
        
        // Don't show menu for master playlist
        if (playlist && playlist.is_master) return;
        
        const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
        const deleteTrackBtn = document.getElementById('contextDeleteTrack');
        const addToPlaylistBtn = document.getElementById('contextAddToPlaylist');
        const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');
        
        if (!deletePlaylistBtn || !deleteTrackBtn || !addToPlaylistBtn || !removeFromPlaylistBtn) {
            log('Context menu elements not found', 'error');
            return;
        }
        
        contextMenuData = {
            type: 'playlist',
            playlistIndex: playlistIndex,
            trackId: null
        };
        
        // Show only delete playlist option
        deletePlaylistBtn.style.display = 'block';
        deleteTrackBtn.style.display = 'none';
        addToPlaylistBtn.style.display = 'none';
        removeFromPlaylistBtn.style.display = 'none';
        
        showContextMenu(e.pageX, e.pageY);
    };
    
    playlistList.addEventListener('contextmenu', playlistList._contextMenuHandler);
    playlistList.dataset.contextMenuHandler = 'true';
}

/**
 * Attach context menu handlers to track rows
 * Right-click on a track shows:
 * - "Delete Track" (always)
 * - "Add to Playlist" (with submenu of non-master playlists)
 * - "Remove from Playlist" (only if viewing a non-master playlist)
 */
function attachTrackContextMenus() {
    // Use event delegation on the track table body
    const trackTable = document.getElementById('trackTableBody');
    if (!trackTable) return;
    
    // Remove old listener if exists
    if (trackTable.dataset.contextMenuHandler) {
        trackTable.removeEventListener('contextmenu', trackTable._contextMenuHandler);
    }
    
    // Create new handler
    trackTable._contextMenuHandler = (e) => {
        // Find the closest track row
        const row = e.target.closest('tr[data-track-id]');
        if (!row) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const trackId = parseInt(row.getAttribute('data-track-id'));
        
        const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
        const deleteTrackBtn = document.getElementById('contextDeleteTrack');
        const addToPlaylistBtn = document.getElementById('contextAddToPlaylist');
        const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');
        
        if (!deletePlaylistBtn || !deleteTrackBtn || !addToPlaylistBtn || !removeFromPlaylistBtn) {
            log('Context menu elements not found', 'error');
            return;
        }
        
        contextMenuData = {
            type: 'track',
            playlistIndex: currentPlaylistIndex,
            trackId: trackId
        };
        
        // Show delete track option
        deleteTrackBtn.style.display = 'block';
        
        // Show add to playlist option with submenu
        addToPlaylistBtn.style.display = 'block';
        buildPlaylistSubmenu(trackId);
        
        // Show remove from playlist only if in a non-master playlist
        const showRemove = currentPlaylistIndex >= 0 && 
                          currentPlaylistIndex < allPlaylists.length &&
                          !allPlaylists[currentPlaylistIndex].is_master;
        removeFromPlaylistBtn.style.display = showRemove ? 'block' : 'none';
        
        // Hide delete playlist option
        deletePlaylistBtn.style.display = 'none';
        
        showContextMenu(e.pageX, e.pageY);
    };
    
    trackTable.addEventListener('contextmenu', trackTable._contextMenuHandler);
    trackTable.dataset.contextMenuHandler = 'true';
}

/**
 * Build the playlist submenu for "Add to Playlist"
 * Shows all non-master playlists, excluding the current playlist if viewing one
 * @param {number} trackId - The track ID to add
 */
function buildPlaylistSubmenu(trackId) {
    const submenu = document.getElementById('playlistSubmenu');
    
    // Filter out master playlists and the current playlist (if viewing one)
    const availablePlaylists = allPlaylists.filter((pl, index) => {
        // Exclude master playlist
        if (pl.is_master) return false;
        
        // Exclude current playlist if we're viewing one (not "All Tracks")
        if (currentPlaylistIndex >= 0 && index === currentPlaylistIndex) return false;
        
        return true;
    });
    
    if (availablePlaylists.length === 0) {
        submenu.innerHTML = '<div class="context-submenu-item" style="opacity: 0.5;">No other playlists</div>';
        return;
    }
    
    submenu.innerHTML = availablePlaylists.map((pl) => {
        const actualIndex = allPlaylists.indexOf(pl);
        return `
            <div class="context-submenu-item" onclick="addTrackToPlaylist(${trackId}, ${actualIndex}); hideContextMenu();">
                ${escapeHtml(pl.name)}
            </div>
        `;
    }).join('');
}

/**
 * Initialize context menu event handlers
 * Sets up click handlers for menu items and document click to close menu
 */
function initContextMenu() {
    const menu = document.getElementById('contextMenu');
    if (!menu) {
        log('Context menu element not found', 'error');
        return;
    }
    
    const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
    const deleteTrackBtn = document.getElementById('contextDeleteTrack');
    const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');
    
    if (!deletePlaylistBtn || !deleteTrackBtn || !removeFromPlaylistBtn) {
        log('Context menu buttons not found', 'error');
        return;
    }
    
    // Delete playlist handler
    deletePlaylistBtn.addEventListener('click', () => {
        if (contextMenuData.type === 'playlist' && contextMenuData.playlistIndex !== null) {
            deletePlaylist(contextMenuData.playlistIndex);
            hideContextMenu();
        }
    });
    
    // Delete track handler
    deleteTrackBtn.addEventListener('click', () => {
        if (contextMenuData.type === 'track' && contextMenuData.trackId !== null) {
            deleteTrack(contextMenuData.trackId);
            hideContextMenu();
        }
    });
    
    // Remove from playlist handler
    removeFromPlaylistBtn.addEventListener('click', () => {
        if (contextMenuData.type === 'track' && contextMenuData.trackId !== null) {
            removeTrackFromPlaylist(contextMenuData.trackId);
            hideContextMenu();
        }
    });
    
    // Close menu when clicking outside (only add once)
    if (!window.contextMenuClickHandler) {
        window.contextMenuClickHandler = (e) => {
            if (!menu.contains(e.target)) {
                hideContextMenu();
            }
        };
        document.addEventListener('click', window.contextMenuClickHandler);
    }
    
    // Close menu on escape key (only add once)
    if (!window.contextMenuKeyHandler) {
        window.contextMenuKeyHandler = (e) => {
            if (e.key === 'Escape' && menu.classList.contains('show')) {
                hideContextMenu();
            }
        };
        document.addEventListener('keydown', window.contextMenuKeyHandler);
    }
}

// ============================================================================
// UI State Management
// ============================================================================

function updateConnectionStatus(connected) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn = document.getElementById('connectBtn');

    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Connected';
        btn.textContent = '📁 Change iPod';
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Not Connected';
        btn.textContent = '📁 Select iPod';
    }
}

function enableUIIfReady() {
    const ready = wasmReady && isConnected;
    ['uploadBtn', 'saveBtn', 'refreshBtn', 'newPlaylistBtn'].forEach(id => {
        document.getElementById(id).disabled = !ready;
    });
}

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    log('TunesReloaded initialized');

    if (!('showDirectoryPicker' in window)) {
        log('File System Access API not supported. Use Chrome or Edge.', 'error');
        document.getElementById('connectBtn').disabled = true;
    }

    initWasm();
    initContextMenu(); // Initialize context menu handlers
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isConnected) saveDatabase();
    }
});
