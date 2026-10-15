// "Report an incident" screen: form state, location, photo and submission.
// app.js calls init() once and reset() on logout.
(function () {
    'use strict';

    var R = window.CivicWatchReport;
    var Photo = window.CivicWatchPhoto;
    var $ = function (id) { return document.getElementById(id); };
    var FIELDS = ['title', 'category', 'description', 'location', 'photo'];

    var deps = null;
    var state = {
        locationSource: 'manual',
        photo: null,          // { blob, previewUrl, width, height }
        busy: {},             // submit | locate | photo
        generation: 0         // bumped by reset() so late callbacks are ignored
    };

    function setText(id, text) { $(id).textContent = text || ''; }

    function showErrors(errors) {
        FIELDS.forEach(function (f) {
            setText('report-' + f + '-error', errors[f]);
            var input = f === 'location' ? $('report-latitude') : f === 'photo' ? null : $('report-' + f);
            if (input) input.setAttribute('aria-invalid', errors[f] ? 'true' : 'false');
        });
        if (errors.location) $('report-longitude').setAttribute('aria-invalid', 'true');
        else $('report-longitude').setAttribute('aria-invalid', 'false');
    }

    function focusFirstError(errors) {
        var first = FIELDS.filter(function (f) { return errors[f]; })[0];
        if (!first) return;
        var target = first === 'location' ? $('report-latitude') : first === 'photo' ? $('report-photo-library') : $('report-' + first);
        target.focus();
    }

    function setSubmitting(busy) {
        state.busy.submit = busy;
        var button = $('report-submit');
        button.disabled = busy;
        button.textContent = busy ? 'Submitting…' : 'Submit report';
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        Array.prototype.forEach.call($('form-report').elements, function (el) {
            if (el !== button) el.disabled = busy;
        });
        if (!busy) setText('report-progress', '');
    }

    function formatBytes(n) {
        return n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    }

    // ------------------------------------------------------------ location

    function useMyLocation() {
        if (state.busy.locate) return;
        setText('report-location-error', '');
        if (!navigator.geolocation) {
            setText('report-location-status', 'Location is not available on this device. Enter the coordinates below.');
            return;
        }
        var generation = state.generation;
        state.busy.locate = true;
        $('report-locate').disabled = true;
        $('report-locate').textContent = 'Finding your location…';
        setText('report-location-status', '');

        function done() {
            state.busy.locate = false;
            $('report-locate').disabled = !!state.busy.submit;
            $('report-locate').textContent = 'Use my location';
        }

        navigator.geolocation.getCurrentPosition(function (position) {
            if (generation !== state.generation) return;
            done();
            var c = position.coords;
            $('report-latitude').value = c.latitude.toFixed(6);
            $('report-longitude').value = c.longitude.toFixed(6);
            state.locationSource = 'gps';
            var accuracy = R.formatAccuracy(c.accuracy);
            setText('report-location-status', c.accuracy > 1000
                ? 'Location found, but it is imprecise (' + accuracy + '). Check the coordinates before submitting.'
                : 'Location found' + (accuracy ? ' (' + accuracy + ')' : '') + '.');
        }, function (error) {
            if (generation !== state.generation) return;
            done();
            setText('report-location-status', R.describeGeoError(error));
        }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }

    function onCoordinateEdited() {
        // Coordinates typed or changed by hand are no longer a GPS fix.
        state.locationSource = 'manual';
        setText('report-location-status', '');
    }

    // ------------------------------------------------------------ photo

    function showPhoto(photo) {
        if (state.photo) URL.revokeObjectURL(state.photo.previewUrl);
        state.photo = photo;
        $('report-photo-img').src = photo.previewUrl;
        $('report-photo-img').setAttribute('data-width', photo.width);
        $('report-photo-img').setAttribute('data-height', photo.height);
        setText('report-photo-meta', photo.width + ' × ' + photo.height + ' px · ' + formatBytes(photo.blob.size) + ' JPEG');
        $('report-photo-preview').hidden = false;
        $('report-photo-pick').hidden = true;
    }

    function removePhoto() {
        if (state.photo) URL.revokeObjectURL(state.photo.previewUrl);
        state.photo = null;
        $('report-photo-img').removeAttribute('src');
        $('report-photo-preview').hidden = true;
        $('report-photo-pick').hidden = false;
        setText('report-photo-meta', '');
        setText('report-photo-status', '');
        setText('report-photo-error', '');
    }

    function processPhoto(source) {
        var generation = state.generation;
        state.busy.photo = true;
        setText('report-photo-error', '');
        setText('report-photo-status', 'Preparing photo…');
        return Photo.prepare(source).then(function (photo) {
            if (generation !== state.generation) { URL.revokeObjectURL(photo.previewUrl); return; }
            showPhoto(photo);
            setText('report-photo-status', '');
        }, function (error) {
            if (generation !== state.generation) return;
            setText('report-photo-status', '');
            setText('report-photo-error', error.userFacing ? error.message : 'This photo could not be used. Try another one.');
        }).then(function () { state.busy.photo = false; });
    }

    function pickPhoto(fromCamera) {
        if (state.busy.photo || state.busy.submit) return;
        if (Photo.nativeAvailable()) {
            var generation = state.generation;
            Photo.captureNative(fromCamera).then(function (dataUrl) {
                if (generation !== state.generation || !dataUrl) return; // cancelled: keep current photo
                processPhoto(dataUrl);
            }, function (error) {
                if (generation !== state.generation) return;
                setText('report-photo-error', error.message);
            });
            return;
        }
        // Browser: file inputs (capture opens the camera on mobile browsers).
        var input = fromCamera ? $('report-photo-capture') : $('report-photo-input');
        input.value = '';
        input.click();
    }

    function onFileChosen(event) {
        var file = event.target.files && event.target.files[0];
        if (file) processPhoto(file); // no file = cancelled
    }

    // ------------------------------------------------------------ submit

    function readForm() {
        return {
            title: $('report-title').value,
            description: $('report-description').value,
            category: $('report-category').value,
            latitude: $('report-latitude').value,
            longitude: $('report-longitude').value,
            locationSource: state.locationSource
        };
    }

    function failureMessage(result) {
        var offline = deps.isNetworkError(result.error);
        if (result.stage === 'upload') {
            return offline
                ? "The photo couldn't be uploaded because the connection failed. Your report has not been sent. Try again."
                : 'The photo could not be uploaded (' + (result.error.message || 'unknown error') + '). Your report has not been sent.';
        }
        return offline
            ? "Your report couldn't be saved because the connection failed. Your details are still here. Try again."
            : 'Your report could not be saved (' + (result.error && result.error.message || 'unknown error') + '). Your details are still here.';
    }

    function onSubmit(event) {
        event.preventDefault();
        if (state.busy.submit) return;
        setText('report-error', '');
        if (state.busy.photo) {
            setText('report-error', 'Please wait until the photo is ready.');
            return;
        }
        var check = R.validateReport(readForm());
        showErrors(check.errors);
        if (!check.ok) { focusFirstError(check.errors); return; }
        if (navigator.onLine === false) {
            setText('report-error', "You're offline. Connect to the internet and try again. Your details are still here.");
            return;
        }
        var user = deps.getUser();
        if (!user) { deps.onSessionExpired(); return; }

        var generation = state.generation;
        setSubmitting(true);
        window.CivicWatchReportSubmit.submitReport(deps.client, {
            userId: user.id,
            values: check.values,
            photo: state.photo,
            onProgress: function (stage) {
                setText('report-progress', stage === 'upload' ? 'Uploading photo…' : 'Saving report…');
            }
        }).then(function (result) {
            if (generation !== state.generation) return; // logged out meanwhile
            setSubmitting(false);
            if (result.ok) {
                reset();
                deps.onSubmitted(result.report);
                return;
            }
            if (deps.isExpiredError(result.error, result.status)) {
                deps.onSessionExpired();
                return;
            }
            setText('report-error', failureMessage(result));
        }, function (error) {
            if (generation !== state.generation) return;
            setSubmitting(false);
            setText('report-error', 'Something went wrong (' + error.message + '). Your details are still here.');
        });
    }

    // ------------------------------------------------------------ public

    function reset() {
        state.generation += 1;
        state.busy = {};
        state.locationSource = 'manual';
        $('form-report').reset();
        removePhoto();
        showErrors({});
        ['report-error', 'report-progress', 'report-location-status'].forEach(function (id) { setText(id, ''); });
        $('report-locate').textContent = 'Use my location';
        $('report-submit').textContent = 'Submit report';
        Array.prototype.forEach.call($('form-report').elements, function (el) { el.disabled = false; });
    }

    // deps: { client, getUser(), onSubmitted(report), onSessionExpired(),
    //         isNetworkError(err), isExpiredError(err, status) }
    function init(dependencies) {
        deps = dependencies;
        var select = $('report-category');
        R.CATEGORIES.forEach(function (c) {
            var option = document.createElement('option');
            option.value = c.value;
            option.textContent = c.label;
            select.appendChild(option);
        });
        $('form-report').addEventListener('submit', onSubmit);
        $('report-locate').addEventListener('click', useMyLocation);
        $('report-latitude').addEventListener('input', onCoordinateEdited);
        $('report-longitude').addEventListener('input', onCoordinateEdited);
        $('report-photo-camera').addEventListener('click', function () { pickPhoto(true); });
        $('report-photo-library').addEventListener('click', function () { pickPhoto(false); });
        $('report-photo-input').addEventListener('change', onFileChosen);
        $('report-photo-capture').addEventListener('change', onFileChosen);
        $('report-photo-replace').addEventListener('click', function () { $('report-photo-pick').hidden = false; });
        $('report-photo-remove').addEventListener('click', removePhoto);
        // Clear a field's error as soon as the user edits it.
        [['report-title', 'title'], ['report-category', 'category'], ['report-description', 'description'],
            ['report-latitude', 'location'], ['report-longitude', 'location']].forEach(function (pair) {
            $(pair[0]).addEventListener(pair[0] === 'report-category' ? 'change' : 'input', function () {
                setText('report-' + pair[1] + '-error', '');
                $(pair[0]).setAttribute('aria-invalid', 'false');
                if (pair[1] === 'location') {
                    $('report-latitude').setAttribute('aria-invalid', 'false');
                    $('report-longitude').setAttribute('aria-invalid', 'false');
                }
            });
        });
    }

    window.CivicWatchReportView = { init: init, reset: reset };
})();
