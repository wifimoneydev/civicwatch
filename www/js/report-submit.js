// Uploads the (optional) photo, then creates the incident report.
// Works with any supabase-js client, so tests can pass a fake one.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchReportSubmit = factory();
})(this, function () {
    'use strict';

    var BUCKET = 'incident-photos';
    var COLUMNS = 'id, user_id, title, category, latitude, longitude, location_source, photo_path, verification_status, created_at';
    var NETWORK = /Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed/i;

    function randomId() {
        var c = (typeof crypto !== 'undefined') ? crypto : null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        var bytes = new Uint8Array(16);
        c.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    // A failure where the request may still have reached the database.
    function isAmbiguous(error) {
        return !error || !error.code || NETWORK.test(error.message || '');
    }

    // After an ambiguous failure, look for the report we tried to create.
    // Resolves to the row, null (definitely not saved) or undefined (unknown).
    async function findSaved(client, userId, values, photoPath, startedAt) {
        try {
            var q = client.from('incidents').select(COLUMNS).eq('user_id', userId);
            q = photoPath
                ? q.eq('photo_path', photoPath)
                : q.eq('title', values.title).eq('description', values.description).gte('created_at', startedAt);
            var res = await q.limit(1);
            if (res.error) return undefined;
            return (res.data && res.data[0]) || null;
        } catch (e) {
            return undefined;
        }
    }

    // options: { userId, values (from validateReport), photo: { blob } | null, onProgress(stage) }
    // Resolves to { ok: true, report } or
    //             { ok: false, stage: 'upload' | 'save', error, status, photoCleanup: 'removed' | 'kept' | 'none' }
    async function submitReport(client, options) {
        var userId = options && options.userId;
        if (!userId) throw new Error('submitReport requires the signed-in user id');
        var values = options.values;
        var progress = options.onProgress || function () {};
        var photoPath = null;
        var startedAt = new Date(Date.now() - 60 * 1000).toISOString();

        if (options.photo) {
            progress('upload');
            photoPath = userId + '/' + randomId() + '.jpg';
            var upload;
            try {
                upload = await client.storage.from(BUCKET).upload(photoPath, options.photo.blob, {
                    contentType: 'image/jpeg',
                    cacheControl: '3600',
                    upsert: false
                });
            } catch (e) {
                upload = { error: e };
            }
            if (upload.error) {
                var uploadStatus = Number(upload.error.status || upload.error.statusCode) || undefined;
                return { ok: false, stage: 'upload', error: upload.error, status: uploadStatus, photoCleanup: 'none' };
            }
        }

        progress('save');
        var insert;
        try {
            insert = await client.from('incidents').insert({
                user_id: userId,
                title: values.title,
                description: values.description,
                category: values.category,
                latitude: values.latitude,
                longitude: values.longitude,
                location_source: values.location_source,
                photo_path: photoPath
            }).select(COLUMNS).single();
        } catch (e) {
            insert = { data: null, error: e };
        }

        if (!insert.error && insert.data) return { ok: true, report: insert.data, photoPath: photoPath };

        // The save failed or its result is unknown.
        var saved = isAmbiguous(insert.error)
            ? await findSaved(client, userId, values, photoPath, startedAt)
            : null;
        if (saved) return { ok: true, report: saved, photoPath: photoPath, recovered: true };

        var photoCleanup = 'none';
        if (photoPath) {
            // Delete the orphaned photo only when we know no report uses it:
            // the server rejected the insert, or the lookup found no report.
            // If the outcome is unknown (saved === undefined) keep the photo.
            photoCleanup = 'kept';
            if (saved === null) {
                try {
                    var removed = await client.storage.from(BUCKET).remove([photoPath]);
                    if (!removed.error) photoCleanup = 'removed';
                } catch (e) { /* leave it; nothing references it */ }
            }
        }
        return { ok: false, stage: 'save', error: insert.error, status: insert.status, photoPath: photoPath, photoCleanup: photoCleanup };
    }

    return { submitReport: submitReport, BUCKET: BUCKET };
});
