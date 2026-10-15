// Incident report rules shared by the app (browser global) and Node tests.
// Validation mirrors the CHECK constraints in
// supabase/migrations/001_incidents_storage_realtime.sql.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchReport = factory();
})(this, function () {
    'use strict';

    var CATEGORIES = [
        { value: 'accident', label: 'Accident' },
        { value: 'fighting', label: 'Fighting' },
        { value: 'rioting', label: 'Rioting' },
        { value: 'fire', label: 'Fire' },
        { value: 'theft', label: 'Theft' },
        { value: 'other', label: 'Other' }
    ];

    var LIMITS = {
        TITLE_MIN: 3,
        TITLE_MAX: 120,
        DESCRIPTION_MIN: 10,
        DESCRIPTION_MAX: 2000,
        PHOTO_MAX_BYTES: 5 * 1024 * 1024,   // bucket file_size_limit
        PHOTO_MAX_DIMENSION: 1600            // longest side after resizing
    };

    var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];  // bucket allowed_mime_types

    // Characters as Postgres char_length() counts them (code points, so an
    // emoji counts as 1, unlike String.length).
    function charLength(text) {
        return Array.from(text).length;
    }

    // Parses a coordinate typed by the user. Returns a finite number or null.
    // Accepts "6.5244", " -3.5 ", "+3.5". Rejects "", "abc", "1,5" (ambiguous).
    function parseCoordinate(text) {
        if (typeof text === 'number') return isFinite(text) ? text : null;
        if (typeof text !== 'string') return null;
        var t = text.trim();
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
        var n = Number(t);
        return isFinite(n) ? n : null;
    }

    // Returns { ok, values, errors: { field: message } }.
    // values are exactly what is sent to the database (trimmed, numeric).
    function validateReport(input) {
        input = input || {};
        var errors = {};
        var title = typeof input.title === 'string' ? input.title.trim() : '';
        var description = typeof input.description === 'string' ? input.description.trim() : '';
        var category = typeof input.category === 'string' ? input.category : '';
        var latText = input.latitude == null ? '' : String(input.latitude).trim();
        var lngText = input.longitude == null ? '' : String(input.longitude).trim();
        var latitude = parseCoordinate(latText);
        var longitude = parseCoordinate(lngText);

        var titleLength = charLength(title);
        var descriptionLength = charLength(description);

        if (!title) errors.title = 'Enter a title.';
        else if (titleLength < LIMITS.TITLE_MIN) errors.title = 'Use at least ' + LIMITS.TITLE_MIN + ' characters.';
        else if (titleLength > LIMITS.TITLE_MAX) errors.title = 'Use at most ' + LIMITS.TITLE_MAX + ' characters.';

        if (!description) errors.description = 'Describe what happened.';
        else if (descriptionLength < LIMITS.DESCRIPTION_MIN) errors.description = 'Use at least ' + LIMITS.DESCRIPTION_MIN + ' characters.';
        else if (descriptionLength > LIMITS.DESCRIPTION_MAX) errors.description = 'Use at most ' + LIMITS.DESCRIPTION_MAX + ' characters.';

        if (!CATEGORIES.some(function (c) { return c.value === category; })) errors.category = 'Choose a category.';

        if (!latText && !lngText) {
            errors.location = 'Add the incident location: use your location or enter coordinates.';
        } else if (latitude === null || longitude === null) {
            errors.location = 'Enter latitude and longitude as decimal numbers, e.g. 6.5244 and 3.3792.';
        } else if (latitude < -90 || latitude > 90) {
            errors.location = 'Latitude must be between -90 and 90.';
        } else if (longitude < -180 || longitude > 180) {
            errors.location = 'Longitude must be between -180 and 180.';
        }

        var source = input.locationSource === 'gps' ? 'gps' : 'manual';
        return {
            ok: Object.keys(errors).length === 0,
            errors: errors,
            values: {
                title: title,
                description: description,
                category: category,
                latitude: latitude,
                longitude: longitude,
                location_source: source
            }
        };
    }

    // Largest size that fits inside maxSide x maxSide with the same aspect
    // ratio. Never upscales.
    function fitWithin(width, height, maxSide) {
        var scale = Math.min(1, maxSide / Math.max(width, height));
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
        };
    }

    // W3C GeolocationPositionError codes.
    function describeGeoError(error) {
        var code = error && error.code;
        if (code === 1) return 'Location permission was denied. Allow location access for CivicWatch in your settings, or enter the coordinates below.';
        if (code === 2) return 'Your location is not available. Check that location services are on, or enter the coordinates below.';
        if (code === 3) return 'Finding your location took too long. Try again, or enter the coordinates below.';
        return 'Your location could not be found. Enter the coordinates below.';
    }

    function formatAccuracy(metres) {
        if (!isFinite(metres)) return '';
        return metres >= 1000 ? '±' + (metres / 1000).toFixed(1) + ' km' : '±' + Math.round(metres) + ' m';
    }

    // cordova-plugin-camera reports cancellation as an error string.
    function isCameraCancel(message) {
        return /no image selected|cancel|did not complete/i.test(String(message || ''));
    }

    function categoryLabel(value) {
        for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].value === value) return CATEGORIES[i].label;
        return value;
    }

    return {
        CATEGORIES: CATEGORIES,
        LIMITS: LIMITS,
        PHOTO_TYPES: PHOTO_TYPES,
        parseCoordinate: parseCoordinate,
        validateReport: validateReport,
        fitWithin: fitWithin,
        describeGeoError: describeGeoError,
        formatAccuracy: formatAccuracy,
        isCameraCancel: isCameraCancel,
        categoryLabel: categoryLabel,
        charLength: charLength
    };
});
