/**
 * FirewireGuid Setup Module
 * Handles detection and setup of FirewireGuid and ModelNumStr for encrypted iPods.
 * 
 * Only certain iPod models require encryption setup:
 * - iPod Classic 6th/7th gen
 * - iPod Nano 3rd, 4th, 5th, 6th, 7th gen
 * 
 * These devices require both FirewireGuid AND ModelNumStr in SysInfo for libgpod
 * to generate the correct hash, otherwise songs won't appear on the iPod.
 */

export function createFirewireSetup({ log }) {
    const APPLE_VENDOR_ID = 0x05ac;

    /**
     * USB Product ID -> iPod model info mapping
     * Includes ALL iPod models for proper identification.
     * 
     * Source: https://www.the-sz.com/products/usbid/index.php?v=05ac
     * 
     * - `encrypted: true` means the device needs FirewireGuid for songs to appear
     * - `encrypted: false` means only ModelNumStr is needed for identification
     * 
     * ModelNumStr can be any valid model number for that generation.
     * We use one representative model number per generation.
     */
    const IPOD_MODELS = {
        // Classic iPods (non-encrypted)
        0x1201: { name: 'iPod 3rd Gen', modelNumStr: 'M8946', encrypted: false },
        0x1202: { name: 'iPod 2nd Gen', modelNumStr: 'M8513', encrypted: false },
        0x1203: { name: 'iPod 4th Gen (Grayscale)', modelNumStr: 'M9282', encrypted: false },
        0x1204: { name: 'iPod Photo/Color', modelNumStr: 'MA079', encrypted: false },
        0x1205: { name: 'iPod Mini', modelNumStr: 'M9160', encrypted: false },
        0x1209: { name: 'iPod Video (5th Gen)', modelNumStr: 'MA002', encrypted: false },
        
        // iPod Nano (non-encrypted)
        0x120A: { name: 'iPod Nano 1st Gen', modelNumStr: 'MA350', encrypted: false },
        0x1260: { name: 'iPod Nano 2nd Gen', modelNumStr: 'MA477', encrypted: false },
        
        // iPod Classic 6th/7th Gen (ENCRYPTED)
        0x1261: { name: 'iPod Classic 6th/7th Gen', modelNumStr: 'MB029', encrypted: true },
        
        // iPod Nano 3rd-7th Gen (ENCRYPTED)
        0x1262: { name: 'iPod Nano 3rd Gen', modelNumStr: 'MA978', encrypted: true },
        0x1263: { name: 'iPod Nano 4th Gen', modelNumStr: 'MB754', encrypted: true },
        0x1265: { name: 'iPod Nano 5th Gen', modelNumStr: 'MC031', encrypted: true, templateFile: '5_Nano_SysInfoExtended.plist' },
        0x1266: { name: 'iPod Nano 6th Gen', modelNumStr: 'MC525', encrypted: true },
        0x1267: { name: 'iPod Nano 7th Gen', modelNumStr: 'MD480', encrypted: true, templateFile: '7_nano_SysInfoExtended.plist' },
        
        // iPod Shuffle (non-encrypted, no database - but include for completeness)
        0x1300: { name: 'iPod Shuffle 1st Gen', modelNumStr: 'M9724', encrypted: false },
        0x1301: { name: 'iPod Shuffle 2nd Gen', modelNumStr: 'MA564', encrypted: false },
        0x1302: { name: 'iPod Shuffle 3rd Gen', modelNumStr: 'MB225', encrypted: false },
        0x1303: { name: 'iPod Shuffle 4th Gen', modelNumStr: 'MC749', encrypted: false },
    };

    // Model number prefix -> template file for devices that need a SysInfoExtended template.
    // Each prefix (first 5 chars of order number) maps to the plist template to use.
    const SYSINFO_EXTENDED_TEMPLATES = new Map([
        // Nano 5th Gen – 8 GB
        ['MC031', '5_Nano_SysInfoExtended.plist'],
        ['MC027', '5_Nano_SysInfoExtended.plist'],
        ['MC037', '5_Nano_SysInfoExtended.plist'],
        ['MC040', '5_Nano_SysInfoExtended.plist'],
        ['MC046', '5_Nano_SysInfoExtended.plist'],
        ['MC050', '5_Nano_SysInfoExtended.plist'],
        ['MC034', '5_Nano_SysInfoExtended.plist'],
        ['MC043', '5_Nano_SysInfoExtended.plist'],
        ['MC049', '5_Nano_SysInfoExtended.plist'],
        // Nano 5th Gen – 16 GB
        ['MC062', '5_Nano_SysInfoExtended.plist'],
        ['MC060', '5_Nano_SysInfoExtended.plist'],
        ['MC066', '5_Nano_SysInfoExtended.plist'],
        ['MC068', '5_Nano_SysInfoExtended.plist'],
        ['MC072', '5_Nano_SysInfoExtended.plist'],
        ['MC075', '5_Nano_SysInfoExtended.plist'],
        ['MC064', '5_Nano_SysInfoExtended.plist'],
        ['MC070', '5_Nano_SysInfoExtended.plist'],
        ['MC074', '5_Nano_SysInfoExtended.plist'],
        // Nano 7th Gen (2012)
        ['MD475', '7_nano_SysInfoExtended.plist'],  // Pink
        ['MD476', '7_nano_SysInfoExtended.plist'],  // Yellow
        ['MD477', '7_nano_SysInfoExtended.plist'],  // Blue
        ['MD478', '7_nano_SysInfoExtended.plist'],  // Green
        ['MD479', '7_nano_SysInfoExtended.plist'],  // Purple
        ['MD480', '7_nano_SysInfoExtended.plist'],  // Silver
        ['MD481', '7_nano_SysInfoExtended.plist'],  // Slate
        ['MD744', '7_nano_SysInfoExtended.plist'],  // (PRODUCT) RED
        ['ME971', '7_nano_SysInfoExtended.plist'],  // Space Gray (2013 Slate replacement)
        // Nano 7th Gen (2015 refresh)
        ['MKN02', '7_nano_SysInfoExtended.plist'],  // Blue
        ['MKN22', '7_nano_SysInfoExtended.plist'],  // Silver
        ['MKN52', '7_nano_SysInfoExtended.plist'],  // Space Gray
        ['MKN72', '7_nano_SysInfoExtended.plist'],  // (PRODUCT) RED
        ['MKMV2', '7_nano_SysInfoExtended.plist'],  // Hot Pink
        ['MKMX2', '7_nano_SysInfoExtended.plist'],  // Gold
    ]);

    // Store device info from WebUSB for later use
    let detectedDevice = null;
    // Cached FirewireGuid hex (set during checkFirewireGuid or performSetup)
    let firewireGuidHex = null;
    // Cached ModelNumStr (set during checkFirewireGuid or performSetup)
    let cachedModelNumStr = null;

    const HASHAB_MODEL_PREFIXES = new Set([
        // Nano 6th gen (representative)
        'MC525',
        // Nano 7th gen (2012)
        'MD475', 'MD476', 'MD477', 'MD478', 'MD479', 'MD480', 'MD481',
        'MD744', 'ME971',
        // Nano 7th gen (2015 refresh)
        'MKN02', 'MKN22', 'MKN52', 'MKN72', 'MKMV2', 'MKMX2',
    ]);

    /**
     * Check if this iPod model requires encryption (FirewireGuid)
     */
    function requiresEncryption(productId) {
        const model = IPOD_MODELS[productId];
        return model?.encrypted ?? false;
    }

    /**
     * Get model info for a product ID
     */
    function getModelInfo(productId) {
        return IPOD_MODELS[productId] || null;
    }

    /**
     * Check if this is a known iPod model
     */
    function isKnownModel(productId) {
        return productId in IPOD_MODELS;
    }

    /**
     * Returns the template filename if this model needs a SysInfoExtended template,
     * or null if it does not.
     */
    function getTemplateForModel(modelNumStr) {
        if (!modelNumStr) return null;
        const code = String(modelNumStr).trim().slice(0, 5).toUpperCase();
        return SYSINFO_EXTENDED_TEMPLATES.get(code) ?? null;
    }

    /**
     * Read SysInfo content from iPod
     */
    async function readSysInfo(ipodHandle) {
        try {
            const iPodControl = await ipodHandle.getDirectoryHandle('iPod_Control', { create: false });
            const deviceDir = await iPodControl.getDirectoryHandle('Device', { create: false });
            
            // Try SysInfo first, then SysInfoExtended
            for (const filename of ['SysInfo', 'SysInfoExtended']) {
                try {
                    const handle = await deviceDir.getFileHandle(filename, { create: false });
                    const file = await handle.getFile();
                    return await file.text();
                } catch (e) {
                    // File doesn't exist, try next
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async function ensureSysInfoExtended(ipodHandle, {
        firewireGuidHex,
        modelNumStr,
        productId,
    } = {}) {
        try {
            // Determine which template file this model needs (if any).
            let templateFile = getTemplateForModel(modelNumStr);
            if (!templateFile && productId) {
                templateFile = IPOD_MODELS[productId]?.templateFile ?? null;
            }
            if (!templateFile) return;

            const iPodControl = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
            const deviceDir = await iPodControl.getDirectoryHandle('Device', { create: true });

            // If SysInfoExtended already exists, nothing to do.
            try {
                await deviceDir.getFileHandle('SysInfoExtended', { create: false });
                return;
            } catch (_) {
                // missing -> we'll create it
            }

            // We need a FireWireGUID string without "0x" prefix.
            let fwHex = firewireGuidHex ? String(firewireGuidHex).trim() : '';
            if (fwHex.toLowerCase().startsWith('0x')) {
                fwHex = fwHex.slice(2);
            }
            if (!fwHex) {
                log?.('No FireWire GUID available for SysInfoExtended; skipping template write.', 'warning');
                return;
            }

            // Load the template plist from our bundled assets.
            let template;
            try {
                const url = new URL(`../device_info/${templateFile}`, import.meta.url);
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                template = await resp.text();
            } catch (e) {
                log?.(`Failed to load SysInfoExtended template (${templateFile}): ${e?.message || e}`, 'error');
                return;
            }

            // Replace the FireWireGUID field in the template.
            const replaced = template.replace("REPLACE_ME_WITH_FIREWIRE_GUID", fwHex);

            const sysInfoExtHandle = await deviceDir.getFileHandle('SysInfoExtended', { create: true });
            const writable = await sysInfoExtHandle.createWritable();
            await writable.write(replaced);
            await writable.close();

            log?.(`Wrote SysInfoExtended from ${templateFile}`, 'success');
        } catch (e) {
            log?.(`Failed to ensure SysInfoExtended: ${e?.message || e}`, 'warning');
        }
    }

    /**
     * Check if the iPod has been set up (ModelNumStr present in SysInfo).
     * 
     * ModelNumStr is our "stamp" indicating we've identified this iPod before.
     * For encrypted models, we also write FirewireGuid, but we only check for
     * ModelNumStr here since that's written for ALL models.
     * 
     * Note: Function name kept as checkFirewireGuid for backwards compatibility.
     */
    async function checkFirewireGuid(ipodHandle) {
        try {
            const sysInfoContent = await readSysInfo(ipodHandle);
            
            if (!sysInfoContent) {
                log('No SysInfo file found', 'info');
                return false;
            }

            const hasModelNumStr = sysInfoContent.includes('ModelNumStr');

            if (hasModelNumStr) {
                // Extract FirewireGuid and ModelNumStr for SysInfoExtended seeding.
                const lines = sysInfoContent.split('\n');
                let firewireLine = lines.find((l) => l.startsWith('FirewireGuid'));
                let modelLine = lines.find((l) => l.startsWith('ModelNumStr'));
                let fwGuid = '';
                let modelNumStr = '';

                if (firewireLine) {
                    const val = firewireLine.split(':')[1]?.trim() || '';
                    fwGuid = val.replace(/^0x/i, '');
                }
                if (fwGuid) firewireGuidHex = fwGuid;

                if (modelLine) {
                    modelNumStr = modelLine.split(':')[1]?.trim() || '';
                }
                if (modelNumStr) cachedModelNumStr = modelNumStr;

                await ensureSysInfoExtended(ipodHandle, {
                    firewireGuidHex: fwGuid,
                    modelNumStr,
                });

                log('ModelNumStr found in SysInfo - iPod already set up', 'success');
                return true;
            }

            log('SysInfo missing ModelNumStr - setup required', 'info');
            return false;
        } catch (e) {
            // iPod_Control/Device doesn't exist - might be older iPod or not an iPod
            log('Could not check SysInfo: ' + e.message, 'info');
            return true; // Assume OK if we can't check
        }
    }

    /**
     * Get device info from the iPod via WebUSB
     * Returns: { serialNumber, productId, productName, vendorName }
     */
    async function getDeviceViaWebUSB() {
        log('Requesting USB device access...', 'info');
        
        const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: APPLE_VENDOR_ID }]
        });

        const serialNumber = device.serialNumber;
        if (!serialNumber) {
            throw new Error('Could not get serial number from device');
        }

        detectedDevice = {
            serialNumber,
            productId: device.productId,
            productName: device.productName || 'Unknown',
            vendorName: device.manufacturerName || 'Apple',
        };

        const modelInfo = getModelInfo(device.productId);
        const modelDesc = modelInfo ? modelInfo.name : 'Unknown model';
        
        console.log('[FirewireSetup] Device info:', detectedDevice);
        log(`Detected: ${modelDesc} (serial: ${serialNumber})`, 'success');
        
        return detectedDevice;
    }

    /**
     * Legacy alias for getDeviceViaWebUSB (returns just serial number)
     */
    async function getSerialViaWebUSB() {
        const device = await getDeviceViaWebUSB();
        return device.serialNumber;
    }

    /**
     * Write FirewireGuid and ModelNumStr to SysInfo for all iPod models.
     * 
     * @param {FileSystemDirectoryHandle} ipodHandle - iPod root folder handle
     * @param {string} serialNumber - Device serial number for FirewireGuid
     * @param {number|null} productId - USB product ID (optional, uses detected device if null)
     */
    async function writeFirewireGuid(ipodHandle, serialNumber, productId = null) {
        if (!ipodHandle) {
            throw new Error('No iPod folder selected');
        }

        const pid = productId ?? detectedDevice?.productId;
        const modelInfo = pid ? getModelInfo(pid) : null;

        const iPodControl = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const deviceDir = await iPodControl.getDirectoryHandle('Device', { create: true });
        
        // Read existing SysInfo or create new
        let existingContent = '';
        try {
            const existingHandle = await deviceDir.getFileHandle('SysInfo', { create: false });
            const file = await existingHandle.getFile();
            existingContent = await file.text();
        } catch (e) {
            // File doesn't exist, that's OK
        }

        // Remove any existing FirewireGuid and ModelNumStr lines
        const lines = existingContent.split('\n').filter(line => 
            !line.startsWith('FirewireGuid') && !line.startsWith('ModelNumStr')
        );
        
        // Always add FirewireGuid
        const firewireGuidLine = `FirewireGuid: 0x${serialNumber}`;
        lines.push(firewireGuidLine);
        
        // Always add ModelNumStr
        const modelNumStr = modelInfo?.modelNumStr ?? 'UNKNOWN';
        const modelNumStrLine = `ModelNumStr: ${modelNumStr}`;
        lines.push(modelNumStrLine);
        
        if (modelInfo) {
            log(`Detected ${modelInfo.name}`, 'info');
        } else if (pid) {
            log(`Unknown iPod (product 0x${pid.toString(16)})`, 'warning');
        }
        
        const newContent = lines.filter(l => l.trim()).join('\n') + '\n';

        // Write the file
        const sysInfoHandle = await deviceDir.getFileHandle('SysInfo', { create: true });
        const writable = await sysInfoHandle.createWritable();
        await writable.write(newContent);
        await writable.close();

        console.log(`[FirewireSetup] Wrote SysInfo: ${firewireGuidLine}, ${modelNumStrLine}`);
        log(`Wrote FirewireGuid and ModelNumStr to SysInfo`, 'success');
    }

    /**
     * Full setup flow: get device info via WebUSB and write to SysInfo
     * 
     * - Always writes ModelNumStr for all models (our "stamp")
     * - Only writes FirewireGuid for encrypted models
     */
    async function performSetup(ipodHandle) {
        const device = await getDeviceViaWebUSB();
        firewireGuidHex = String(device.serialNumber || '').replace(/^0x/i, '');

        // Always write SysInfo - writeFirewireGuid handles what to include
        await writeFirewireGuid(ipodHandle, device.serialNumber, device.productId);

        const modelStr = getModelInfo(device.productId)?.modelNumStr;
        if (modelStr) cachedModelNumStr = modelStr;

        // If this model needs it, seed SysInfoExtended from our template.
        await ensureSysInfoExtended(ipodHandle, {
            firewireGuidHex: device.serialNumber,
            productId: device.productId,
            modelNumStr: modelStr,
        });
        
        return device.serialNumber;
    }

    return {
        checkFirewireGuid,
        getSerialViaWebUSB,
        getDeviceViaWebUSB,
        writeFirewireGuid,
        performSetup,
        requiresEncryption,
        isKnownModel,
        getModelInfo,
        getDetectedDevice: () => detectedDevice,
        getFirewireGuidHex: () => firewireGuidHex,
        needsHashAB: () => {
            const prefix = (cachedModelNumStr || '').slice(0, 5).toUpperCase();
            return HASHAB_MODEL_PREFIXES.has(prefix);
        },
    };
}
