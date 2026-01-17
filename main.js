/**
 * TunesReloaded - Web-based iPod Manager
 * Main JavaScript file for UI logic and WASM integration
 */

// ============================================================================
// Global State
// ============================================================================

let ipodHandle = null;          // FileSystemDirectoryHandle for iPod
let isConnected = false;
let allTracks = [];
let allPlaylists = [];
let currentPlaylistIndex = -1;  // -1 means "All Tracks"
let logEntries = [];
let wasmReady = false;

// ============================================================================
// Logging Functions
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

    // Also log to browser console
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
// WASM Module Interface
// ============================================================================

// Module will be set when WASM loads
let Module = null;

// Initialize WASM module
async function initWasm() {
    log('Loading WASM module...');
    try {
        // createIPodModule is defined in ipod_manager.js (emscripten output)
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

// Wrapper functions for WASM calls
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
    if (!ptr) return null;
    return Module.UTF8ToString(ptr);
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

// ============================================================================
// File System Access API
// ============================================================================

async function selectIpodFolder() {
    try {
        log('Opening folder picker...');

        // Request directory access
        const handle = await window.showDirectoryPicker({
            mode: 'readwrite'
        });

        ipodHandle = handle;
        log(`Selected folder: ${handle.name}`, 'success');

        // Verify this looks like an iPod
        const isValid = await verifyIpodStructure(handle);
        if (!isValid) {
            log('Warning: This folder may not be an iPod. Looking for iPod_Control folder...', 'warning');
        }

        // Set up virtual filesystem for WASM
        await setupWasmFilesystem(handle);

        // Parse the database
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
        // Check for iPod_Control folder
        const controlDir = await handle.getDirectoryHandle('iPod_Control', { create: false });
        log('Found iPod_Control directory', 'success');

        // Check for iTunes folder
        const itunesDir = await controlDir.getDirectoryHandle('iTunes', { create: false });
        log('Found iTunes directory', 'success');

        // Check for iTunesDB
        const itunesDB = await itunesDir.getFileHandle('iTunesDB', { create: false });
        log('Found iTunesDB file', 'success');

        return true;
    } catch (e) {
        return false;
    }
}

async function setupWasmFilesystem(handle) {
    log('Setting up virtual filesystem for WASM...');

    // For Emscripten, we need to mount the filesystem
    // The mountpoint will be /ipod in the virtual FS

    const mountpoint = '/iPod';

    // Create the mount point directory
    try {
        Module.FS.mkdir(mountpoint);
    } catch (e) {
        // Directory might already exist
    }

    // Mount IDBFS or NODEFS depending on environment
    // For web, we'll use a custom approach: read files on demand

    // Set the mountpoint in WASM
    const mpPtr = wasmAllocString(mountpoint);
    wasmCall('ipod_set_mountpoint', mpPtr);
    wasmFreeString(mpPtr);

    // Sync the iPod files to the virtual filesystem
    await syncIpodToVirtualFS(handle, mountpoint);

    log('Virtual filesystem ready', 'success');
}

async function syncIpodToVirtualFS(handle, mountpoint) {
    log('Syncing iPod files to virtual filesystem...');

    // Recursively copy directory structure
    await syncDirectory(handle, mountpoint);

    log('File sync complete', 'success');
}

async function syncDirectory(dirHandle, virtualPath) {
    // Only create directory if it doesn't exist (silently)
    try {
        Module.FS.mkdir(virtualPath);
    } catch (e) {
        // Directory exists - that's fine
    }

    for await (const [name, handle] of dirHandle.entries()) {
        const childPath = `${virtualPath}/${name}`;

        if (handle.kind === 'directory') {
            // Only sync necessary directories for iPod structure
            // iPod_Control, iTunes, Device, Artwork - always sync these
            if (name === 'iPod_Control' || name === 'iTunes' || name === 'Device' || name === 'Artwork') {
                await syncDirectory(handle, childPath);
            } else if (name === 'Music') {
                // For Music directory, sync it but skip empty F## folders
                // We'll only sync F## folders that actually contain files
                await syncDirectory(handle, childPath);
            } else if (name.match(/^F\d{2}$/i)) {
                // Skip F## folders during initial sync - they'll be created when needed
                // Only sync if they contain actual files
                let hasFiles = false;
                try {
                    for await (const [childName, childHandle] of handle.entries()) {
                        if (childHandle.kind === 'file') {
                            hasFiles = true;
                            break;
                        }
                    }
                } catch (e) {
                    // Can't read directory, skip it
                }
                
                if (hasFiles) {
                    // Only create directory and sync if it has files
                    try {
                        Module.FS.mkdir(childPath);
                    } catch (e) {
                        // Directory exists
                    }
                    await syncDirectory(handle, childPath);
                }
                // Otherwise, skip empty F## folders completely
            }
        } else if (handle.kind === 'file') {
            // Log all files we encounter in iTunes folder for debugging
            if (virtualPath.includes('iTunes')) {
                log(`Found file in iTunes: ${name}`, 'info');
            }

            // Sync database files and audio - be more inclusive with iTunes folder files
            const lowerName = name.toLowerCase();
            const isItunesFile = lowerName.startsWith('itunes') || lowerName.startsWith('itunesdb');
            const isDeviceFile = name === 'DeviceInfo' || name === 'SysInfo' || name === 'SysInfoExtended';
            const isAudioFile = lowerName.endsWith('.mp3') || lowerName.endsWith('.m4a') ||
                               lowerName.endsWith('.aac') || lowerName.endsWith('.wav');
            const isArtworkFile = lowerName.endsWith('.ithmb') || lowerName.endsWith('.itdb');

            if (isItunesFile || isDeviceFile || isAudioFile || isArtworkFile) {
                await syncFile(handle, childPath);
            }
        }
    }
}

async function syncFile(fileHandle, virtualPath) {
    try {
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Write to virtual filesystem
        Module.FS.writeFile(virtualPath, data);
        log(`Synced: ${virtualPath}`, 'info');
    } catch (e) {
        log(`Failed to sync ${virtualPath}: ${e.message}`, 'warning');
    }
}

// ============================================================================
// Database Operations
// ============================================================================

async function parseDatabase() {
    log('Parsing iTunesDB...');

    const result = wasmCall('ipod_parse_db');

    if (result !== 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        const error = wasmGetString(errorPtr);
        log(`Failed to parse database: ${error}`, 'error');
        return;
    }

    isConnected = true;
    updateConnectionStatus(true);
    enableUIIfReady();

    // Load device info
    loadDeviceInfo();

    // Load tracks and playlists
    await loadTracks();
    await loadPlaylists();

    log('Database loaded successfully', 'success');
}

function loadDeviceInfo() {
    const jsonPtr = wasmCall('ipod_get_device_info_json');
    if (!jsonPtr) return;

    const jsonStr = wasmGetString(jsonPtr);
    wasmCall('ipod_free_string', jsonPtr);

    try {
        const info = JSON.parse(jsonStr);

        document.getElementById('deviceInfo').style.display = 'block';
        document.getElementById('deviceModel').textContent = info.model_name || 'iPod';
        document.getElementById('deviceGen').textContent = `Generation: ${info.generation}`;
        document.getElementById('deviceCapacity').textContent = `Capacity: ${info.capacity}GB`;
        document.getElementById('deviceTracks').textContent = `Tracks: ${info.track_count}`;

        log(`Device: ${info.model_name} (${info.generation})`, 'info');
    } catch (e) {
        log(`Failed to parse device info: ${e.message}`, 'warning');
    }
}

async function loadTracks() {
    log('Loading tracks...');

    const jsonPtr = wasmCall('ipod_get_all_tracks_json');
    if (!jsonPtr) {
        log('Failed to get tracks', 'error');
        return;
    }

    const jsonStr = wasmGetString(jsonPtr);
    wasmCall('ipod_free_string', jsonPtr);

    try {
        allTracks = JSON.parse(jsonStr);
        log(`Loaded ${allTracks.length} tracks`, 'success');
        renderTracks(allTracks);
    } catch (e) {
        log(`Failed to parse tracks: ${e.message}`, 'error');
    }
}

async function loadPlaylists() {
    log('Loading playlists...');

    const jsonPtr = wasmCall('ipod_get_all_playlists_json');
    if (!jsonPtr) {
        log('Failed to get playlists', 'error');
        return;
    }

    const jsonStr = wasmGetString(jsonPtr);
    wasmCall('ipod_free_string', jsonPtr);

    try {
        allPlaylists = JSON.parse(jsonStr);
        log(`Loaded ${allPlaylists.length} playlists`, 'success');
        renderPlaylists(allPlaylists);
    } catch (e) {
        log(`Failed to parse playlists: ${e.message}`, 'error');
    }
}

async function saveDatabase() {
    log('Saving database...');

    // First, sync virtual FS back to real FS
    await syncVirtualFSToIpod();

    const result = wasmCall('ipod_write_db');

    if (result !== 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        const error = wasmGetString(errorPtr);
        log(`Failed to save database: ${error}`, 'error');
        return;
    }

    // Sync the written files back to the real filesystem
    await syncVirtualFSToIpod();

    log('Database saved successfully', 'success');
}

async function syncVirtualFSToIpod() {
    if (!ipodHandle) return;

    log('Syncing changes to iPod...');

    // Read modified files from virtual FS and write to real FS
    // Use /iPod (capital I) to match the mountpoint
    try {
        // Sync iTunesDB
        await syncVirtualFileToReal('/iPod/iPod_Control/iTunes/iTunesDB',
            ['iPod_Control', 'iTunes'], 'iTunesDB');

        // Sync iTunesSD if it exists
        try {
            await syncVirtualFileToReal('/iPod/iPod_Control/iTunes/iTunesSD',
                ['iPod_Control', 'iTunes'], 'iTunesSD');
        } catch (e) {
            // iTunesSD might not exist - that's fine
        }

        log('Sync complete', 'success');
    } catch (e) {
        const errorMsg = e.message || e.toString() || 'Unknown error';
        log(`Sync error: ${errorMsg}`, 'error');
    }
}

async function syncVirtualFileToReal(virtualPath, dirPath, fileName) {
    try {
        // Check if file exists in virtual FS
        try {
            Module.FS.stat(virtualPath);
        } catch (e) {
            log(`File not found in virtual FS: ${virtualPath}`, 'warning');
            return;
        }

        const data = Module.FS.readFile(virtualPath);

        // Navigate to the directory
        let currentDir = ipodHandle;
        for (const dir of dirPath) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
        }

        // Write the file
        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();

        log(`Synced ${fileName} to iPod`, 'info');
    } catch (e) {
        const errorMsg = e.message || e.toString() || 'Unknown error';
        log(`Failed to sync ${fileName}: ${errorMsg}`, 'warning');
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
                accept: {
                    'audio/*': ['.mp3', '.m4a', '.aac', '.wav', '.aiff']
                }
            }]
        });

        if (fileHandles.length === 0) return;

        log(`Selected ${fileHandles.length} files for upload`, 'info');

        document.getElementById('uploadModal').classList.add('show');

        for (let i = 0; i < fileHandles.length; i++) {
            const fileHandle = fileHandles[i];
            const file = await fileHandle.getFile();

            updateUploadProgress(i + 1, fileHandles.length, file.name);

            await uploadSingleTrack(file);
        }

        document.getElementById('uploadModal').classList.remove('show');

        // Refresh track list
        await loadTracks();

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

    // Extract basic metadata from filename
    let title = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
    let artist = 'Unknown Artist';
    let album = 'Unknown Album';

    // Try to parse "Artist - Title" format
    const match = title.match(/^(.+?)\s*-\s*(.+)$/);
    if (match) {
        artist = match[1].trim();
        title = match[2].trim();
    }

    // Get file info
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const size = data.length;

    // Estimate duration and bitrate (rough estimate for MP3)
    // A proper implementation would parse the actual audio headers
    const bitrate = 192; // Assume 192kbps
    const duration = Math.floor((size * 8) / (bitrate * 1000)) * 1000; // ms

    // Determine filetype
    let filetype = 'MPEG audio file';
    if (file.name.endsWith('.m4a') || file.name.endsWith('.aac')) {
        filetype = 'AAC audio file';
    } else if (file.name.endsWith('.wav')) {
        filetype = 'WAV audio file';
    }

    // Add track to database
    const titlePtr = wasmAllocString(title);
    const artistPtr = wasmAllocString(artist);
    const albumPtr = wasmAllocString(album);
    const genrePtr = wasmAllocString('');
    const filetypePtr = wasmAllocString(filetype);

    const trackId = wasmCall('ipod_add_track',
        titlePtr, artistPtr, albumPtr, genrePtr,
        0, // track_nr
        0, // cd_nr
        0, // year
        duration,
        bitrate,
        44100, // samplerate
        size,
        filetypePtr
    );

    wasmFreeString(titlePtr);
    wasmFreeString(artistPtr);
    wasmFreeString(albumPtr);
    wasmFreeString(genrePtr);
    wasmFreeString(filetypePtr);

    if (trackId < 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    // Get destination path
    const filenamePtr = wasmAllocString(file.name);
    const destPathPtr = wasmCall('ipod_get_track_dest_path', filenamePtr);
    wasmFreeString(filenamePtr);

    if (!destPathPtr) {
        log('Failed to get destination path', 'error');
        return;
    }

    const destPath = wasmGetString(destPathPtr);
    wasmCall('ipod_free_string', destPathPtr);

    // Convert iPod path to filesystem path
    const fsPath = destPath.replace(/:/g, '/');

    // Copy file to iPod
    await copyFileToIpod(data, fsPath);

    // Update track with path
    const pathPtr = wasmAllocString(destPath);
    wasmCall('ipod_track_set_path', trackId, pathPtr);
    wasmFreeString(pathPtr);

    log(`Uploaded: ${title} (ID: ${trackId})`, 'success');
}

async function copyFileToIpod(data, fsPath) {
    if (!ipodHandle) {
        throw new Error('iPod not connected');
    }

    // Parse path
    const parts = fsPath.split('/').filter(p => p);

    // Navigate/create directories
    let currentDir = ipodHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
    }

    // Write file
    const fileName = parts[parts.length - 1];
    const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();

    // Also write to virtual FS (use /iPod to match mountpoint)
    const virtualPath = '/iPod' + fsPath;
    try {
        // Create directories
        let dirPath = '/iPod';
        for (let i = 0; i < parts.length - 1; i++) {
            dirPath += '/' + parts[i];
            try { Module.FS.mkdir(dirPath); } catch (e) {
                // Directory might already exist
            }
        }
        Module.FS.writeFile(virtualPath, data);
    } catch (e) {
        const errorMsg = e.message || e.toString() || 'Unknown error';
        log(`Virtual FS write warning: ${errorMsg}`, 'warning');
    }
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

    const files = [];
    for (const item of e.dataTransfer.items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file && isAudioFile(file.name)) {
                files.push(file);
            }
        }
    }

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
    await loadTracks();
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
        <tr data-id="${track.id}">
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
}

function renderPlaylists(playlists) {
    const list = document.getElementById('playlistList');

    // Add "All Tracks" option
    let html = `
        <li class="playlist-item ${currentPlaylistIndex === -1 ? 'active' : ''}"
            onclick="selectPlaylist(-1)">
            <span>📚 All Tracks</span>
            <span class="track-count">${allTracks.length}</span>
        </li>
    `;

    html += playlists.map((pl, index) => {
        let icon = '📁';
        if (pl.is_master) icon = '🏠';
        else if (pl.is_podcast) icon = '🎙️';
        else if (pl.is_smart) icon = '⚡';

        return `
            <li class="playlist-item ${currentPlaylistIndex === index ? 'active' : ''}"
                onclick="selectPlaylist(${index})">
                <span>${icon} ${escapeHtml(pl.name)}</span>
                <span class="track-count">${pl.track_count}</span>
            </li>
        `;
    }).join('');

    list.innerHTML = html;
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

async function loadPlaylistTracks(index) {
    const jsonPtr = wasmCall('ipod_get_playlist_tracks_json', index);
    if (!jsonPtr) {
        log('Failed to get playlist tracks', 'error');
        return;
    }

    const jsonStr = wasmGetString(jsonPtr);
    wasmCall('ipod_free_string', jsonPtr);

    try {
        const tracks = JSON.parse(jsonStr);
        renderTracks(tracks);
    } catch (e) {
        log(`Failed to parse playlist tracks: ${e.message}`, 'error');
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

async function refreshTracks() {
    await loadTracks();
    await loadPlaylists();
    log('Refreshed track list', 'info');
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

    const namePtr = wasmAllocString(name);
    const result = wasmCall('ipod_create_playlist', namePtr);
    wasmFreeString(namePtr);

    if (result < 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to create playlist: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    hideNewPlaylistModal();
    loadPlaylists();
    log(`Created playlist: ${name}`, 'success');
}

// ============================================================================
// Track Management
// ============================================================================

async function deleteTrack(trackId) {
    if (!confirm('Are you sure you want to delete this track?')) {
        return;
    }

    const result = wasmCall('ipod_remove_track', trackId);

    if (result !== 0) {
        const errorPtr = wasmCall('ipod_get_last_error');
        log(`Failed to delete track: ${wasmGetString(errorPtr)}`, 'error');
        return;
    }

    log(`Deleted track ID: ${trackId}`, 'success');
    await loadTracks();
    await loadPlaylists();
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
        btn.textContent = '📁 Select iPod Folder';
    }
}

function enableUIIfReady() {
    const ready = wasmReady && isConnected;

    document.getElementById('uploadBtn').disabled = !ready;
    document.getElementById('saveBtn').disabled = !ready;
    document.getElementById('refreshBtn').disabled = !ready;
    document.getElementById('newPlaylistBtn').disabled = !ready;
}

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    log('TunesReloaded initialized');

    // Check if File System Access API is available
    if (!('showDirectoryPicker' in window)) {
        log('File System Access API not supported. Use Chrome or Edge.', 'error');
        document.getElementById('connectBtn').disabled = true;
    }

    // Initialize WASM module
    initWasm();
});

// Handle keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S to save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isConnected) saveDatabase();
    }
});
