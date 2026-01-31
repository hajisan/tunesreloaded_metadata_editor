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
     * Only includes models that require encryption (FirewireGuid + ModelNumStr)
     * 
     * Source: https://www.the-sz.com/products/usbid/index.php?v=05ac
     * 
     * ModelNumStr can be any valid model number for that generation.
     * We use one representative model number per generation.
     */
    const ENCRYPTED_IPOD_MODELS = {
        0x1261: { name: 'iPod Classic 6th/7th Gen', modelNumStr: 'MB029' },  // 80GB Classic
        0x1262: { name: 'iPod Nano 3rd Gen', modelNumStr: 'MA978' },
        0x1263: { name: 'iPod Nano 4th Gen', modelNumStr: 'MB754' },
        0x1265: { name: 'iPod Nano 5th Gen', modelNumStr: 'MC031' },
        0x1266: { name: 'iPod Nano 6th Gen', modelNumStr: 'MC525' },
        0x1267: { name: 'iPod Nano 7th Gen', modelNumStr: 'MD480' },
    };

    // Store device info from WebUSB for later use
    let detectedDevice = null;

    /**
     * Check if this iPod model requires encryption setup
     */
    function requiresEncryption(productId) {
        return productId in ENCRYPTED_IPOD_MODELS;
    }

    /**
     * Get model info for a product ID
     */
    function getModelInfo(productId) {
        return ENCRYPTED_IPOD_MODELS[productId] || null;
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

    /**
     * Check if the iPod has both FirewireGuid AND ModelNumStr in SysInfo
     * Both are required for encrypted iPod models to work with libgpod.
     */
    async function checkFirewireGuid(ipodHandle) {
        try {
            const sysInfoContent = await readSysInfo(ipodHandle);
            
            if (!sysInfoContent) {
                log('No SysInfo file found', 'info');
                return false;
            }

            const hasFirewireGuid = sysInfoContent.includes('FirewireGuid');
            const hasModelNumStr = sysInfoContent.includes('ModelNumStr');

            if (hasFirewireGuid && hasModelNumStr) {
                log('FirewireGuid and ModelNumStr found in SysInfo', 'success');
                return true;
            }

            if (hasFirewireGuid && !hasModelNumStr) {
                log('SysInfo has FirewireGuid but missing ModelNumStr', 'info');
                return false;
            }

            if (!hasFirewireGuid && hasModelNumStr) {
                log('SysInfo has ModelNumStr but missing FirewireGuid', 'info');
                return false;
            }

            log('SysInfo missing both FirewireGuid and ModelNumStr', 'info');
            return false;
        } catch (e) {
            // iPod_Control/Device doesn't exist - might be older iPod or not an iPod
            log('Could not check SysInfo: ' + e.message, 'info');
            return true; // Assume OK for older iPods that don't need encryption
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
     * Write FirewireGuid and ModelNumStr to the SysInfo file
     * 
     * @param {FileSystemDirectoryHandle} ipodHandle - iPod root folder handle
     * @param {string} serialNumber - Device serial number for FirewireGuid
     * @param {number|null} productId - USB product ID (optional, uses detected device if null)
     */
    async function writeFirewireGuid(ipodHandle, serialNumber, productId = null) {
        if (!ipodHandle) {
            throw new Error('No iPod folder selected');
        }

        // Use detected device's product ID if not provided
        const pid = productId ?? detectedDevice?.productId;
        const modelInfo = pid ? getModelInfo(pid) : null;

        const iPodControl = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const deviceDir = await iPodControl.getDirectoryHandle('Device', { create: true });
        
        // Read existing SysInfo or create new
        let existingContent = '';
        let isNewFile = true;
        try {
            const existingHandle = await deviceDir.getFileHandle('SysInfo', { create: false });
            const file = await existingHandle.getFile();
            existingContent = await file.text();
            isNewFile = false;
        } catch (e) {
            // File doesn't exist, that's OK
        }

        // Remove any existing FirewireGuid and ModelNumStr lines
        const lines = existingContent.split('\n').filter(line => 
            !line.startsWith('FirewireGuid') && !line.startsWith('ModelNumStr')
        );
        
        // Add FirewireGuid
        const firewireGuidLine = `FirewireGuid: 0x${serialNumber}`;
        lines.push(firewireGuidLine);
        
        // Add ModelNumStr if this is an encrypted iPod model
        let modelNumStrLine = null;
        if (modelInfo) {
            modelNumStrLine = `ModelNumStr: ${modelInfo.modelNumStr}`;
            lines.push(modelNumStrLine);
            log(`Detected ${modelInfo.name}, using ModelNumStr: ${modelInfo.modelNumStr}`, 'info');
        } else if (pid) {
            log(`Unknown product ID 0x${pid.toString(16)} - skipping ModelNumStr`, 'warning');
        }
        
        const newContent = lines.filter(l => l.trim()).join('\n') + '\n';

        // Write the file
        const sysInfoHandle = await deviceDir.getFileHandle('SysInfo', { create: true });
        const writable = await sysInfoHandle.createWritable();
        await writable.write(newContent);
        await writable.close();

        const action = isNewFile ? 'Created' : 'Modified';
        console.log(`[FirewireSetup] ${action} SysInfo file at iPod_Control/Device/SysInfo`);
        console.log(`[FirewireSetup] Added: ${firewireGuidLine}`);
        if (modelNumStrLine) {
            console.log(`[FirewireSetup] Added: ${modelNumStrLine}`);
        }
        log(`Wrote FirewireGuid and ModelNumStr to SysInfo`, 'success');
    }

    /**
     * Full setup flow: get device info via WebUSB and write to SysInfo
     * Automatically detects iPod model and writes appropriate ModelNumStr
     */
    async function performSetup(ipodHandle) {
        const device = await getDeviceViaWebUSB();
        
        // Check if this model needs encryption setup
        if (!requiresEncryption(device.productId)) {
            const productHex = device.productId.toString(16).toUpperCase();
            log(`iPod (product 0x${productHex}) does not require encryption setup`, 'info');
            return device.serialNumber;
        }
        
        await writeFirewireGuid(ipodHandle, device.serialNumber, device.productId);
        return device.serialNumber;
    }

    return {
        checkFirewireGuid,
        getSerialViaWebUSB,
        getDeviceViaWebUSB,
        writeFirewireGuid,
        performSetup,
        requiresEncryption,
        getModelInfo,
        getDetectedDevice: () => detectedDevice,
    };
}
