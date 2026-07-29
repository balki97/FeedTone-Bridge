(function () {
    'use strict';
    if (window.__feedToneMixBridgeLoaded) return;
    window.__feedToneMixBridgeLoaded = true;

    const REQUESTER = 'feedtone_bridge';
    const originals = new Map();
    const manualOverrides = new Set();
    const ownWrites = new Map();
    const ownWriteUntil = new Map();
    let activeToken = 0;
    let activeContext = '';
    let openCommandBusy = false;
    let lastOpenCommand = '';
    const syncedRigs = new Map();
    const stagedToneProfiles = new Map();
    const stagedTonePresets = new Map();
    const stagedToneLists = new Map();
    let activeToneContext = '';
    let lastHighwayIdentity = '';
    let lastNativePresetIdentity = '';
    let lastKnownTarget = {};
    let lastLiveRevision = '';
    let lastLiveChainRevision = '';
    let lastLiveMixerRevision = '';
    let livePreviewBusy = false;
    let feedbackPlaying = false;
    let lastPlaybackPublish = '';
    let playbackPublishBusy = false;
    let mixerReadbackBusy = false;
    let mixerWriteTail = Promise.resolve();
    let mixerWriteBusy = false;
    let applyBusy = false;
    let pendingApplyEvent = null;
    let latestMixerSnapshot = {};
    let controlBusy = false;
    let lastControlNonce = '';
    let openGate = null;
    window.__feedToneBridgeStatus = { state: 'waiting', tone: '', profile: '', updatedAt: 0 };

    function normalise(value) {
        return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function filenameOnly(value) {
        const parts = String(value || '').replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || '';
    }

    function loadingOverlay() {
        let overlay = document.getElementById('feedtone-loading-gate');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'feedtone-loading-gate';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647',
            'display:none', 'align-items:center', 'justify-content:center',
            'background:rgba(7,9,12,.96)', 'color:#f4f5f7',
            'font:600 22px/1.4 system-ui,sans-serif', 'text-align:center',
        ].join(';');
        overlay.innerHTML = '<div><div data-feedtone-message>Loading FeedTone tones…</div><div style="margin-top:10px;color:#9ca7b5;font-size:13px;font-weight:400">Playback will start when the rig and mixer are ready.</div></div>';
        document.body.appendChild(overlay);
        return overlay;
    }

    function showLoadingGate(message) {
        const overlay = loadingOverlay();
        const label = overlay.querySelector('[data-feedtone-message]');
        if (label) label.textContent = message || 'Loading FeedTone tones…';
        overlay.style.display = 'flex';
    }

    function hideLoadingGate() {
        const overlay = document.getElementById('feedtone-loading-gate');
        if (overlay) overlay.style.display = 'none';
    }

    function claimOpenGate(event) {
        if (!openGate || openGate.release) return;
        const target = eventTarget(event);
        const incoming = filenameOnly(decodeURIComponent(String(target.filename || '')));
        if (incoming && normalise(incoming) !== normalise(filenameOnly(openGate.filename))) return;
        const hold = window.feedBack && window.feedBack.holdAutoplay;
        if (typeof hold !== 'function') return;
        openGate.release = hold();
        if (openGate.release && typeof openGate.release.settle === 'function') openGate.release.settle();
    }

    async function command(name, payload) {
        const api = window.feedBack && window.feedBack.capabilities;
        if (api && typeof api.command === 'function') {
            return api.command('audio-mix', name, {
                requester: REQUESTER,
                origin: 'plugin',
                payload: payload || {},
                timeoutMs: 2100,
            });
        }
        const session = window.feedBack && window.feedBack.audioSession;
        if (!session) return { outcome: 'no-owner' };
        if (name === 'list-faders') return session.listFaders();
        if (name === 'get-fader-value') return session.getFaderValue(payload || {});
        if (name === 'set-fader-value') return session.setFaderValue(payload || {});
        return { outcome: 'unsupported-command' };
    }

    function faderKey(fader) {
        return fader.faderKey || `${fader.participantId}:${fader.faderId || fader.id}`;
    }

    function profileTargetKey(fader) {
        const id = String(fader.faderId || fader.id || '').toLowerCase();
        const participant = String(fader.participantId || '').toLowerCase();
        if (id === 'song' && participant === 'core.song') return 'song';
        if (id === 'rig_builder_amp' && participant === 'fader.rig_builder_amp') return 'amp';
        if (id === 'rig_builder_desktop_input' && participant === 'fader.rig_builder_desktop_input') return 'input';
        if (id === 'nam' && participant === 'fader.nam') return 'nam';
        if (id === 'chain-gain' && participant === 'audio_engine.chain_gain') return 'monitor';
        return '';
    }

    function chainUsesNam(pieces) {
        return Array.isArray(pieces) && pieces.some(piece => piece && !piece.bypassed
            && (piece.kind === 'nam' || piece.kind === 'nam_fullchain' || Number(piece.type) === 1));
    }

    function exactProfileTarget(fader, profile, pieces) {
        const enabled = new Set(Array.isArray(profile.automate) ? profile.automate : ['song', 'monitor', 'input', 'amp', 'nam']);
        const key = profileTargetKey(fader);
        if (enabled.has('song') && key === 'song') {
            return { key, name: 'Song', value: profile.song_percent };
        }
        // These are deliberately exact IDs. FeedBack exposes both Desktop
        // Input and Rig Builder Input; matching the label "Input" can drive the
        // wrong stage and was the source of visually plausible, incorrect mix.
        if (enabled.has('amp') && key === 'amp') {
            const usesNam = chainUsesNam(pieces);
            const namDb = usesNam && enabled.has('nam')
                ? 20 * Math.log10(Math.max(.0001, Number(profile.nam_output ?? 1))) : 0;
            return { key, keys: usesNam ? ['amp', 'nam'] : ['amp'], name: usesNam ? 'AMP + NAM' : 'AMP', value: Number(profile.amp_db ?? 0) + namDb };
        }
        if (enabled.has('input') && key === 'input') {
            return { key, name: 'Input', value: profile.input_db };
        }
        // A NAM inside Rig Builder is part of its MegaChain, not the separate
        // NAM Tone plugin exposed by fader.nam. Its output is folded into AMP
        // above; writing fader.nam changes a different audio graph.
        // FeedTone's Monitor is the final live-guitar multiplier. FeedBack's
        // equivalent is the native Desktop Chain fader, whose public unit is dB.
        if (enabled.has('monitor') && key === 'monitor') {
            const linear = Math.max(Math.pow(10, -24 / 20), Number(profile.monitor ?? .8));
            return { key, name: 'Desktop Chain', value: Math.max(-24, Math.min(12, 20 * Math.log10(linear))) };
        }
        return undefined;
    }

    function quantizeForFader(fader, value) {
        const minimum = Number.isFinite(Number(fader.min)) ? Number(fader.min) : -Infinity;
        const maximum = Number.isFinite(Number(fader.max)) ? Number(fader.max) : Infinity;
        const step = Number(fader.step);
        let result = Math.max(minimum, Math.min(maximum, Number(value)));
        if (Number.isFinite(step) && step > 0 && Number.isFinite(minimum)) {
            result = minimum + Math.round((result - minimum) / step) * step;
            result = Math.max(minimum, Math.min(maximum, result));
        }
        return Number(result.toFixed(6));
    }

    async function syncRig(filename) {
        const key = String(filename || '').toLowerCase();
        if (!key) return;
        let staged;
        try {
            const response = await fetch(`/api/plugins/feedtone_bridge/rig-sync?filename=${encodeURIComponent(filename)}`, { cache: 'no-store' });
            staged = await response.json();
        } catch (_) { return; }
        if (!staged || !staged.matched || !Array.isArray(staged.presets)) return;
        const revision = String(staged.revision || 'legacy');
        if (syncedRigs.get(key) === revision) return;
        // Remove the previous in-memory profile snapshot for this exact file.
        // Otherwise a newly saved tone could update the native preset while
        // the mixer still applied the values captured on the first open.
        for (const profileKey of Array.from(stagedToneProfiles.keys())) {
            if (profileKey.startsWith(`${key}|`)) stagedToneProfiles.delete(profileKey);
        }
        for (const presetKey of Array.from(stagedTonePresets.keys())) {
            if (presetKey.startsWith(`${key}|`)) stagedTonePresets.delete(presetKey);
        }
        for (const listKey of Array.from(stagedToneLists.keys())) {
            if (listKey.startsWith(`${key}|`)) stagedToneLists.delete(listKey);
        }
        let wroteNativePresets = false;
        for (const preset of staged.presets) {
            if (preset && preset.tone_key && preset.mixer) {
                const file = String(filename || '').toLowerCase();
                const arrangement = String(preset.feedtone_arrangement || '').toLowerCase();
                const tone = String(preset.tone_key || '').toLowerCase();
                stagedToneProfiles.set(`${file}|${arrangement}|${tone}`, preset.mixer);
                stagedToneProfiles.set(`${file}||${tone}`, preset.mixer);
                stagedToneProfiles.set(`${file}|${arrangement}|${normalise(tone)}`, preset.mixer);
                stagedToneProfiles.set(`${file}||${normalise(tone)}`, preset.mixer);
                stagedTonePresets.set(`${file}|${arrangement}|${tone}`, preset);
                stagedTonePresets.set(`${file}||${tone}`, preset);
                stagedTonePresets.set(`${file}|${arrangement}|${normalise(tone)}`, preset);
                stagedTonePresets.set(`${file}||${normalise(tone)}`, preset);
                const listKey = `${file}|${arrangement}`;
                const list = stagedToneLists.get(listKey) || [];
                list.push({
                    toneKey: String(preset.tone_key),
                    sourceTone: String(preset.feedtone_source_tone_key || ''),
                    mixer: preset.mixer,
                });
                stagedToneLists.set(listKey, list);
            }
            if (!staged.native_persisted) {
                try {
                    const response = await fetch('/api/plugins/rig_builder/save_preset', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preset),
                    });
                    if (!response.ok) return;
                    wroteNativePresets = true;
                } catch (_) { return; }
            }
        }
        syncedRigs.set(key, revision);
        // Re-announce the loaded song only after every native preset is
        // committed. Rig Builder intentionally waits 600 ms before building;
        // this guarantees its first build sees the new mappings instead of
        // loading Default and requiring the user to reopen the song.
        if (wroteNativePresets) {
            setTimeout(() => {
                const bus = window.slopsmith || window.feedBack;
                if (bus && typeof bus.emit === 'function') {
                    try { bus.emit('song:loaded', { ...(window.feedBack?.currentSong || {}), filename }); } catch (_) {}
                }
            }, 50);
        }
    }

    function beginOwnWrite(key) {
        ownWrites.set(key, (ownWrites.get(key) || 0) + 1);
        // FeedBack publishes the committed fader event after the command
        // promise resolves. Keep a short grace window so our own write is not
        // mistaken for a manual user override.
        ownWriteUntil.set(key, Date.now() + 2500);
    }
    function endOwnWrite(key) {
        const remaining = (ownWrites.get(key) || 1) - 1;
        if (remaining > 0) ownWrites.set(key, remaining); else ownWrites.delete(key);
    }

    async function setFader(fader, value, remember, force) {
        const key = faderKey(fader);
        if (force) manualOverrides.delete(key);
        if (!force && manualOverrides.has(key)) return { outcome: 'overridden' };
        const payload = { participantId: fader.participantId, faderId: fader.faderId || fader.id };
        if (remember && !originals.has(key)) {
            const current = await command('get-fader-value', payload);
            const committed = current && current.payload && (current.payload.committedValue ?? current.payload.currentValue);
            if (Number.isFinite(Number(committed))) originals.set(key, { fader, value: Number(committed) });
        }
        beginOwnWrite(key);
        try { return await command('set-fader-value', { ...payload, value: Number(value) }); }
        finally { endOwnWrite(key); }
    }

    async function applyNativeAudioTarget(target, expected, pieces) {
        if (target.key === 'input' && typeof window.rbSetDesktopInput === 'function') {
            await window.rbSetDesktopInput(expected);
            if (typeof window.rbApplyChainInputDrive === 'function') await window.rbApplyChainInputDrive();
        }
        if (target.key !== 'amp' || typeof window.rbSetChainMakeup !== 'function') return;
        await window.rbSetChainMakeup(expected);
        const bypassedLeveler = Array.isArray(pieces) && pieces.some(piece => piece && piece.bypassed
            && String(piece.rs_gear_type || '').includes('__rb_final_leveler__'));
        if (!bypassedLeveler) return;
        const base = typeof window.__rbChainBaseTarget === 'number' ? window.__rbChainBaseTarget : 1;
        const linear = base * Math.pow(10, expected / 20);
        let handled = false;
        if (typeof window.rbSetRouteGainsWithHost === 'function') {
            handled = await window.rbSetRouteGainsWithHost({ chain: linear }, 'feedtone-amp');
        }
        if (!handled && typeof window.rbAudioApi === 'function') {
            const audio = window.rbAudioApi();
            if (audio && typeof audio.setGain === 'function') await audio.setGain('chain', linear);
        }
    }

    async function setAndVerifyFader(fader, target, remember, force, pieces) {
        const expected = quantizeForFader(fader, target.value);
        const write = await setFader(fader, expected, remember, force);
        if (write && write.outcome === 'overridden') {
            return { target: target.name, expected, verified: false, outcome: 'manual-override' };
        }
        await applyNativeAudioTarget(target, expected, pieces);
        const payload = { participantId: fader.participantId, faderId: fader.faderId || fader.id };
        const read = await command('get-fader-value', payload);
        const body = read && read.payload ? read.payload : {};
        const committed = Number(body.committedValue ?? body.currentValue ?? body.value);
        const step = Number(fader.step);
        const tolerance = Number.isFinite(step) && step > 0 ? step / 2 + 0.0001 : 0.0001;
        return {
            target: target.name,
            keys: target.keys || [target.key],
            expected,
            committed: Number.isFinite(committed) ? committed : null,
            verified: Number.isFinite(committed) && Math.abs(committed - expected) <= tolerance,
            outcome: read && read.outcome ? read.outcome : 'read-back',
        };
    }

    function onFaderChanged(event) {
        const detail = (event && event.detail) || event || {};
        const key = faderKey(detail);
        if (!key || ownWrites.has(key) || Date.now() < (ownWriteUntil.get(key) || 0)) return;
        // A mixer move made outside this bridge wins for the current song. It
        // is also removed from restoration so stopping cannot undo the user.
        manualOverrides.add(key);
        originals.delete(key);
        setTimeout(readMixerSnapshot, 30);
    }

    function queueMixerWrite(work) {
        const run = async () => {
            mixerWriteBusy = true;
            try { return await work(); }
            finally { mixerWriteBusy = false; }
        };
        const next = mixerWriteTail.then(run, run);
        mixerWriteTail = next.catch(() => {});
        return next;
    }

    async function applyLiveMixer(profile, requestedTargets, force = true, pieces = []) {
        return queueMixerWrite(async () => {
            const targets = new Set(Array.isArray(requestedTargets) ? requestedTargets.map(String) : []);
            const listed = await command('list-faders');
            const faders = listed && listed.payload && Array.isArray(listed.payload.faders) ? listed.payload.faders : [];
            const results = [];
            // Rig Builder persists Input and AMP through the same settings
            // service. Commit one fader at a time so those writes cannot race.
            for (const fader of faders) {
                const target = exactProfileTarget(fader, profile || {}, pieces);
                if (!target || !Number.isFinite(Number(target.value))) continue;
                const targetKeys = target.keys || [target.key];
                if (targets.size && !targetKeys.some(key => targets.has(key))) continue;
                try { results.push(await setAndVerifyFader(fader, target, true, force, pieces)); }
                catch (error) { results.push({ target: target.name, verified: false, outcome: String(error) }); }
            }
            return { faders, results };
        });
    }

    async function readMixerSnapshot() {
        if (mixerReadbackBusy || mixerWriteBusy || ownWrites.size) return;
        mixerReadbackBusy = true;
        try {
            const listed = await command('list-faders');
            const faders = listed && listed.payload && Array.isArray(listed.payload.faders) ? listed.payload.faders : [];
            const next = {};
            await Promise.all(faders.map(async fader => {
                const key = profileTargetKey(fader);
                if (!key) return;
                const read = await command('get-fader-value', { participantId: fader.participantId, faderId: fader.faderId || fader.id });
                const body = read && read.payload ? read.payload : {};
                const committed = Number(body.committedValue ?? body.currentValue ?? body.value);
                if (!Number.isFinite(committed)) return;
                if (key === 'song') next.song_percent = committed;
                else if (key === 'monitor') next.monitor = Math.pow(10, committed / 20);
                else if (key === 'input') next.input_db = committed;
                else if (key === 'amp') next.amp_db = committed;
                else if (key === 'nam') next.nam_output = committed;
            }));
            if (Object.keys(next).length) latestMixerSnapshot = next;
        } catch (_) {
        } finally {
            mixerReadbackBusy = false;
        }
    }

    function liveSongMatches(value) {
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const display = current.localDisplay || current.display || {};
        const currentTitle = normalise(display.title || current.title || '');
        const currentArtist = normalise(display.artist || current.artist || '');
        const wantedTitle = normalise(value.song || '');
        const wantedArtist = normalise(value.artist || '');
        const currentFile = normalise(current.filename || current.file || '');
        const targetFile = normalise(value.target_filename || '');
        if (currentFile && targetFile && currentFile !== targetFile) return false;
        if (currentTitle && wantedTitle && currentTitle !== wantedTitle) return false;
        if (currentArtist && wantedArtist && currentArtist !== wantedArtist) return false;
        return Boolean(currentTitle || currentArtist || current.filename || current.file);
    }

    async function loadNativePreset(presetId) {
        const response = await fetch(`/api/plugins/rig_builder/native_preset_full/${presetId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`native_preset_full returned ${response.status}`);
        const payload = await response.json();
        if (!payload || !payload.native_preset) throw new Error('Rig Builder returned no native preset');
        delete payload.id;
        const api = (typeof rbAudioApi === 'function' ? rbAudioApi() : null)
            || (window.feedBackDesktop && window.feedBackDesktop.audio)
            || (window.slopsmithDesktop && window.slopsmithDesktop.audio);
        if (!api) throw new Error('Rig Builder audio API is unavailable');
        if (typeof rbLoadNativePresetPayload === 'function') {
            await rbLoadNativePresetPayload(api, payload, { mode: 'preview', authorization: 'user-action' });
            if (typeof rbStudioFinishMonitorLoad === 'function') {
                try { await rbStudioFinishMonitorLoad(api, payload.native_preset.chain); } catch (_) {}
            }
        } else {
            if (typeof api.clearChain === 'function') await api.clearChain();
            await api.loadPreset(JSON.stringify(payload.native_preset));
        }
    }

    async function loadLivePreset(preset) {
        const saved = await fetch('/api/plugins/rig_builder/save_preset', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preset),
        });
        if (!saved.ok) throw new Error(`save_preset returned ${saved.status}`);
        const savedBody = await saved.json();
        const presetId = Number(savedBody.preset_id);
        if (!Number.isFinite(presetId)) throw new Error('save_preset did not return a preset id');
        await loadNativePreset(presetId);
        lastNativePresetIdentity = '';
    }

    function megaChainState() {
        try {
            return window.RbMegaChain && typeof window.RbMegaChain.state === 'function'
                ? window.RbMegaChain.state() : null;
        } catch (_) { return null; }
    }

    function missingStagedTones(filename, arrangement) {
        const expected = new Set();
        try {
            const base = window.highway && window.highway.getToneBase ? window.highway.getToneBase() : '';
            if (base) expected.add(normalise(base));
            const changes = window.highway && window.highway.getToneChanges ? window.highway.getToneChanges() : [];
            if (Array.isArray(changes)) changes.forEach(change => change && change.name && expected.add(normalise(change.name)));
        } catch (_) {}
        const available = new Set((stagedToneLists.get(`${String(filename).toLowerCase()}|${String(arrangement).toLowerCase()}`) || [])
            .map(item => normalise(item.toneKey)));
        return Array.from(expected).filter(tone => tone && !available.has(tone));
    }

    async function waitForRigReady(filename, arrangement) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const state = megaChainState();
            if (state && state.failed) throw new Error(state.error || 'Rig Builder failed to load the song chain');
            if (state && state.active && !state.pending && state.activeToneKey
                && normalise(filenameOnly(state.filename)) === normalise(filenameOnly(filename))) {
                const missing = missingStagedTones(filename, arrangement);
                if (missing.length) throw new Error(`Missing staged tones: ${missing.join(', ')}`);
                return state;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new Error('Rig Builder did not confirm the complete song chain');
    }

    function rememberLiveMixer(value) {
        const file = String(value.target_filename || '').toLowerCase();
        const arrangement = String(value.arrangement || '').toLowerCase();
        const sourceTone = normalise(value.source_tone);
        const mixer = value.preset && value.preset.mixer;
        if (!file || !sourceTone || !mixer) return;
        for (const [key, preset] of stagedTonePresets) {
            if (!key.startsWith(`${file}|`) || !preset || !preset.mixer) continue;
            if (arrangement && String(preset.feedtone_arrangement || '').toLowerCase() !== arrangement) continue;
            if (normalise(preset.feedtone_source_tone_key) !== sourceTone) continue;
            Object.assign(preset.mixer, mixer);
        }
    }

    async function pollLivePreview() {
        if (livePreviewBusy) return;
        livePreviewBusy = true;
        try {
            const response = await fetch('/api/plugins/feedtone_bridge/live', { cache: 'no-store' });
            const value = await response.json();
            if (!value || !value.active || !value.preset || !liveSongMatches(value)) return;
            const revision = String(value.revision || '');
            if (!revision || revision === lastLiveRevision) return;
            const chainChanged = String(value.chain_revision || '') !== lastLiveChainRevision;
            if (chainChanged) {
                const mega = megaChainState();
                // The complete song chain already contains every saved tone.
                // Loading the one-tone scratch preset here destroys that chain
                // and makes later sections clean, stale, or silent.
                if (!mega || (!mega.active && !mega.pending)) await loadLivePreset(value.preset);
                lastLiveChainRevision = String(value.chain_revision || '');
            }
            let mixerResults = [];
            if (String(value.mixer_revision || '') !== lastLiveMixerRevision || revision !== lastLiveRevision) {
                mixerResults = (await applyLiveMixer(value.preset.mixer || {}, chainChanged ? [] : value.mixer_targets, true, value.preset.pieces || [])).results;
                rememberLiveMixer(value);
                lastLiveMixerRevision = String(value.mixer_revision || '');
            }
            await readMixerSnapshot();
            lastLiveRevision = revision;
            window.__feedToneBridgeStatus = {
                state: 'live-preview', tone: value.source_tone || '', profile: 'FeedTone live',
                arrangement: value.arrangement || '', updatedAt: Date.now(), results: mixerResults,
            };
        } catch (error) {
            window.__feedToneBridgeStatus = { state: 'live-preview-error', error: String(error), updatedAt: Date.now() };
        } finally {
            livePreviewBusy = false;
        }
    }

    async function restore() {
        activeToken += 1;
        activeContext = '';
        activeToneContext = '';
        lastHighwayIdentity = '';
        const saved = Array.from(originals.entries());
        originals.clear();
        await queueMixerWrite(async () => {
            for (const [key, item] of saved) {
                if (manualOverrides.has(key)) continue;
                try { await setFader(item.fader, item.value, false); } catch (_) {}
            }
        });
        manualOverrides.clear();
    }

    function eventTarget(event) {
        const detail = (event && event.detail) || event || {};
        return detail.target || detail;
    }

    function contextFor(target, display, current) {
        return [
            target.filename || current.filename || current.file || '',
            display.arrangement || current.arrangementName || current.arrangement || target.arrangementRef || '',
            display.title || current.title || '',
            display.artist || current.artist || '',
        ].map(value => String(value || '').toLowerCase()).join('|');
    }

    function toneFor(target, display, current) {
        return String(
            target.toneKey || target.tone_key || target.tone || target.name ||
            display.toneKey || display.tone_key || display.tone ||
            current.toneKey || current.tone_key || current.tone || ''
        );
    }

    async function apply(event) {
        if (applyBusy) {
            pendingApplyEvent = event;
            return;
        }
        applyBusy = true;
        try {
            await applyNow(event);
        } finally {
            applyBusy = false;
            const next = pendingApplyEvent;
            pendingApplyEvent = null;
            if (next) setTimeout(() => apply(next), 0);
        }
    }

    async function applyNow(event) {
        const token = ++activeToken;
        const target = eventTarget(event);
        if (target && Object.keys(target).length) lastKnownTarget = { ...lastKnownTarget, ...target };
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const display = target.localDisplay || target.display || {};
        const context = contextFor(target, display, current);
        const filename = target.filename || current.filename || current.file || '';
        await syncRig(filename);
        if (context && context !== activeContext) {
            activeContext = context;
            manualOverrides.clear();
        }
        const arrangement = display.arrangement || current.arrangementName || current.arrangement || target.arrangementRef || '';
        // Song/playback callbacks do not include a tone name. Resolve it from
        // the authoritative highway so a delayed hydration retry cannot
        // overwrite the active tone's profile with an arrangement-wide one.
        const tone = toneFor(target, display, current) || resolveHighwayTone();
        const toneContext = `${context}|${normalise(tone)}`;
        if (toneContext && toneContext !== activeToneContext) {
            activeToneContext = toneContext;
            // A manual in-game move belongs to the tone where it was made. It
            // must not prevent the authored values for the next tone section.
            manualOverrides.clear();
        }
        const query = new URLSearchParams({
            filename,
            // localDisplay keeps the real label (Lead/Rhythm/Bass); the
            // capability arrangementRef is intentionally pseudonymized.
            arrangement,
            tone,
            settings_key: target.settingsKey || '',
            title: display.title || current.title || '',
            artist: display.artist || current.artist || '',
        });
        let match;
        const fileKey = String(filename).toLowerCase();
        const arrangementKey = String(arrangement).toLowerCase();
        const toneKey = String(tone).toLowerCase();
        const direct = stagedToneProfiles.get(`${fileKey}|${arrangementKey}|${toneKey}`)
            || stagedToneProfiles.get(`${fileKey}|${arrangementKey}|${normalise(toneKey)}`)
            || stagedToneProfiles.get(`${fileKey}||${toneKey}`)
            || stagedToneProfiles.get(`${fileKey}||${normalise(toneKey)}`);
        const stagedPreset = stagedTonePresets.get(`${fileKey}|${arrangementKey}|${toneKey}`)
            || stagedTonePresets.get(`${fileKey}|${arrangementKey}|${normalise(toneKey)}`)
            || stagedTonePresets.get(`${fileKey}||${toneKey}`)
            || stagedTonePresets.get(`${fileKey}||${normalise(toneKey)}`);
        const presetId = Number(stagedPreset && stagedPreset.native_preset_id);
        const presetIdentity = `${fileKey}|${arrangementKey}|${normalise(toneKey)}|${presetId}`;
        // Rig Builder owns section-to-section switching. Loading the same
        // preset here as well rebuilds the graph at the tone boundary, causing
        // clicks, late transitions and occasionally a stale clean chain.
        // Explicit loading is only needed while the initial open gate is held.
        const mega = megaChainState();
        if (openGate && (!mega || (!mega.active && !mega.pending))
            && Number.isFinite(presetId) && presetIdentity !== lastNativePresetIdentity) {
            try {
                await loadNativePreset(presetId);
                if (token !== activeToken) return;
                lastNativePresetIdentity = presetIdentity;
            } catch (error) {
                window.__feedToneBridgeStatus = {
                    state: 'native-preset-load-failed', tone, presetId,
                    error: String(error && error.message || error), updatedAt: Date.now(),
                };
                return;
            }
        }
        if (direct) match = { matched: true, profile: direct };
        else {
            try {
                const response = await fetch(`/api/plugins/feedtone_bridge/profile?${query.toString()}`);
                match = await response.json();
            } catch (_) { return; }
        }
        if (token !== activeToken || !match || !match.matched) {
            window.__feedToneBridgeStatus = { state: 'no-profile', tone, profile: '', updatedAt: Date.now() };
            return;
        }
        const activeProfile = match.profile || {};
        const requested = new Set(Array.isArray(activeProfile.automate) ? activeProfile.automate : ['song', 'monitor', 'input', 'amp', 'nam']);
        const pieces = stagedPreset && Array.isArray(stagedPreset.pieces) ? stagedPreset.pieces : [];
        const applied = await applyLiveMixer(activeProfile, Array.from(requested), false, pieces);
        const faders = applied.faders;
        const results = applied.results;
        const represented = new Set(results.flatMap(result => result.keys || []));
        const missing = Array.from(requested).filter(key => key !== 'nam' || chainUsesNam(pieces)).filter(key => !represented.has(key));
        const failed = results.filter(result => !result.verified);
        const status = {
            state: failed.length || missing.length ? 'verification-failed' : 'verified',
            tone, profile: direct ? 'staged-tone' : 'saved-profile', arrangement, filename,
            updatedAt: Date.now(), faderCount: faders.length, results, missing,
        };
        window.__feedToneBridgeStatus = status;
        return status;
    }

    function applyWithHydrationRetry(event) {
        if (openGate) return;
        apply(event);
        // Rig Builder registers AMP after its own song-load work. Re-check once
        // after hydration; a user move made in the meantime remains protected.
        setTimeout(() => apply(event), 700);
    }

    function resolveHighwayTone() {
        try {
            const highway = window.highway;
            if (!highway || typeof highway.getTime !== 'function') return '';
            const time = Number(highway.getTime() || 0);
            const changes = typeof highway.getToneChanges === 'function' ? highway.getToneChanges() : [];
            let tone = typeof highway.getToneBase === 'function' ? String(highway.getToneBase() || '') : '';
            if (Array.isArray(changes)) {
                for (const change of changes) {
                    if (change && Number(change.t || 0) <= time + 0.015) tone = String(change.name || '');
                }
                if (!tone && changes[0]) tone = String(changes[0].name || '');
            }
            return tone;
        } catch (_) { return ''; }
    }

    function pollHighwayTone() {
        if (openGate) return;
        const tone = resolveHighwayTone();
        if (!tone) return;
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const source = { ...lastKnownTarget, ...current };
        const filename = source.filename || source.file || '';
        const arrangement = source.arrangementName || source.arrangement || source.arrangementRef || '';
        const identity = `${String(filename).toLowerCase()}|${String(arrangement).toLowerCase()}|${normalise(tone)}`;
        if (!filename || identity === lastHighwayIdentity) return;
        lastHighwayIdentity = identity;
        const event = { detail: {
            ...source, filename, toneKey: tone,
            localDisplay: { ...(source.localDisplay || {}), arrangement },
        } };
        apply(event);
        // Native Rig Builder can briefly make AMP/NAM pending while switching
        // its chain. Re-apply after hydration without waiting for another tone.
        setTimeout(() => {
            if (lastHighwayIdentity === identity) apply(event);
        }, 420);
    }

    function sourceToneFor(filename, arrangement, nativeTone) {
        const file = String(filename || '').toLowerCase();
        const arrangementKey = String(arrangement || '').toLowerCase();
        const wanted = normalise(nativeTone);
        const candidates = stagedToneLists.get(`${file}|${arrangementKey}`) || [];
        const match = candidates.find(item => normalise(item.toneKey) === wanted);
        return match ? String(match.sourceTone || '') : '';
    }

    async function publishPlaybackContext() {
        if (playbackPublishBusy) return;
        const highway = window.highway;
        if (!highway || typeof highway.getTime !== 'function') return;
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const source = { ...lastKnownTarget, ...current };
        const display = source.localDisplay || source.display || {};
        const filename = source.filename || source.file || '';
        if (!filename) return;
        const arrangement = display.arrangement || source.arrangementName || source.arrangement || source.arrangementRef || '';
        const tone = resolveHighwayTone();
        const positionMs = Math.max(0, Math.round(Number(highway.getTime() || 0) * 1000));
        const payload = {
            filename,
            title: display.title || source.title || '',
            artist: display.artist || source.artist || '',
            arrangement,
            tone,
            source_tone: sourceToneFor(filename, arrangement, tone),
            position_ms: positionMs,
            playing: feedbackPlaying,
            mixer: latestMixerSnapshot,
        };
        // At 10 Hz this is responsive enough for region selection without
        // turning a local state file into an audio-rate telemetry stream.
        const identity = `${filename}|${arrangement}|${tone}|${Math.floor(positionMs / 100)}|${feedbackPlaying}|${JSON.stringify(latestMixerSnapshot)}`;
        if (identity === lastPlaybackPublish) return;
        lastPlaybackPublish = identity;
        playbackPublishBusy = true;
        try {
            await fetch('/api/plugins/feedtone_bridge/playback', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });
        } catch (_) {
            lastPlaybackPublish = '';
        } finally {
            playbackPublishBusy = false;
        }
    }

    function bridgeContext() {
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const source = { ...lastKnownTarget, ...current };
        const display = source.localDisplay || source.display || {};
        const arrangements = Array.isArray(current.arrangements) ? current.arrangements : [];
        const arrangementIndex = current.arrangementIndex ?? current.arrangement_index ?? '';
        const selected = arrangements.find(item => String(item.index) === String(arrangementIndex)) || {};
        return {
            filename: source.filename || source.file || '',
            title: display.title || source.title || '',
            artist: display.artist || source.artist || '',
            arrangement: display.arrangement || source.arrangementSmartName || selected.smart_name || selected.name || source.arrangementName || source.arrangement || source.arrangementRef || '',
            arrangementIndex,
            arrangements: arrangements.map(item => ({ index: item.index, name: String(item.smart_name || item.name || `Arrangement ${item.index}`) })),
        };
    }

    function arrangementAliases(context) {
        const current = (window.feedBack && window.feedBack.currentSong) || {};
        const selected = (Array.isArray(current.arrangements) ? current.arrangements : [])
            .find(item => String(item.index) === String(context.arrangementIndex));
        return [context.arrangement, current.arrangementSmartName, current.arrangement, selected && selected.smart_name, selected && selected.name]
            .map(value => String(value || '').toLowerCase()).filter((value, index, values) => value && values.indexOf(value) === index);
    }

    function stagedTonesFor(context) {
        const file = String(context.filename || '').toLowerCase();
        for (const arrangement of arrangementAliases(context)) {
            const tones = stagedToneLists.get(`${file}|${arrangement}`);
            if (tones && tones.length) return tones;
        }
        return [];
    }

    function stagedPresetFor(context, tone) {
        const file = String(context.filename || '').toLowerCase();
        const key = String(tone || '').toLowerCase();
        for (const arrangement of arrangementAliases(context)) {
            const preset = stagedTonePresets.get(`${file}|${arrangement}|${key}`)
                || stagedTonePresets.get(`${file}|${arrangement}|${normalise(key)}`);
            if (preset) return preset;
        }
        return stagedTonePresets.get(`${file}||${key}`) || stagedTonePresets.get(`${file}||${normalise(key)}`);
    }

    function bridgePanelState() {
        const context = bridgeContext();
        const mega = megaChainState() || {};
        const activeTone = String((window.RbMegaChain && window.RbMegaChain.forcedToneKey && window.RbMegaChain.forcedToneKey()) || resolveHighwayTone() || mega.activeToneKey || '');
        const nativeTones = window.RbMegaChain && typeof window.RbMegaChain.getTones === 'function' ? window.RbMegaChain.getTones() : [];
        const staged = stagedTonesFor(context);
        const seen = new Set();
        const tones = [...nativeTones.map(item => ({ key: String(item.tone_key), name: String(item.name || item.tone_key) })),
            ...staged.map(item => ({ key: String(item.toneKey), name: String(item.sourceTone || item.toneKey) }))]
            .filter(item => item.key && !seen.has(normalise(item.key)) && seen.add(normalise(item.key)));
        const preset = stagedPresetFor(context, activeTone);
        return {
            ...context, activeTone, tones, mixer: { ...(preset && preset.mixer || {}), ...latestMixerSnapshot },
            forcedTone: window.RbMegaChain && window.RbMegaChain.forcedToneKey ? String(window.RbMegaChain.forcedToneKey() || '') : '',
            namAvailable: chainUsesNam(preset && preset.pieces),
            status: { ...(window.__feedToneBridgeStatus || {}) },
        };
    }

    async function forcePanelTone(tone) {
        const context = bridgeContext();
        await syncRig(context.filename);
        if (!window.RbMegaChain || typeof window.RbMegaChain.forceToneByKey !== 'function') throw new Error('Rig Builder tone control is unavailable');
        let selected = await window.RbMegaChain.forceToneByKey(tone);
        if (!selected && typeof window.RbMegaChain.getTones === 'function' && typeof window.RbMegaChain.forceToneByIndex === 'function') {
            const index = window.RbMegaChain.getTones().findIndex(item => normalise(item.tone_key) === normalise(tone) || normalise(item.name) === normalise(tone));
            if (index >= 0) selected = await window.RbMegaChain.forceToneByIndex(index);
        }
        if (!selected) throw new Error('The selected tone is not loaded for this song');
        lastHighwayIdentity = '';
        await apply({ detail: { ...context, filename: context.filename, toneKey: tone, localDisplay: { title: context.title, artist: context.artist, arrangement: context.arrangement } } });
        return bridgePanelState();
    }

    async function followPanelTimeline() {
        if (window.RbMegaChain && typeof window.RbMegaChain.clearForcedTone === 'function') await window.RbMegaChain.clearForcedTone();
        lastHighwayIdentity = '';
        pollHighwayTone();
        return bridgePanelState();
    }

    async function selectPanelArrangement(index) {
        const state = bridgePanelState();
        const target = state.arrangements.find(item => String(item.index) === String(index));
        if (!target) throw new Error('The selected arrangement is unavailable');
        if (typeof window.changeArrangement === 'function') await Promise.resolve(window.changeArrangement(target.index));
        else {
            const selector = document.getElementById('arr-select');
            if (!selector) throw new Error('FeedBack arrangement control is unavailable');
            selector.value = String(target.index);
            selector.dispatchEvent(new Event('change', { bubbles: true }));
        }
        lastHighwayIdentity = '';
        return bridgePanelState();
    }

    async function setPanelMixer(key, value) {
        const fields = { song: 'song_percent', monitor: 'monitor', input: 'input_db', amp: 'amp_db', nam: 'nam_output' };
        if (!fields[key]) throw new Error('Unknown mixer control');
        const state = bridgePanelState();
        const preset = stagedPresetFor(state, state.activeTone);
        const profile = { song_percent: 65, monitor: 1, input_db: 0, amp_db: 0, nam_output: 1, ...(preset && preset.mixer || {}), ...latestMixerSnapshot };
        profile[fields[key]] = Number(value);
        const result = await applyLiveMixer(profile, [key], true, preset && preset.pieces || []);
        if (preset) Object.assign(preset.mixer || (preset.mixer = {}), profile);
        await readMixerSnapshot();
        window.__feedToneBridgeStatus = { state: result.results.every(item => item.verified) ? 'verified' : 'verification-failed', tone: state.activeTone, arrangement: state.arrangement, filename: state.filename, profile: 'FeedTone panel', updatedAt: Date.now(), results: result.results };
        return bridgePanelState();
    }

    async function savePanelMixer() {
        const state = bridgePanelState();
        const response = await fetch('/api/plugins/feedtone_bridge/mix', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: state.filename, title: state.title, artist: state.artist, arrangement: state.arrangement, tone: state.activeTone, mixer: state.mixer }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.reason || `Save returned ${response.status}`);
        return result;
    }

    window.FeedToneBridge = { state: bridgePanelState, forceTone: forcePanelTone, selectArrangement: selectPanelArrangement, followTimeline: followPanelTimeline, setMixer: setPanelMixer, saveMixer: savePanelMixer };

    function registerBridgeScreen() {
        const nav = window.slopsmith && window.slopsmith.uiNavigation;
        if (!nav || typeof nav.registerScreen !== 'function') return;
        nav.registerScreen({ pluginId: REQUESTER, screenId: 'plugin-feedtone_bridge', label: 'FeedTone', lifecyclePolicy: 'mounted-hidden', compatibilityMode: 'native', logicalKey: 'feedtone_bridge:screen', fallbackScreenId: 'home' });
        if (typeof nav.registerEntry === 'function') nav.registerEntry({ pluginId: REQUESTER, entryId: 'feedtone-bridge-nav', targetScreenId: 'plugin-feedtone_bridge', label: 'FeedTone', region: 'primary-nav.plugins', lifecyclePolicy: 'mounted-hidden', compatibilityMode: 'native', logicalKey: 'feedtone_bridge:navigation', fallbackScreenId: 'home' });
    }

    function mountBridgePanel() {
        const root = document.getElementById('feedtone-bridge-root');
        if (!root || root.dataset.mounted) return;
        root.dataset.mounted = '1';
        const message = root.querySelector('[data-ft-message]');
        const toneList = root.querySelector('[data-ft-tones]');
        const arrangementList = root.querySelector('[data-ft-arrangements]');
        const follow = root.querySelector('[data-ft-follow]');
        const save = root.querySelector('[data-ft-save]');
        const packageInput = root.querySelector('[data-ft-package]');
        const importPackage = root.querySelector('[data-ft-import]');
        const restorePackage = root.querySelector('[data-ft-restore]');
        let toneIdentity = '';
        let saveTimer = null;
        const showMessage = (value, error) => { message.textContent = value; message.dataset.error = error ? '1' : '0'; };
        const render = () => {
            const state = bridgePanelState();
            root.querySelector('[data-ft-song]').textContent = state.filename ? `${state.artist ? `${state.artist} - ` : ''}${state.title || filenameOnly(state.filename)}` : 'Open a song in FeedBack';
            root.querySelector('[data-ft-context]').textContent = state.filename ? `${state.arrangement || 'Arrangement'} / ${state.activeTone || 'Waiting for tone'}` : 'The controls will appear when a saved FeedTone song is loaded.';
            const status = root.querySelector('[data-ft-status]');
            status.textContent = state.status.state === 'verified' ? 'Live controls connected' : state.status.state === 'verification-failed' ? 'Control sync needs attention' : 'Waiting for tones';
            status.dataset.ok = state.status.state === 'verified' ? '1' : '0';
            const arrangementIdentity = `${state.arrangementIndex}|${state.arrangements.map(item => `${item.index}:${item.name}`).join('|')}`;
            if (arrangementList.dataset.identity !== arrangementIdentity) {
                arrangementList.dataset.identity = arrangementIdentity;
                arrangementList.replaceChildren();
                state.arrangements.forEach(item => arrangementList.add(new Option(item.name, item.index, false, String(item.index) === String(state.arrangementIndex))));
            }
            arrangementList.disabled = !state.filename || !state.arrangements.length;
            importPackage.disabled = !state.filename;
            follow.disabled = !state.forcedTone;
            const nextToneIdentity = `${state.activeTone}|${state.forcedTone}|${state.tones.map(item => item.key).join('|')}`;
            if (nextToneIdentity !== toneIdentity) {
                toneIdentity = nextToneIdentity;
                toneList.replaceChildren();
                state.tones.forEach(item => {
                    const button = document.createElement('button');
                    button.type = 'button'; button.className = 'ft-tone'; button.textContent = item.name;
                    button.dataset.active = normalise(item.key) === normalise(state.activeTone) ? '1' : '0';
                    button.addEventListener('click', async () => { try { showMessage(`Loading ${item.name}...`); await forcePanelTone(item.key); showMessage(`${item.name} pinned for audition.`); render(); } catch (error) { showMessage(String(error.message || error), true); } });
                    toneList.appendChild(button);
                });
            }
            root.querySelectorAll('[data-ft-mixer]').forEach(input => {
                const field = { song: 'song_percent', monitor: 'monitor', input: 'input_db', amp: 'amp_db', nam: 'nam_output' }[input.dataset.ftMixer];
                if (document.activeElement !== input && Number.isFinite(Number(state.mixer[field]))) input.value = state.mixer[field];
                const disabled = !state.filename || (input.dataset.ftMixer === 'nam' && !state.namAvailable);
                input.disabled = disabled;
                const output = root.querySelector(`[data-ft-value="${input.dataset.ftMixer}"]`);
                output.textContent = input.dataset.ftMixer === 'song' ? `${Math.round(Number(input.value))}%` : input.dataset.ftMixer === 'monitor' || input.dataset.ftMixer === 'nam' ? `${Number(input.value).toFixed(2)}x` : `${Number(input.value).toFixed(1)} dB`;
            });
        };
        root.querySelectorAll('[data-ft-mixer]').forEach(input => input.addEventListener('input', () => {
            render(); clearTimeout(saveTimer); saveTimer = setTimeout(async () => { try { await setPanelMixer(input.dataset.ftMixer, input.value); render(); showMessage('Live mixer verified in FeedBack.'); } catch (error) { showMessage(String(error.message || error), true); } }, 90);
        }));
        arrangementList.addEventListener('change', async () => { try { showMessage(`Loading ${arrangementList.options[arrangementList.selectedIndex].text}...`); await selectPanelArrangement(arrangementList.value); showMessage('Arrangement loaded.'); render(); } catch (error) { showMessage(String(error.message || error), true); } });
        follow.addEventListener('click', async () => { try { await followPanelTimeline(); showMessage('Following the song timeline.'); render(); } catch (error) { showMessage(String(error.message || error), true); } });
        save.addEventListener('click', async () => { try { const result = await savePanelMixer(); showMessage(`Saved for ${result.arrangement} / ${result.tone}.`); } catch (error) { showMessage(String(error.message || error), true); } });
        importPackage.addEventListener('click', () => packageInput.click());
        packageInput.addEventListener('change', async () => {
            const file = packageInput.files && packageInput.files[0];
            if (!file) return;
            try {
                const state = bridgePanelState();
                if (!state.filename) throw new Error('Open the matching song in FeedBack first');
                showMessage(`Importing ${file.name}...`);
                const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
                const response = await fetch('/api/plugins/feedtone_bridge/package/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, target_filename: state.filename, title: state.title, artist: state.artist }) });
                const result = await response.json();
                if (!response.ok || !result.ok) throw new Error(result.reason || `Import returned ${response.status}`);
                syncedRigs.delete(String(state.filename).toLowerCase());
                await syncRig(state.filename);
                lastHighwayIdentity = '';
                restorePackage.disabled = false;
                showMessage(`Applied ${result.tones} tone states and ${result.assets} assets. Choose an arrangement or press Play.`);
                render();
            } catch (error) { showMessage(String(error.message || error), true); }
            finally { packageInput.value = ''; }
        });
        restorePackage.addEventListener('click', async () => {
            try {
                const state = bridgePanelState();
                const response = await fetch('/api/plugins/feedtone_bridge/package/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_filename: state.filename }) });
                const result = await response.json();
                if (!response.ok || !result.ok) throw new Error(result.reason || `Restore returned ${response.status}`);
                syncedRigs.delete(String(state.filename).toLowerCase());
                restorePackage.disabled = true;
                showMessage(result.restart_required ? 'Previous tone restored. Restart FeedBack once.' : 'Previous tone restored.');
            } catch (error) { showMessage(String(error.message || error), true); }
        });
        setInterval(render, 300);
        render();
    }

    let playerButton = null;
    let bridgeHome = null;

    function closePlayerPanel() {
        const dialog = document.getElementById('feedtone-player-dialog');
        const root = document.getElementById('feedtone-bridge-root');
        if (root && bridgeHome && bridgeHome.isConnected) {
            bridgeHome.replaceWith(root);
            bridgeHome = null;
        }
        if (dialog && dialog.open) dialog.close();
        if (playerButton) playerButton.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    }

    function openPlayerPanel() {
        const root = document.getElementById('feedtone-bridge-root');
        if (!root) return;
        mountBridgePanel();
        let dialog = document.getElementById('feedtone-player-dialog');
        if (!dialog) {
            dialog = document.createElement('dialog');
            dialog.id = 'feedtone-player-dialog';
            dialog.innerHTML = '<button type="button" data-ft-close aria-label="Close FeedTone">x</button><div data-ft-player-body></div>';
            dialog.style.cssText = 'width:min(1180px,94vw);max-width:none;padding:0;border:1px solid #39414a;background:#0d1013;color:#fff;box-shadow:0 28px 90px #000;border-radius:8px;z-index:2147483000';
            const style = document.createElement('style');
            style.textContent = '#feedtone-player-dialog::backdrop{background:rgba(0,0,0,.72)}#feedtone-player-dialog>[data-ft-close]{position:absolute;right:12px;top:10px;z-index:2;width:32px;height:32px;border:1px solid #3a424b;border-radius:5px;background:#171c21;color:#d8dee5;cursor:pointer}#feedtone-player-dialog #feedtone-bridge-root{min-height:0;padding:0}';
            document.head.appendChild(style);
            document.body.appendChild(dialog);
            dialog.querySelector('[data-ft-close]').addEventListener('click', closePlayerPanel);
            dialog.addEventListener('cancel', event => { event.preventDefault(); closePlayerPanel(); });
            dialog.addEventListener('click', event => { if (event.target === dialog) closePlayerPanel(); });
        }
        if (!bridgeHome || !bridgeHome.parentNode) {
            bridgeHome = document.createComment('FeedTone bridge home');
            root.parentNode.insertBefore(bridgeHome, root);
        }
        dialog.querySelector('[data-ft-player-body]').appendChild(root);
        if (!dialog.open) dialog.showModal();
        if (playerButton) playerButton.className = 'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-200 transition';
    }

    function ensurePlayerButton() {
        const slot = window.slopsmith && window.slopsmith.ui && typeof window.slopsmith.ui.playerControlSlot === 'function' ? window.slopsmith.ui.playerControlSlot() : null;
        const controls = slot || document.getElementById('player-controls');
        if (!controls || (playerButton && playerButton.isConnected)) return;
        playerButton = document.createElement('button');
        playerButton.id = 'btn-feedtone-bridge';
        playerButton.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
        playerButton.textContent = 'FeedTone';
        playerButton.title = 'Open FeedTone live tone controls';
        playerButton.addEventListener('click', openPlayerPanel);
        controls.appendChild(playerButton);
    }

    function bind() {
        const bus = window.slopsmith || window.feedBack;
        if (!bus || typeof bus.on !== 'function') {
            setTimeout(bind, 500);
            return;
        }
        bus.on('playback:ready', event => { feedbackPlaying = false; applyWithHydrationRetry(event); });
        bus.on('playback:playing', event => { feedbackPlaying = true; applyWithHydrationRetry(event); });
        bus.on('playback:stopped', () => { feedbackPlaying = false; publishPlaybackContext(); });
        bus.on('playback:ended', event => { feedbackPlaying = false; publishPlaybackContext(); restore(event); });
        bus.on('song:loaded', applyWithHydrationRetry);
        bus.on('song:play', applyWithHydrationRetry);
        bus.on('arrangement:changed', applyWithHydrationRetry);
        bus.on('tone:changed', apply);
        bus.on('tone-changed', apply);
        bus.on('rig:tone-changed', apply);
        bus.on('song:loading', claimOpenGate);
        if (window.feedBack && window.feedBack !== bus && typeof window.feedBack.on === 'function') {
            window.feedBack.on('audio-mix:fader-value-changed', onFaderChanged);
            window.feedBack.on('song:loaded', applyWithHydrationRetry);
            window.feedBack.on('song:play', event => { feedbackPlaying = true; applyWithHydrationRetry(event); });
            window.feedBack.on('song:stop', () => { feedbackPlaying = false; publishPlaybackContext(); });
            window.feedBack.on('song:ended', event => { feedbackPlaying = false; publishPlaybackContext(); restore(event); });
            window.feedBack.on('arrangement:changed', applyWithHydrationRetry);
            window.feedBack.on('tone:changed', apply);
            window.feedBack.on('tone-changed', apply);
            window.feedBack.on('song:loading', claimOpenGate);
        }
    }

    async function finishOpenGate(pending) {
        await syncRig(String(pending.filename));
        const rig = await waitForRigReady(String(pending.filename), String(pending.arrangement || ''));
        const activeTone = resolveHighwayTone() || String(rig.activeToneKey || '');
        const event = { detail: {
            filename: String(pending.filename),
            arrangementRef: String(pending.arrangement || ''),
            toneKey: activeTone,
            localDisplay: { arrangement: String(pending.arrangement || '') },
        } };
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (applyBusy) await new Promise(resolve => setTimeout(resolve, 180));
            const status = await applyNow(event) || {};
            if (status.state === 'verified') return true;
            await new Promise(resolve => setTimeout(resolve, 450));
        }
        return false;
    }

    function waitForSongReady() {
        return new Promise((resolve, reject) => {
            const bus = window.feedBack;
            if (!bus || typeof bus.on !== 'function') return reject(new Error('FeedBack event bus is unavailable'));
            const timer = setTimeout(() => {
                try { bus.off('song:ready', ready); } catch (_) {}
                reject(new Error('FeedBack song load timed out'));
            }, 12000);
            function ready(event) {
                clearTimeout(timer);
                try { bus.off('song:ready', ready); } catch (_) {}
                resolve(event);
            }
            bus.on('song:ready', ready);
        });
    }

    async function pollOpenCommand() {
        if (openCommandBusy) return;
        openCommandBusy = true;
        let nonce = '';
        try {
            const response = await fetch('/api/plugins/feedtone_bridge/command', { cache: 'no-store' });
            const pending = await response.json();
            if (!pending || !pending.pending || !pending.nonce || !pending.filename) return;
            nonce = String(pending.nonce);
            if (nonce === lastOpenCommand) return;
            lastOpenCommand = nonce;
            openGate = {
                nonce,
                filename: String(pending.filename),
                arrangement: String(pending.arrangement || ''),
                release: null,
            };
            showLoadingGate('Loading FeedTone tones…');
            try { await fetch('/api/rescan', { method: 'POST' }); } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, 450));
            if (typeof window.playSong !== 'function') throw new Error('FeedBack player is not ready');
            closePlayerPanel();
            const rawIndex = pending.arrangement_index;
            const arrangementIndex = rawIndex === null || rawIndex === undefined ? undefined : Math.max(0, Number(rawIndex));
            const songReady = waitForSongReady();
            const never = new Promise(() => {});
            const launch = Promise.resolve(window.playSong(encodeURIComponent(String(pending.filename)), arrangementIndex)).then(() => never);
            await Promise.race([songReady, launch]);
            await new Promise(resolve => setTimeout(resolve, 700));
            const verified = await finishOpenGate(pending);
            if (!verified) throw new Error('FeedTone mixer verification failed');
            await fetch(`/api/plugins/feedtone_bridge/command/ack?nonce=${encodeURIComponent(nonce)}`, { method: 'POST' });
            const release = openGate && openGate.release;
            openGate = null;
            lastHighwayIdentity = '';
            hideLoadingGate();
            if (typeof release === 'function') release();
            setTimeout(pollHighwayTone, 0);
        } catch (error) {
            showLoadingGate(`FeedTone could not verify the rig and mixer. The song remains stopped. ${String(error && error.message || error)}`);
            if (nonce && lastOpenCommand === nonce) lastOpenCommand = '';
        } finally {
            openCommandBusy = false;
        }
    }
    async function pollFeedToneControl() {
        if (controlBusy) return;
        controlBusy = true;
        let nonce = '';
        try {
            const response = await fetch('/api/plugins/feedtone_bridge/control', { cache: 'no-store' });
            const pending = await response.json();
            if (!pending || !pending.pending || !pending.nonce) return;
            nonce = String(pending.nonce);
            if (nonce === lastControlNonce) return;
            lastControlNonce = nonce;
            if (pending.action !== 'seek') throw new Error('unsupported control');
            const current = (window.feedBack && window.feedBack.currentSong) || {};
            const currentFile = normalise(filenameOnly(current.filename || current.file || ''));
            if (pending.filename && currentFile && normalise(filenameOnly(pending.filename)) !== currentFile) throw new Error('song mismatch');
            if (!window.feedBack || typeof window.feedBack.seek !== 'function') throw new Error('FeedBack seek API unavailable');
            await Promise.resolve(window.feedBack.seek(Math.max(0, Number(pending.position_ms || 0)) / 1000, 'feedtone-timeline'));
            await fetch(`/api/plugins/feedtone_bridge/control/ack?nonce=${encodeURIComponent(nonce)}`, { method: 'POST' });
        } catch (_) {
            if (nonce && lastControlNonce === nonce) lastControlNonce = '';
        } finally {
            controlBusy = false;
        }
    }
    registerBridgeScreen();
    bind();
    setInterval(mountBridgePanel, 500);
    setInterval(ensurePlayerButton, 500);
    setInterval(pollHighwayTone, 80);
    setInterval(publishPlaybackContext, 200);
    setInterval(readMixerSnapshot, 1500);
    setInterval(pollLivePreview, 120);
    setInterval(pollFeedToneControl, 120);
    setInterval(pollOpenCommand, 800);
    setTimeout(pollOpenCommand, 250);
    setTimeout(readMixerSnapshot, 300);
    setTimeout(pollFeedToneControl, 350);
    setTimeout(ensurePlayerButton, 250);
})();
