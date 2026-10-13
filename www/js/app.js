(function () {
    'use strict';

    function mark(id, ok, text) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = ok ? 'ok' : 'fail';
    }

    function runChecks(isCordova) {
        mark('chk-ready', isCordova, isCordova ? 'fired' : 'not running in Cordova (browser)');
        mark('chk-platform', true, (window.cordova && window.cordova.platformId) || 'browser');
        mark('chk-camera', !!navigator.camera, navigator.camera ? 'available' : 'not available');
        mark('chk-geo', 'geolocation' in navigator, 'geolocation' in navigator ? 'available' : 'not available');
    }

    document.addEventListener('deviceready', function () { runChecks(true); }, false);

    // In a plain browser cordova.js 404s and deviceready never fires.
    window.addEventListener('load', function () {
        if (!window.cordova) runChecks(false);
    });
})();
