/**
 * hashAB.js — JavaScript hashAB computation using the pre-built calcHashAB.wasm
 *
 * Uses the verified WASM module from dstaley/hashab instead of the C code
 * compiled through emscripten, ensuring correct hash computation for iPod
 * Nano 6th/7th Gen devices.
 *
 * Provides two functions:
 *   recomputeITunesCDBHash(data, uuid)  — patches the hashAB in an iTunesCDB buffer
 *   computeLocationsCBK(locationsData, uuid) — builds a complete Locations.itdb.cbk
 */

let wasmInstance = null;

/**
 * Initialize the WASM module. Must be called once before using hash functions.
 */
export async function initHashAB() {
    if (wasmInstance) return;

    const resp = await fetch(new URL('./calcHashAB.wasm', import.meta.url));
    const wasmBuffer = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
    wasmInstance = instance;
}

/**
 * Compute a 57-byte HashAB signature from a 20-byte SHA1 and 8-byte UUID.
 * @param {Uint8Array} sha1  — 20 bytes
 * @param {Uint8Array} uuid  — 8 bytes (FirewireGuid)
 * @returns {Uint8Array} — 57-byte signature (starts with 03 00)
 */
function calcHashAB(sha1, uuid) {
    if (!wasmInstance) throw new Error('hashAB WASM not initialized — call initHashAB() first');

    const { getInputSha1, getInputUuid, getOutput, calculateHash, memory } = wasmInstance.exports;
    const mem = new Uint8Array(memory.buffer);

    const sha1Ptr = getInputSha1();
    const uuidPtr = getInputUuid();
    const outputPtr = getOutput();

    mem.set(sha1, sha1Ptr);
    mem.set(uuid, uuidPtr);
    calculateHash();

    return new Uint8Array(mem.slice(outputPtr, outputPtr + 57));
}

/**
 * Compute SHA-1 of a Uint8Array using the Web Crypto API.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>} — 20-byte SHA1
 */
async function sha1(data) {
    const hash = await crypto.subtle.digest('SHA-1', data);
    return new Uint8Array(hash);
}

// ─── iTunesCDB (mhbd) header offsets ───
const MHBD_DB_ID_OFFSET   = 0x18;  // 8 bytes
const MHBD_DB_ID_LEN      = 8;
const MHBD_HASH58_OFFSET  = 0x58;  // 20 bytes
const MHBD_HASH58_LEN     = 20;
const MHBD_HASH72_OFFSET  = 0x72;  // 46 bytes
const MHBD_HASH72_LEN     = 46;
const MHBD_HASHAB_OFFSET  = 0xAB;  // 57 bytes
const MHBD_HASHAB_LEN     = 57;
const MHBD_SCHEME_OFFSET  = 0x30;  // 2 bytes (hashing_scheme, LE)

/**
 * Recompute the HashAB signature inside an iTunesCDB buffer, in-place.
 *
 * @param {Uint8Array} data — the full iTunesCDB binary (modified in-place)
 * @param {Uint8Array} uuid — 8-byte FirewireGuid
 * @returns {Promise<Uint8Array>} — the same buffer, with hashAB patched
 */
export async function recomputeITunesCDBHash(data, uuid) {
    if (data.length < 0xAB + 57) {
        console.warn('[hashAB] iTunesCDB too small for hashAB recomputation');
        return data;
    }

    // Verify it's an mhbd header
    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== 'mhbd') {
        console.warn('[hashAB] iTunesCDB does not start with mhbd');
        return data;
    }

    // Set hashing_scheme to 3 (HashAB) — little-endian uint16
    data[MHBD_SCHEME_OFFSET] = 0x03;
    data[MHBD_SCHEME_OFFSET + 1] = 0x00;

    // Make a copy for SHA1 computation with fields zeroed
    const buf = new Uint8Array(data);
    buf.fill(0, MHBD_DB_ID_OFFSET, MHBD_DB_ID_OFFSET + MHBD_DB_ID_LEN);
    buf.fill(0, MHBD_HASH58_OFFSET, MHBD_HASH58_OFFSET + MHBD_HASH58_LEN);
    buf.fill(0, MHBD_HASH72_OFFSET, MHBD_HASH72_OFFSET + MHBD_HASH72_LEN);
    buf.fill(0, MHBD_HASHAB_OFFSET, MHBD_HASHAB_OFFSET + MHBD_HASHAB_LEN);

    // Compute SHA1 of the zeroed buffer
    const sha1Hash = await sha1(buf);

    // Compute HashAB
    const sig = calcHashAB(sha1Hash, uuid);

    // Patch the original data
    data.set(sig, MHBD_HASHAB_OFFSET);

    console.log(`[hashAB] Recomputed iTunesCDB hash (SHA1: ${hex(sha1Hash)}, sig[0:4]: ${hex(sig.slice(0, 4))})`);
    return data;
}

// ─── Locations.itdb.cbk ───
const CBK_BLOCK_SIZE   = 1024;
const CBK_HEADER_SIZE  = 57;  // HashAB signature
const CBK_SHA1_SIZE    = 20;

/**
 * Build a complete Locations.itdb.cbk from Locations.itdb data.
 *
 * Format:
 *   [57 bytes]  HashAB signature (over master SHA1)
 *   [20 bytes]  Master SHA1 = SHA1(concat of all block SHA1s)
 *   [N×20 bytes] SHA1 of each 1024-byte block
 *
 * @param {Uint8Array} locationsData — raw Locations.itdb file content
 * @param {Uint8Array} uuid — 8-byte FirewireGuid
 * @returns {Promise<Uint8Array>} — complete .cbk file
 */
export async function computeLocationsCBK(locationsData, uuid) {
    const numBlocks = Math.ceil(locationsData.length / CBK_BLOCK_SIZE);

    // SHA1 of each 1024-byte block
    const blockHashes = [];
    for (let i = 0; i < numBlocks; i++) {
        const start = i * CBK_BLOCK_SIZE;
        const end = Math.min(start + CBK_BLOCK_SIZE, locationsData.length);
        const block = locationsData.slice(start, end);
        // Pad to 1024 if last block is short (shouldn't happen for SQLite but be safe)
        let paddedBlock = block;
        if (block.length < CBK_BLOCK_SIZE) {
            paddedBlock = new Uint8Array(CBK_BLOCK_SIZE);
            paddedBlock.set(block);
        }
        const hash = await sha1(paddedBlock);
        blockHashes.push(hash);
    }

    // Master SHA1 = SHA1(concat of all block hashes)
    const allHashes = new Uint8Array(numBlocks * CBK_SHA1_SIZE);
    for (let i = 0; i < numBlocks; i++) {
        allHashes.set(blockHashes[i], i * CBK_SHA1_SIZE);
    }
    const masterSha1 = await sha1(allHashes);

    // HashAB signature over master SHA1
    const sig = calcHashAB(masterSha1, uuid);

    // Build cbk: [signature][master sha1][block hashes...]
    const cbkSize = CBK_HEADER_SIZE + CBK_SHA1_SIZE + numBlocks * CBK_SHA1_SIZE;
    const cbk = new Uint8Array(cbkSize);
    cbk.set(sig, 0);                           // 57-byte signature
    cbk.set(masterSha1, CBK_HEADER_SIZE);       // 20-byte master SHA1
    cbk.set(allHashes, CBK_HEADER_SIZE + CBK_SHA1_SIZE); // block hashes

    console.log(`[hashAB] Computed Locations.itdb.cbk: ${cbkSize} bytes, ` +
        `${numBlocks} blocks, master SHA1: ${hex(masterSha1)}, sig[0:4]: ${hex(sig.slice(0, 4))}`);
    return cbk;
}

/**
 * Parse a FirewireGuid hex string into an 8-byte Uint8Array.
 * @param {string} guidStr — e.g. "000A2700248F5308"
 * @returns {Uint8Array}
 */
export function parseUUID(guidStr) {
    const hex = guidStr.replace(/^0x/i, '');
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
