// Data access for the My Reports screen.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchMyReports = factory();
})(this, function () {
    'use strict';

    var COLUMNS = 'id, user_id, title, category, latitude, longitude, location_source, photo_path, verification_status, created_at';

    // Every signed-in user may browse all reports (RLS), so "my" reports are
    // selected by filtering on the current user's id. Rows belonging to anyone
    // else are dropped as a second line of defence.
    async function fetchMyReports(client, userId) {
        if (!userId) throw new Error('fetchMyReports requires the signed-in user id');
        var res = await client
            .from('incidents')
            .select(COLUMNS)
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (res.error) return { rows: [], error: res.error, status: res.status };
        var rows = (res.data || []).filter(function (row) { return row.user_id === userId; });
        return { rows: rows, error: null, status: res.status };
    }

    return { fetchMyReports: fetchMyReports };
});
