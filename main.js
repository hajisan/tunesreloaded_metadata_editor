import { createLogger } from './modules/logger.js';
import { createWasmApi } from './modules/wasmApi.js';
import { createFsSync } from './modules/fsSync.js';
import { createContextMenu } from './modules/contextMenu.js';
import { createFirewireSetup } from './modules/firewireSetup.js';
import { createModalManager } from './modules/modalManager.js';
import { createAppState } from './modules/state.js';
import { readAudioTags, getAudioProperties, getFiletypeFromName, isAudioFile } from './modules/audio.js';
import { renderTracks, renderPlaylists, formatDuration, updateConnectionStatus, enableUIIfReady } from './modules/uiRender.js';

/**
 * TunesReloaded - module entrypoint
 * Keeps existing UI behavior while making the codebase modular.
 */

// Centralized state
const appState = createAppState();

// Module instances
const { log, toggleLogPanel, escapeHtml } = createLogger();
const wasm = createWasmApi({ log });
const fsSync = createFsSync({ log, wasm, mountpoint: '/iPod' });
const firewireSetup = createFirewireSetup({ log });
const modals = createModalManager();

// === Database / view refresh ===
async function parseDatabase() {
    log('Parsing iTunesDB...');
    const result = wasm.wasmCallWithError('ipod_parse_db');
    if (result !== 0) return;

    appState.isConnected = true;
    updateConnectionStatus(true);
    enableUIIfReady({ wasmReady: appState.wasmReady, isConnected: appState.isConnected });

    await refreshCurrentView();
    log('Database loaded successfully', 'success');
}

async function loadTracks() {
    log('Loading tracks...');
    const tracks = wasm.wasmGetJson('ipod_get_all_tracks_json');
    if (tracks) {
        appState.tracks = tracks;
        renderTracks({ tracks, escapeHtml });
    }
}

async function loadPlaylists() {
    log('Loading playlists...');
    const playlists = wasm.wasmGetJson('ipod_get_all_playlists_json');
    if (playlists) {
        appState.playlists = playlists;
        renderPlaylists({
            playlists,
            currentPlaylistIndex: appState.currentPlaylistIndex,
            allTracksCount: appState.tracks.length,
            escapeHtml,
        });
    }
}

async function loadPlaylistTracks(index) {
    if (index < 0 || index >= appState.playlists.length) {
        log(`Invalid playlist index: ${index}`, 'error');
        return;
    }

    const playlistName = appState.playlists[index].name;
    log(`Loading tracks for playlist: "${playlistName}"`, 'info');

    const tracks = wasm.wasmGetJson('ipod_get_playlist_tracks_json', index);
    if (tracks) {
        renderTracks({ tracks, escapeHtml });
    }
}

async function refreshCurrentView() {
    await loadPlaylists();
    const idx = appState.currentPlaylistIndex;
    if (idx === -1) {
        await loadTracks();
    } else if (idx >= 0 && idx < appState.playlists.length) {
        await loadPlaylistTracks(idx);
    } else {
        appState.currentPlaylistIndex = -1;
        await loadTracks();
    }
}

async function refreshTracks() {
    const saved = appState.currentPlaylistIndex;
    await loadPlaylists();
    appState.currentPlaylistIndex = saved;
    await refreshCurrentView();
    log('Refreshed track list', 'info');
}

async function saveDatabase() {
    log('Saving database...');
    const result = wasm.wasmCallWithError('ipod_write_db');
    if (result !== 0) return;
    await fsSync.syncVirtualFSToIpod(appState.ipodHandle);
    await refreshCurrentView();
    log('Database saved successfully', 'success');
}

// === Connect / FS ===
async function selectIpodFolder() {
    try {
        log('Opening folder picker...');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        appState.ipodHandle = handle;
        log(`Selected folder: ${handle.name}`, 'success');

        const isValid = await fsSync.verifyIpodStructure(handle);
        if (!isValid) {
            log('This folder does not look like an iPod root. Please select the iPod volume root (must contain iPod_Control/iTunes/iTunesDB).', 'error');
            return;
        }

        // Check if FirewireGuid exists (needed for iPod Classic 6G+)
        const hasFirewireGuid = await firewireSetup.checkFirewireGuid(handle);
        if (!hasFirewireGuid) {
            log('FirewireGuid not found - iPod Classic may need setup', 'warning');
            modals.showFirewireSetup();
            return; // Wait for user to complete setup
        }

        await continueIpodConnection();
    } catch (e) {
        if (e.name === 'AbortError') {
            log('Folder selection cancelled', 'warning');
        } else {
            log(`Error selecting folder: ${e.message}`, 'error');
        }
    }
}

async function continueIpodConnection() {
    if (!appState.ipodHandle) return;
    await fsSync.setupWasmFilesystem(appState.ipodHandle);
    await parseDatabase();
}

// === FirewireGuid Setup (for iPod Classic 6G+) ===
async function setupFirewireGuid() {
    try {
        await firewireSetup.performSetup(appState.ipodHandle);
        modals.hideFirewireSetup();
        log('FirewireGuid setup complete!', 'success');
        await continueIpodConnection();
    } catch (e) {
        if (e.name === 'NotFoundError') {
            log('No device selected', 'warning');
        } else {
            log(`WebUSB error: ${e.message}`, 'error');
        }
    }
}

async function skipFirewireSetup() {
    modals.hideFirewireSetup();
    log('Skipping FirewireGuid setup - songs may not appear on iPod', 'warning');
    await continueIpodConnection();
}

// === Playlist modal ===
function showNewPlaylistModal() {
    modals.showNewPlaylist();
    const input = document.getElementById('playlistName');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function hideNewPlaylistModal() {
    modals.hideNewPlaylist();
}

function createPlaylist() {
    const name = (document.getElementById('playlistName')?.value || '').trim();
    if (!name) {
        log('Playlist name cannot be empty', 'warning');
        return;
    }

    const result = wasm.wasmCallWithStrings('ipod_create_playlist', [name]);
    if (result < 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to create playlist: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    hideNewPlaylistModal();
    refreshCurrentView();
    log(`Created playlist: ${name}`, 'success');
}

async function deletePlaylist(playlistIndex) {
    const playlists = appState.playlists;
    if (playlistIndex < 0 || playlistIndex >= playlists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = playlists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot delete master playlist', 'warning');
        return;
    }
    if (!confirm(`Are you sure you want to delete "${playlist.name}"?`)) return;

    const result = wasm.wasmCallWithError('ipod_delete_playlist', playlistIndex);
    if (result !== 0) return;

    if (appState.currentPlaylistIndex === playlistIndex) {
        appState.currentPlaylistIndex = -1;
    }
    await refreshCurrentView();
    log(`Deleted playlist: ${playlist.name}`, 'success');
}

// === Track management ===
async function deleteTrack(trackId) {
    if (!confirm('Are you sure you want to delete this track?')) return;
    const result = wasm.wasmCallWithError('ipod_remove_track', trackId);
    if (result !== 0) return;
    await refreshCurrentView();
    log(`Deleted track ID: ${trackId}`, 'success');
}

async function addTrackToPlaylist(trackId, playlistIndex) {
    const playlists = appState.playlists;
    if (playlistIndex < 0 || playlistIndex >= playlists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = playlists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot add tracks to master playlist directly', 'warning');
        return;
    }

    const result = wasm.wasmCall('ipod_playlist_add_track', playlistIndex, trackId);
    if (result === 0) {
        await loadPlaylists();
        log(`Added track to playlist: ${playlist.name}`, 'success');
    } else {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasm.wasmGetString(errorPtr)}`, 'error');
    }
}

async function removeTrackFromPlaylist(trackId) {
    const idx = appState.currentPlaylistIndex;
    const playlists = appState.playlists;
    if (idx < 0 || idx >= playlists.length) {
        log('No playlist selected', 'warning');
        return;
    }
    const playlist = playlists[idx];
    if (playlist.is_master) {
        log('Cannot remove tracks from master playlist', 'warning');
        return;
    }
    if (!confirm(`Remove this track from "${playlist.name}"?`)) return;

    const result = wasm.wasmCall('ipod_playlist_remove_track', idx, trackId);
    if (result !== 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to remove track: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    await refreshCurrentView();
    log(`Removed track from playlist: ${playlist.name}`, 'success');
}

// === Upload ===
function updateUploadProgress(current, total, filename) {
    const percent = Math.round((current / total) * 100);
    const bar = document.getElementById('uploadProgress');
    const status = document.getElementById('uploadStatus');
    const detail = document.getElementById('uploadDetail');
    if (bar) bar.style.width = `${percent}%`;
    if (status) status.textContent = `Uploading ${current} of ${total}`;
    if (detail) detail.textContent = filename;
}

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

        modals.showUpload();

        for (let i = 0; i < fileHandles.length; i++) {
            const file = await fileHandles[i].getFile();
            updateUploadProgress(i + 1, fileHandles.length, file.name);
            await uploadSingleTrack(file);
        }

        modals.hideUpload();
        await refreshCurrentView();
        log(`Upload complete: ${fileHandles.length} tracks`, 'success');
    } catch (e) {
        modals.hideUpload();
        if (e.name !== 'AbortError') log(`Upload error: ${e.message}`, 'error');
    }
}

async function uploadSingleTrack(file) {
    const tags = await readAudioTags(file);
    const audioProps = await getAudioProperties(file);
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    const filetype = getFiletypeFromName(file.name);

    const trackIndex = wasm.wasmAddTrack({
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

    if (trackIndex < 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    const destPathPtr = wasm.wasmCallWithStrings('ipod_get_track_dest_path', [file.name]);
    if (!destPathPtr) {
        log('Failed to get destination path', 'error');
        return;
    }

    const destPath = wasm.wasmGetString(destPathPtr);
    wasm.wasmCall('ipod_free_string', destPathPtr);
    if (!destPath) {
        log('Failed to read destination path', 'error');
        return;
    }

    await fsSync.copyFileToVirtualFS(data, destPath);

    // Use ipod_finalize_last_track which uses the stored track pointer directly
    const finalizePathPtr = wasm.wasmAllocString(destPath);
    const result = wasm.wasmCallWithError('ipod_finalize_last_track', finalizePathPtr);
    wasm.wasmFreeString(finalizePathPtr);

    if (result !== 0) {
        const ipodPath = destPath.replace(/^\/iPod\//, '').replace(/\//g, ':');
        wasm.wasmCallWithStrings('ipod_track_set_path', [ipodPath], [trackIndex]);
    }

    const idx = appState.currentPlaylistIndex;
    if (idx >= 0 && idx < appState.playlists.length) {
        wasm.wasmCall('ipod_playlist_add_track', idx, trackIndex);
    }

    log(`Added: ${tags.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
}

// === Search / playlist selection ===
function selectPlaylist(index) {
    appState.currentPlaylistIndex = index;
    renderPlaylists({
        playlists: appState.playlists,
        currentPlaylistIndex: index,
        allTracksCount: appState.tracks.length,
        escapeHtml,
    });
    if (index === -1) {
        renderTracks({ tracks: appState.tracks, escapeHtml });
    } else {
        loadPlaylistTracks(index);
    }
}

function filterTracks() {
    const query = (document.getElementById('searchBox')?.value || '').toLowerCase();
    const idx = appState.currentPlaylistIndex;
    if (!query) {
        if (idx === -1) renderTracks({ tracks: appState.tracks, escapeHtml });
        else loadPlaylistTracks(idx);
        return;
    }

    const filtered = appState.tracks.filter(track =>
        (track.title && track.title.toLowerCase().includes(query)) ||
        (track.artist && track.artist.toLowerCase().includes(query)) ||
        (track.album && track.album.toLowerCase().includes(query))
    );
    renderTracks({ tracks: filtered, escapeHtml });
}

// === Drag & drop ===
function initDragAndDrop() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

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

        if (!appState.isConnected) {
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
        modals.showUpload();

        for (let i = 0; i < files.length; i++) {
            updateUploadProgress(i + 1, files.length, files[i].name);
            await uploadSingleTrack(files[i]);
        }

        modals.hideUpload();
        await refreshCurrentView();
    });
}

// === Context menus ===
const contextMenu = createContextMenu({
    log,
    getAllPlaylists: () => appState.playlists,
    getCurrentPlaylistIndex: () => appState.currentPlaylistIndex,
    actions: {
        deletePlaylist,
        deleteTrack,
        addTrackToPlaylist,
        removeTrackFromPlaylist,
    }
});

// === Expose globals for inline HTML handlers ===
Object.assign(window, {
    toggleLogPanel,
    selectIpodFolder,
    uploadTracks,
    saveDatabase,
    refreshTracks,
    showNewPlaylistModal,
    hideNewPlaylistModal,
    createPlaylist,
    selectPlaylist,
    filterTracks,
    deleteTrack,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    hideContextMenu: contextMenu.hideContextMenu,
    setupFirewireGuid,
    skipFirewireSetup,
});

// === Initialization ===
document.addEventListener('DOMContentLoaded', async () => {
    log('TunesReloaded initialized');

    if (!('showDirectoryPicker' in window)) {
        log('File System Access API not supported. Use Chrome or Edge.', 'error');
        const btn = document.getElementById('connectBtn');
        if (btn) btn.disabled = true;
    }

    initDragAndDrop();
    contextMenu.initContextMenu();
    contextMenu.attachPlaylistContextMenus();
    contextMenu.attachTrackContextMenus();

    const ok = await wasm.initWasm();
    appState.wasmReady = ok;
    enableUIIfReady({ wasmReady: ok, isConnected: appState.isConnected });
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (appState.isConnected) saveDatabase();
    }
});

