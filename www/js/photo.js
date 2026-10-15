// Photo capture and preparation.
// Every photo, whether from the Android camera/gallery (cordova-plugin-camera)
// or a browser file input, is redrawn on a canvas: scaled to fit 1600 px
// (aspect ratio kept, never upscaled) and re-encoded as JPEG. Re-encoding also
// drops embedded metadata such as EXIF GPS tags.
(function () {
    'use strict';

    var R = window.CivicWatchReport;
    var QUALITIES = [0.85, 0.75, 0.65, 0.5];

    function loadImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('unreadable')); };
            img.src = src;
        });
    }

    function toBlob(canvas, quality) {
        return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
    }

    function userError(message) {
        var e = new Error(message);
        e.userFacing = true;
        return e;
    }

    // source: a File/Blob (browser) or a data: URL (camera plugin).
    // Resolves to { blob, previewUrl, width, height }.
    async function prepare(source) {
        if (source && typeof source !== 'string' && source.type && !/^image\//.test(source.type)) {
            throw userError('That file is not an image. Choose a JPEG, PNG or WebP photo.');
        }
        var url = typeof source === 'string' ? source : URL.createObjectURL(source);
        var img;
        try {
            img = await loadImage(url);
        } catch (e) {
            throw userError('This image could not be opened. Choose a JPEG, PNG or WebP photo.');
        } finally {
            if (typeof source !== 'string') URL.revokeObjectURL(url);
        }

        var size = R.fitWithin(img.naturalWidth, img.naturalHeight, R.LIMITS.PHOTO_MAX_DIMENSION);
        var canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // transparent PNG areas would otherwise turn black
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(img, 0, 0, size.width, size.height);

        var blob = null;
        for (var i = 0; i < QUALITIES.length; i++) {
            blob = await toBlob(canvas, QUALITIES[i]);
            if (blob && blob.size <= R.LIMITS.PHOTO_MAX_BYTES) break;
        }
        if (!blob) throw userError('This image could not be processed. Try another photo.');
        if (blob.size > R.LIMITS.PHOTO_MAX_BYTES) throw userError('This photo is too large even after resizing. Try another photo.');

        return { blob: blob, previewUrl: URL.createObjectURL(blob), width: size.width, height: size.height };
    }

    function nativeAvailable() {
        return !!(window.cordova && navigator.camera && window.Camera);
    }

    // Opens the Android camera (fromCamera) or photo picker via
    // cordova-plugin-camera. Resolves to a data: URL, or null if cancelled.
    function captureNative(fromCamera) {
        return new Promise(function (resolve, reject) {
            navigator.camera.getPicture(function (base64) {
                resolve('data:image/jpeg;base64,' + base64);
            }, function (message) {
                if (R.isCameraCancel(message)) resolve(null);
                else reject(userError(/permission/i.test(String(message))
                    ? 'Camera access was denied. Allow it in your settings, or choose an existing photo.'
                    : 'The photo could not be loaded (' + message + ').'));
            }, {
                quality: 85,
                destinationType: window.Camera.DestinationType.DATA_URL,
                sourceType: fromCamera ? window.Camera.PictureSourceType.CAMERA : window.Camera.PictureSourceType.PHOTOLIBRARY,
                encodingType: window.Camera.EncodingType.JPEG,
                mediaType: window.Camera.MediaType.PICTURE,
                // Downscale natively first so a 12+ MP photo never has to be
                // held in memory as a base64 string.
                targetWidth: R.LIMITS.PHOTO_MAX_DIMENSION,
                targetHeight: R.LIMITS.PHOTO_MAX_DIMENSION,
                correctOrientation: true,
                saveToPhotoAlbum: false
            });
        });
    }

    window.CivicWatchPhoto = { prepare: prepare, nativeAvailable: nativeAvailable, captureNative: captureNative };
})();
