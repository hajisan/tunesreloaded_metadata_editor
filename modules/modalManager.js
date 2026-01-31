/**
 * Modal Manager - Generic show/hide helpers for modal dialogs
 */

export function createModalManager() {
    function show(modalId) {
        document.getElementById(modalId)?.classList.add('show');
    }

    function hide(modalId) {
        document.getElementById(modalId)?.classList.remove('show');
    }

    function isVisible(modalId) {
        return document.getElementById(modalId)?.classList.contains('show') ?? false;
    }

    // Convenience methods for specific modals
    const modals = {
        upload: 'uploadModal',
        newPlaylist: 'newPlaylistModal',
        firewireSetup: 'firewireSetupModal',
    };

    return {
        show,
        hide,
        isVisible,
        // Shorthand methods
        showUpload: () => show(modals.upload),
        hideUpload: () => hide(modals.upload),
        showNewPlaylist: () => show(modals.newPlaylist),
        hideNewPlaylist: () => hide(modals.newPlaylist),
        showFirewireSetup: () => show(modals.firewireSetup),
        hideFirewireSetup: () => hide(modals.firewireSetup),
    };
}
