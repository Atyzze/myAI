import { fmtDur, getSetting, confirmServerProcessing, escapeHtml, escapeAttr,
         readStored, writeStored } from './config.js';
import { resamplePcmTo16k } from './audio.js';
import { transcribeChunkServer, transcribeBlobServer } from './transcribe.js';
import { translateLines, loadedModels, warmAiModel } from './reply.js';
import { parseConfirm, nextProposals, takeProposal, dropSubject, proposalSubject,
         describeProposal, describeConfirmResult, proposalForNumber } from './speaker-confirm-core.js';
import { panelLanguages, translationStillCurrent, languageName, translatedFrom,
         notTranslatedFrom,
         renderedText, languageColour, firstSeenOrder, translationBatch,
         misalignBackoffMs, MAX_TRANSLATE_ATTEMPTS,
         buildBatchPrompt, parseBatchResponse, TRANSLATE_BATCH_LINES,
         untranslatedCounts, panelHeading, MISALIGN_NOTICE_AFTER,
         addLanguageHeard, describeLanguages, introducedLanguages, languageLabel,
         steadyRate, SLOW_MS_PER_LINE, TRANSLATE_CAUSES, planTranslationFailure,
         rotateTargets, MAX_TRANSLATE_IN_FLIGHT,
         panelGrid, MAX_PANELS,
         SYSTEM_TONES, SYSTEM_HELP_COLOUR } from './translate-core.js';
import { encodeMonoWav } from './audio.js';
import { invertCoverage, mergeIntervals, planChunksForRanges, planWholeFileDecode, createSeamState, passSeam,
         pickCoreSegments, summarizeChunkLevel, chunkCoreSamples, levelEnvelope,
         LIVE_CORE_REACH_SEC } from './transcribe-core.js';
import { inspectPcmWav, resamplePcmWavRangeTo16k, resampleWebmRangeTo16k,
         resampleTo16k } from './audio.js';
import { prepareWebmChunkSource } from './webm-duration.js';
import { createDiarization, addEmbeddings, labelsEarned, voicesOf,
         decorateLines, diarizationStats, resolveIdentity,
         describeDiarization, applySpeakerCommand,
         speakerDisplayName, shownNumber, setSpeakerPolicy, speakerPolicy, inferredNameCount,
         NUMBERS_POLICY, INFER_POLICY, SPEAKER_POLICIES, DEFAULT_SPEAKER_POLICY,
         MAX_SPEAKERS } from './diarize-core.js';
import { createSpeakerHints, noteSpeech, reviewSpeakers,
         describeInference } from './speaker-infer-core.js';
import {
    WINDOW_SEC, OVERLAP_SEC, MAX_IN_FLIGHT,
    planLiveWindow, planPreviewRequest, appendLiveLines, archiveDroppedLines, capLiveText,
    nextSpeechState, planUpload, capRetryQueue, settleLiveWindows, retryDelayMs,
    describeConnection, judgeWindowFailure, releaseReviewAudioOfWaitingWindows, queuedWindowBytes,
    afterRecordingFate
} from './live-scribe-core.js';
import { carryAcrossResume, transcriptSnapshot, lineTranslation } from './live-scribe-core.js';
import { cappedPanelCount, cappedInFlight } from './capabilities-core.js';
import { boxCapabilities } from './capabilities.js';
import { findBoundaryRepetition, translationIntroducesRepetition, preferWiderRecheck,
         mergeTimedPcm, replaceWindowLines } from './live-refine-core.js';

const LIVE_REQUEST_TIMEOUT_MS = 30000;

function freshSession(policy) {
    return {
        nextIndex: 0,
        pendingGap: false,
        stopping: false,
        tail: '',
        droppedSec: 0,
        consumedSec: 0,
        lines: [],
        backfillLines: [],
        archivedLines: [],
        coverage: [],
        backfillNote: '',
        diarization: createDiarization(policy),
        speakerHints: createSpeakerHints(),
        inferEchoed: new Set(),
        speakerNoticeShown: false,
        commandSeq: 0,
        languages: {},
        closedLanguages: new Set(),
        translations: {},
        translating: new Set(),
        translateFailures: 0,
        translateStalled: false,
        translateTries: {},
        translateGaveUp: new Set(),
        translateNextAt: 0,
        batchSize: {},
        batchMisaligns: {},
        batchPauseUntil: {},
        batchCeiling: {},
        translateSamples: [],
        panelActivity: {},
        translateTurn: 0,
        translateCause: '',
        placementChecked: false,
        panelsOffNoticed: false,
        proposals: [],
        proposalEchoed: new Set(),
        preview: '',
        previewInFlight: false,
        previewAt: 0,
        recentReviewWindows: [],
        refineQueue: [],
        refineInFlight: false,
        refineSeq: 0,
        speech: { floor: 0, level: 0, speaking: false, speakingUntil: 0 },
        queue: [],
        pending: new Map(),
        nextAppendIndex: 0,
        gapBeforeNext: false,
        answered: 0,
        attempt: 0,
        nextAttemptAt: 0,
        droppedWindows: 0
    };
}

const state = {
    active: false,
    recId: null,
    sampleRate: 48000,
    buffer: [],
    bufferLength: 0,
    carry: null,
    inFlight: 0,
    preparing: 0,
    epoch: 0,
    controller: null,
    status: '',
    originSec: 0,
    backfillEpoch: null,
    translateWake: null,
    meterTimer: null,
    retryTimer: null,
    online: true,
    ...freshSession()
};

const el = {};
function panelElements() {
    if (!el.root) {
        el.root   = document.getElementById('live-scribe');
        el.text   = document.getElementById('live-scribe-text');
        el.body   = document.getElementById('live-scribe-body');
        el.status = document.getElementById('live-scribe-status');
        el.meter = document.getElementById('live-scribe-meter');
        el.hearing = document.getElementById('live-scribe-hearing');
        el.speakers = document.getElementById('live-scribe-speakers');
        el.languages = document.getElementById('live-scribe-languages');
    }
    return el;
}

function setStatus(message) {
    state.status = message;
    const nodes = panelElements();
    if (nodes.status) nodes.status.textContent = message;
}

const SPEAKER_ACK_FLAG = 'speaker-detection-acknowledged-v1';

function autoTranscribeAfterRecording() {
    return getSetting('set-auto-transcribe') === 'on';
}

function speakerDetectionEnabled() {
    return getSetting('set-speaker-detection') === 'on';
}

function maxSpeakers() {
    const value = Number(getSetting('set-max-speakers'));
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : MAX_SPEAKERS;
}

export function confirmSpeakerDetection() {
    if (readStored(SPEAKER_ACK_FLAG) === '1') return true;
    const accepted = confirm(
        'Speaker labelling is experimental.\n\n'
        + 'This app records from ONE microphone, so telling voices apart is a best guess from sound alone. '
        + 'It can split one person into two, merge two people into one, and it usually treats the same person '
        + 'speaking a different language as someone new.\n\n'
        + 'A setup with a microphone per person gets this right by construction; a single microphone cannot. '
        + 'Labels are a hint, not a record of who said what.\n\n'
        + 'Turn it on?');
    if (accepted) writeStored(SPEAKER_ACK_FLAG, '1');
    else writeStored('set-speaker-detection', 'off');
    return accepted;
}

// The number a speaker is shown under right now.
function numberOnScreen(id) {
    return shownNumber(state.diarization, id);
}

// The number a suggestion was announced with, which is the number "confirm speaker N" names.
function announcedNumber(proposal) {
    return proposal.number != null ? proposal.number : numberOnScreen(proposalSubject(proposal.command));
}

function handleSpokenInstructions(items) {
    for (const item of (items || [])) {
        const pending = state.proposals.map(announcedNumber);
        const heard = parseConfirm(item.text, pending);
        if (heard) confirmSpeaker(heard.id, item.startSec);
    }
}

function confirmSpeaker(id, atSec) {
    if (id == null) {
        echoCommand(describeConfirmResult({ id: null, pending: state.proposals.length }), atSec, 'warn');
        return;
    }
    const meant = proposalForNumber(state.proposals, id, numberOnScreen);
    const { proposal, rest } = meant
        ? takeProposal(state.proposals, proposalSubject(meant.command))
        : { proposal: null, rest: state.proposals };
    if (!proposal) {
        echoCommand(describeConfirmResult({ id, applied: false }), atSec, 'warn');
        return;
    }
    const applied = applySpeakerCommand(state.diarization, { ...proposal.command, origin: 'confirmed' });
    if (!applied.ok) {
        echoCommand(applied.echo || `Speaker ${id} could not be confirmed`, atSec, 'error',
                    { hint: 'say "confirm speaker N" to accept a suggested name' });
        return;
    }
    state.diarization = applied.state;
    state.proposals = rest;
    echoCommand(describeConfirmResult({ id, applied: true, echo: applied.echo }), atSec, 'ok');
    paintSpeakers();
}

function learnSpeakers(items) {
    if (!speakerDetectionEnabled()) return;
    const heard = (items || []).filter(item => item.embedding)
        .map(item => ({ key: item.key, embedding: item.embedding, seconds: Math.max(0, item.endSec - item.startSec) }));
    const learned = heard.length > 0;
    if (learned) state.diarization = addEmbeddings(state.diarization, heard, { maxSpeakers: maxSpeakers() });
    inferSpeakerNames(items);
    paintSpeakers();
    if (!learned) return;

    if (!state.speakerNoticeShown && labelsEarned(state.diarization)) {
        state.speakerNoticeShown = true;
        setStatus(`🗣️ second speaker detected · ${voiceNames().join(' · ')}`);
    }
}

function voiceNames() {
    return voicesOf(state.diarization).map(id => speakerDisplayName(state.diarization, id));
}

function settingsPolicy() {
    const value = getSetting('set-speaker-policy');
    return SPEAKER_POLICIES.includes(value) ? value : DEFAULT_SPEAKER_POLICY;
}

function syncSpeakerPolicy(atSec = 0, { announce = true } = {}) {
    const wanted = settingsPolicy();
    const current = speakerPolicy(state.diarization);
    if (wanted === current) return;
    const worked = inferredNameCount(state.diarization);
    state.diarization = setSpeakerPolicy(state.diarization, wanted);
    if (!announce) return;
    const what = wanted === NUMBERS_POLICY
        ? `speakers are numbers again${worked ? ` — ${worked} worked-out name${worked === 1 ? '' : 's'} hidden, not forgotten` : ''}`
          + ' · switch in Settings › How speakers are named'
        : 'letting the conversation name the speakers — everything already said is applied backwards'
          + ' · no name is applied until you confirm it';
    echoCommand(what, atSec, 'ok');
}

function inferenceRunning() {
    return speakerDetectionEnabled() && settingsPolicy() === INFER_POLICY;
}

function inferSpeakerNames(items) {
    if (!speakerDetectionEnabled()) return;
    const atSec = items && items.length ? items[items.length - 1].startSec : 0;
    syncSpeakerPolicy(atSec);
    for (const item of (items || [])) {
        state.speakerHints = noteSpeech(state.speakerHints, item.key, item.text, item.startSec);
    }

    const review = reviewSpeakers(state.speakerHints, state.diarization);
    state.proposals = nextProposals(state.proposals, review.commands, atSec);
    for (const proposal of state.proposals) {
        if (state.proposalEchoed.has(proposal.key)) continue;
        state.proposalEchoed.add(proposal.key);
        proposal.number = numberOnScreen(proposalSubject(proposal.command));
        echoCommand(describeProposal(proposal, numberOnScreen), atSec, 'warn',
                    { hint: 'nothing changes until you confirm it' });
    }
    for (const note of review.notes) {
        const seen = `same:${note.id}`;
        if (state.inferEchoed.has(seen)) continue;
        state.inferEchoed.add(seen);
        echoCommand(note.text, note.atSec, 'warn');
    }
}

function echoCommand(echo, atSec, tone = 'error', { panelOnly = null, language = null, hint = null } = {}) {
    const kind = tone === true ? 'ok' : (tone === false ? 'error' : String(tone));
    state.lines.push({
        key: `cmd-${state.epoch}.${state.commandSeq++}`,
        startSec: Math.max(0, Number(atSec) || 0),
        endSec: Math.max(0, Number(atSec) || 0),
        text: echo,
        hint: hint != null ? hint : '',
        language,
        panelOnly,
        system: true,
        tone: kind,
        ok: kind === 'ok'
    });
    paintText();
}

function translatedLanguages() {
    return Object.keys(state.languages || {});
}

function introducedLanguageCodes() {
    return introducedLanguages(state.languages, { excluded: [...state.closedLanguages] });
}

function baseLanguage() {
    return introducedLanguageCodes()[0] || firstSeenOrder(state.languages)[0] || '';
}

function currentPanelLanguages(count = panelCount()) {
    return panelLanguages(state.languages, count, { excluded: [...state.closedLanguages] });
}

function noticePanelsAreOff(atSec) {
    if (state.panelsOffNoticed || panelCount() >= 2) return;
    const would = currentPanelLanguages(MAX_PANELS);
    if (would.length < 2) return;
    state.panelsOffNoticed = true;
    echoCommand(`${would.length} languages are being spoken and the translation boxes are off — `
        + `turn them on in Settings › Live translation panels`,
        atSec, 'warn');
}

function paintLanguages() {
    const nodes = panelElements();
    if (!nodes.languages) return;
    const names = introducedLanguageCodes();
    if (names.length === 0) { nodes.languages.textContent = ''; return; }
    nodes.languages.textContent = describeLanguages(state.languages, { excluded: [...state.closedLanguages] });
    nodes.languages.classList.toggle('multi', names.length > 1);
}

export function noteLiveSystemLine(text, tone = 'warn') {
    if (!state.active || !text) return false;
    echoCommand(text, state.originSec + state.consumedSec, tone);
    return true;
}

function paintSpeakers() {
    const nodes = panelElements();
    if (!nodes.speakers) return;
    if (!speakerDetectionEnabled()) { nodes.speakers.textContent = ''; return; }
    const stats = diarizationStats(state.diarization);
    if (stats.samples === 0 && state.lines.length === 0) { nodes.speakers.textContent = ''; return; }
    const live = [...new Set(voiceNames())];
    const heard = inferenceRunning() ? describeInference(state.speakerHints, state.diarization) : '';
    const policy = speakerPolicy(state.diarization) === NUMBERS_POLICY ? '#' : '👤';
    nodes.speakers.textContent = describeDiarization(stats)
        + (live.length > 1 ? ` (${live.join(', ')})` : '')
        + (heard ? ` · ${heard}` : '')
        + ` · ${policy}`;
    nodes.speakers.classList.toggle('found', stats.labelled);
    nodes.speakers.classList.toggle('none', stats.samples === 0);
}

// The setting asks for a number of boxes; a myAI box that cannot keep up with that many
// lowers it (capabilities-core.js). Servers without /capabilities leave it as set.
function panelCount() {
    const value = Number(getSetting('set-translate-panels'));
    return Number.isFinite(value) ? cappedPanelCount(value, MAX_PANELS, boxCapabilities()) : 0;
}

function countAttempt(key) {
    const tries = (state.translateTries[key] || 0) + 1;
    state.translateTries[key] = tries;
    if (tries >= MAX_TRANSLATE_ATTEMPTS) state.translateGaveUp.add(key);
}

function scheduleTranslationWake(delayMs) {
    if (state.translateWake) return;
    state.translateWake = setTimeout(() => {
        state.translateWake = null;
        if (state.active) paintText();
    }, Math.max(250, Math.ceil(Number(delayMs) || 0)));
}

const TIMING_SAMPLES = 6;

function recordTranslationTiming(target, lines, timing) {
    if (!timing || !(lines > 0)) return;
    if (timing.reloaded) {
        console.info(`Translation ${target}: the server spent ${timing.loadMs}ms loading the AI model; `
            + 'not counted as translation time');
    }
    state.translateSamples.push({ lines, ms: timing.generateMs });
    if (state.translateSamples.length > TIMING_SAMPLES) state.translateSamples.shift();
    const rate = steadyRate(state.translateSamples);
    console.info(`Translation ${target}: ${lines} line(s) in ${timing.generateMs}ms`
        + (timing.wallMs !== timing.generateMs ? ` (${timing.wallMs}ms round trip)` : '')
        + (rate != null ? ` (${rate}ms per line)` : ''));
    const current = state.panelActivity[target];
    if (current && current.state === 'translating') {
        state.panelActivity[target] = { state: 'idle', msPerLine: rate };
    }
    if (rate != null && rate >= SLOW_MS_PER_LINE) checkModelPlacement();
}

async function checkModelPlacement() {
    if (state.placementChecked) return;
    state.placementChecked = true;
    try {
        const loaded = await loadedModels();
        const spilled = loaded.find(item => item.onCpu);
        if (spilled) {
            console.info(`Translation is slow: ${spilled.name} is only ${spilled.gpuPercent}% on the GPU`);
            setTranslateCause(TRANSLATE_CAUSES.cpu);
        }
    } catch (_) {}
}

function setTranslateCause(cause) {
    if (!cause || state.translateCause === cause) return;
    state.translateCause = cause;
    if (state.active) paintText();
}

function translationsInFlight() {
    let count = 0;
    for (const key of state.translating) if (key.startsWith('panel:')) count++;
    return count;
}

function requestTranslations(rows, target) {
    if (!state.active) return;
    const epoch = state.epoch;
    const lock = `panel:${target}`;
    if (state.translating.has(lock)) return;
    if (translationsInFlight() >= cappedInFlight(MAX_TRANSLATE_IN_FLIGHT, boxCapabilities())) return;

    const waitMs = state.translateNextAt - Date.now();
    if (waitMs > 0) {
        state.panelActivity[target] = { state: 'failing', pauseMs: waitMs, slow: state.translateStalled };
        scheduleTranslationWake(waitMs);
        return;
    }

    const pausedFor = (state.batchPauseUntil[target] || 0) - Date.now();
    if (pausedFor > 0) {
        state.panelActivity[target] = { state: 'paused', pauseMs: pausedFor };
        scheduleTranslationWake(pausedFor);
        return;
    }

    const size = Math.min(state.batchSize[target] || TRANSLATE_BATCH_LINES,
                          state.batchCeiling[target] || TRANSLATE_BATCH_LINES);
    const skip = new Set(state.translating);
    for (const key of state.translateGaveUp) skip.add(key);
    const batch = translationBatch(rows, target,
        { translations: state.translations, inFlight: skip }, size);
    if (batch.length === 0) return;

    for (const item of batch) state.translating.add(item.key);
    state.translating.add(lock);
    state.translateTurn = (state.translateTurn || 0) + 1;

    const texts = batch.map(item => item.line);
    state.panelActivity[target] = { state: 'translating', msPerLine: steadyRate(state.translateSamples) };
    let timing = null;
    translateLines(buildBatchPrompt(texts, languageName(target)), batch.length,
                   state.controller ? state.controller.signal : undefined,
                   { onTiming: measured => { timing = measured; } })
        .then(reply => {
            if (epoch !== state.epoch) return;
            const parsed = parseBatchResponse(reply, batch.length);
            if (!parsed) {
                state.batchSize[target] = batch.length > 1 ? Math.max(1, Math.floor(batch.length / 2)) : 1;
                if (batch.length === 1) countAttempt(batch[0].key);
                const misaligns = (state.batchMisaligns[target] || 0) + 1;
                state.batchMisaligns[target] = misaligns;
                if (misaligns > 1) {
                    state.batchPauseUntil[target] = Date.now() + misalignBackoffMs(misaligns - 1);
                    scheduleTranslationWake(misalignBackoffMs(misaligns - 1));
                }
                console.warn(`Translation batch did not align (${batch.length} lines); retrying at`,
                             state.batchSize[target], '- reply began:', String(reply).slice(0, 120));
                if (misaligns >= MISALIGN_NOTICE_AFTER) {
                    state.batchCeiling[target] = 1;
                }
                if (misaligns === MISALIGN_NOTICE_AFTER) setTranslateCause(TRANSLATE_CAUSES.format);
                return;
            }
            recordTranslationTiming(target, batch.length, timing);
            const shown = [...state.backfillLines, ...state.lines];
            batch.forEach((item, i) => {
                if (!translationStillCurrent(shown, item.line)) return;
                if (!parsed[i]) {
                    countAttempt(item.key);
                    return;
                }
                if (translationIntroducesRepetition(item.line.text, parsed[i])) {
                    countAttempt(item.key);
                    return;
                }
                state.translations[item.key] = parsed[i];
            });
            state.batchSize[target] = Math.min(TRANSLATE_BATCH_LINES, batch.length * 2);
            state.batchMisaligns[target] = 0;
            state.batchPauseUntil[target] = 0;
            state.translateFailures = 0;
            state.translateNextAt = 0;
            state.translateStalled = false;
        })
        .catch(err => {
            if (epoch !== state.epoch) return;
            if (err && err.name === 'AbortError') return;
            const failure = planTranslationFailure(err, batch.length, state.translateFailures);
            state.translateFailures = failure.failures;
            state.translateNextAt = Date.now() + failure.backoffMs;
            state.translateStalled = failure.stalled;
            if (failure.countsAgainstLines) for (const item of batch) countAttempt(item.key);
            if (failure.batchSize) state.batchSize[target] = failure.batchSize;
            if (failure.sample) {
                recordTranslationTiming(target, failure.sample.lines,
                    { generateMs: failure.sample.ms, wallMs: failure.sample.ms, loadMs: null, reloaded: false });
            }
            console.warn('Translation failed:', err);
            if (err && err.name === 'EmptyTranslation') setTranslateCause(TRANSLATE_CAUSES.reasoning);
        })
        .finally(() => {
            if (epoch !== state.epoch) return;
            for (const item of batch) state.translating.delete(item.key);
            state.translating.delete(lock);
            if (state.panelActivity[target] && state.panelActivity[target].state === 'translating') {
                state.panelActivity[target] = { state: 'idle', msPerLine: steadyRate(state.translateSamples) };
            }
            if (state.active) paintText();
        });
}

function renderPanelRows(rows, target, firstSeen) {
    return rows.flatMap(row => {
        if (row.panelOnly && row.panelOnly !== target) return [];
        if (row.system) {
            const tone = SYSTEM_TONES[row.tone] || SYSTEM_HELP_COLOUR;
            return [{ key: row.key, html: `<span class="ls-line ls-system" style="--ls-tone:${tone}">`
                + `<span class="ls-ts">[${row.stamp}]</span> `
                + `<span class="ls-sys-tag">${row.tone === 'ok' ? '✓' : (row.tone === 'warn' ? '!' : '?')}</span> ${escapeHtml(row.text)}`
                + (row.hint ? `<span class="ls-sys-hint">${escapeHtml(row.hint)}</span>` : '')
                + `</span>` }];
        }
        const shown = renderedText(row, target, state.translations, { gaveUp: state.translateGaveUp });
        const translated = shown.translated || shown.pending || shown.abandoned;
        const fromColour = languageColour(shown.from, firstSeen);
        const tagText = shown.translated ? translatedFrom(shown.from)
            : (shown.abandoned ? notTranslatedFrom(shown.from) : languageName(shown.from));
        const tag = translated && shown.from
            ? `<span class="ls-from${shown.abandoned ? ' ls-gaveup' : ''}" style="color:${fromColour};border-color:${fromColour}">`
              + `${escapeHtml(tagText)}</span> `
            : '';
        return [{ key: row.key, html: `<span class="ls-line${translated ? ' ls-translated' : ''}">`
            + `<span class="ls-ts">[${row.stamp}]</span> `
            + (row.showSpeaker ? `<span class="ls-speaker">${escapeHtml(row.speakerName)}:</span> ` : '')
            + tag
            + `<span class="ls-body">${escapeHtml(shown.text)}</span>`
            + `</span>` }];
    });
}

const AT_BOTTOM_SLACK = 64;

function isAtBottom(el) {
    return !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < AT_BOTTOM_SLACK;
}

function trackFollow(el) {
    if (!el || el.dataset.followWired === '1') return;
    el.dataset.followWired = '1';
    el.dataset.follow = '1';
    el.addEventListener('scroll', () => {
        el.dataset.follow = isAtBottom(el) ? '1' : '0';
    }, { passive: true });
}

function isFollowing(el) {
    return !el || el.dataset.follow !== '0';
}

function followNewest(el) {
    if (el) el.scrollTop = el.scrollHeight;
}

const rowHtml = new WeakMap();

export function syncRows(container, rows) {
    const wanted = new Set(rows.map(row => row.key));
    for (const child of [...container.children]) {
        if (!wanted.has(child.dataset.key)) container.removeChild(child);
    }
    let index = 0;
    for (const row of rows) {
        const existing = container.children[index];
        if (existing && existing.dataset.key === row.key) {
            if (rowHtml.get(existing) !== row.html) {
                existing.innerHTML = row.html;
                rowHtml.set(existing, row.html);
            }
            index++;
            continue;
        }
        const node = document.createElement('div');
        node.className = 'ls-row';
        node.dataset.key = row.key;
        rowHtml.set(node, row.html);
        node.innerHTML = row.html;
        container.insertBefore(node, existing || null);
        index++;
    }
    while (container.children.length > index) container.removeChild(container.lastChild);
}

function singleRows(labelled) {
    return labelled.map(line => ({
        key: line.key,
        html: line.system
            ? `<span class="ls-line ls-system"><span class="ls-ts">[${fmtDur(line.startSec * 1000)}]</span> `
              + `🗣️ ${escapeHtml(line.text)}</span>`
            : `<span class="ls-line">${line.gap ? '<span class="ls-gap">…</span> ' : ''}`
              + `<span class="ls-ts">[${fmtDur(line.startSec * 1000)}]</span> `
              + (line.showSpeaker ? `<span class="ls-speaker">${escapeHtml(speakerDisplayName(state.diarization, line.speaker))}:</span> ` : '')
              + `${escapeHtml(line.text)}</span>`
    }));
}

let previewNode = null;

function paintPreview(container) {
    if (!state.preview) {
        if (previewNode && previewNode.parentNode === container) container.removeChild(previewNode);
        return;
    }
    if (!previewNode) {
        previewNode = document.createElement('span');
        previewNode.className = 'ls-preview';
        previewNode.setAttribute('aria-label', 'Still being spoken');
    }
    if (previewNode.textContent !== state.preview) previewNode.textContent = state.preview;
    if (container.lastChild !== previewNode) container.appendChild(previewNode);
}

function ensurePanel(host, target, colour, position, heading = languageName(target)) {
    let panel = host.querySelector(`.ls-panel[data-lang="${CSS.escape(target)}"]`);
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'ls-panel';
        panel.dataset.lang = target;
        panel.innerHTML = `<div class="ls-panel-head"></div>`
            + `<div class="ls-panel-body" data-lang="${escapeAttr(target)}"></div>`;
        host.appendChild(panel);
        panel.dataset.fresh = '1';
    }
    trackFollow(panel.querySelector('.ls-panel-body'));
    const head = panel.querySelector('.ls-panel-head');
    if (head && head.textContent !== heading) head.textContent = heading;
    panel.style.setProperty('--ls-lang', colour);
    if (host.children[position] !== panel) host.insertBefore(panel, host.children[position] || null);
    return panel;
}

function paintText() {
    const nodes = panelElements();
    if (!nodes.text || !nodes.body) return;
    trackFollow(nodes.body);
    const atBottom = isFollowing(nodes.body);

    const all = state.backfillLines.length
        ? [...state.backfillLines, ...state.lines].sort((a, b) => a.startSec - b.startSec)
        : state.lines;
    const labelled = speakerDetectionEnabled()
        ? decorateLines(all, state.diarization)
        : all.map(line => ({ ...line, speaker: null, showSpeaker: false }));
    const panels = panelCount();
    const targets = panels ? currentPanelLanguages(panels) : [];
    const rows = labelled.map(line => ({
        key: line.key,
        text: line.text,
        language: line.language || null,
        system: !!line.system,
        panelOnly: line.panelOnly || null,
        tone: line.tone || (line.ok ? 'ok' : 'error'),
        hint: line.hint || '',
        stamp: fmtDur(line.startSec * 1000),
        showSpeaker: !!line.showSpeaker,
        speakerName: line.showSpeaker ? speakerDisplayName(state.diarization, line.speaker) : ''
    }));
    if (targets.length > 1) {
        const grid = panelGrid(targets.length);
        let host = nodes.text.querySelector('.ls-panels');
        if (!host) {
            nodes.text.innerHTML = '';
            host = document.createElement('div');
            host.className = 'ls-panels';
            nodes.text.appendChild(host);
        }
        host.style.setProperty('--ls-cols', grid.columns);
        host.style.setProperty('--ls-rows', grid.rows);
        nodes.text.classList.add('panelled');
        if (nodes.body) nodes.body.classList.add('panelled');

        const firstSeen = firstSeenOrder(state.languages);
        const base = baseLanguage();
        targets.forEach((target, position) => {
            const counts = untranslatedCounts(rows, target,
                { translations: state.translations, gaveUp: state.translateGaveUp });
            const panel = ensurePanel(host, target, languageColour(target, firstSeen), position,
                                      panelHeading(target, counts, state.panelActivity[target], base,
                                                   state.translateCause));
            const body = panel.querySelector('.ls-panel-body');
            const follow = panel.dataset.fresh === '1' || isFollowing(body);
            syncRows(body, renderPanelRows(rows, target, firstSeen));
            if (follow) followNewest(body);
            delete panel.dataset.fresh;
        });
        for (const panel of [...host.children]) {
            if (!targets.includes(panel.dataset.lang)) host.removeChild(panel);
        }
        for (const target of rotateTargets(targets, state.translateTurn)) requestTranslations(rows, target);
    } else {
        nodes.text.classList.remove('panelled');
        if (nodes.body) nodes.body.classList.remove('panelled');
        syncRows(nodes.text, singleRows(labelled));
        paintPreview(nodes.text);
    }
    paintSpeakers();

    if (atBottom) followNewest(nodes.body);
}

function labelledSnapshot() {
    const all = transcriptSnapshot(state);
    return speakerDetectionEnabled()
        ? decorateLines(all, state.diarization)
        : all.map(line => ({ ...line, speaker: null, showSpeaker: false }));
}

function transcriptRow(line, text) {
    return `[${fmtDur(line.startSec * 1000)}] `
        + (line.showSpeaker ? `${speakerDisplayName(state.diarization, line.speaker)}: ` : '')
        + text;
}

function lineIn(line, target) {
    const done = lineTranslation(line, target, state.translations);
    if (done) return done;
    const shown = renderedText(line, target, state.translations, { gaveUp: state.translateGaveUp });
    return shown.pending || shown.abandoned
        ? `${shown.text} [${languageName(shown.from || target)}, not translated]`
        : shown.text;
}

export function liveScribeTranscriptText() {
    const labelled = labelledSnapshot();
    const body = labelled.map(line => transcriptRow(line, line.text)).join('\n');
    const spoken = state.preview ? `${body}${body ? '\n' : ''}[…] ${state.preview}` : body;

    const targets = panelCount() ? currentPanelLanguages(panelCount()) : [];
    if (targets.length < 2) return spoken;

    const sections = targets.map(target => {
        const rendered = labelled.map(line => transcriptRow(line, lineIn(line, target))).join('\n');
        return `── ${languageLabel(target, baseLanguage())} ──\n${rendered}`;
    });
    return `── As spoken (each line in the language it was said in) ──\n${spoken}\n\n${sections.join('\n\n')}`;
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', async (event) => {
        const button = event.target.closest && event.target.closest('#live-scribe-copy');
        if (!button) return;
        const text = liveScribeTranscriptText();
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = '✓';
            button.classList.add('done');
        } catch (_) {
            button.textContent = '✗';
        }
        setTimeout(() => { button.textContent = '📋'; button.classList.remove('done'); }, 1500);
    });
}

function paintMeter() {
    const nodes = panelElements();
    if (!nodes.meter) return;
    const speaking = state.speech.speaking;
    const width = Math.min(100, Math.round(Math.sqrt(Math.min(1, state.speech.level * 8)) * 100));
    nodes.meter.style.width = `${width}%`;
    nodes.meter.classList.toggle('speaking', speaking);
    if (nodes.hearing) {
        nodes.hearing.textContent = speaking ? '🎙️ hearing you…' : '· quiet ·';
        nodes.hearing.classList.toggle('speaking', speaking);
    }
}

function showPanel(show) {
    document.body.classList.toggle('live-scribe-on', !!show);
    const nodes = panelElements();
    if (nodes.root) nodes.root.setAttribute('aria-hidden', show ? 'false' : 'true');
}

export function setVisualizerFullscreen(on) {
    document.body.classList.toggle('viz-fullscreen', !!on);
}

export function isLiveScribeActive() { return state.active; }

function liveScribeDiarization() { return diarizationStats(state.diarization); }
if (typeof window !== 'undefined') window.myAIDiarization = liveScribeDiarization;

function bufferedSec() {
    return state.sampleRate > 0 ? state.bufferLength / state.sampleRate : 0;
}

function takeFromBuffer(samples) {
    const out = new Float32Array(samples);
    let written = 0;
    while (written < samples && state.buffer.length) {
        const head = state.buffer[0];
        const take = Math.min(head.length, samples - written);
        out.set(head.subarray(0, take), written);
        written += take;
        if (take === head.length) state.buffer.shift();
        else state.buffer[0] = head.subarray(take);
    }
    state.bufferLength -= written;
    return written === samples ? out : out.subarray(0, written);
}

function dropFromBuffer(samples) {
    takeFromBuffer(samples);
    // The carry is the end of the audio before the dropped stretch; glued to the audio after it,
    // the server would hear a splice and the carried words would come back as a new line.
    state.carry = null;
    state.pendingGap = true;
    const seconds = samples / state.sampleRate;
    state.consumedSec += seconds;
    state.droppedSec += seconds;
    setStatus(`⚠️ server behind - ${Math.round(state.droppedSec)}s skipped here, transcribed after recording`);
}

export function pushLivePcm(chunk, sampleRate) {
    if (!state.active || !(chunk instanceof Float32Array) || chunk.length === 0) return;
    try {
        if (sampleRate > 0) state.sampleRate = sampleRate;
        state.buffer.push(chunk);
        state.bufferLength += chunk.length;

        let sum = 0;
        for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
        state.speech = nextSpeechState(state.speech, Math.sqrt(sum / chunk.length), Date.now());

        pump();
    } catch (err) {
        console.warn('Live transcription could not accept audio:', err);
    }
}

function pump() {
    if (!state.active) return;
    pumpPreview();
    const plan = planLiveWindow({
        bufferedSec: bufferedSec(),
        inFlight: state.inFlight,
        stopping: state.stopping
    });
    if (plan.dropSec > 0) dropFromBuffer(Math.floor(plan.dropSec * state.sampleRate));
    if (!plan.send) return;

    const samples = Math.floor(plan.sendSec * state.sampleRate);
    if (samples <= 0) return;
    const core = takeFromBuffer(samples);
    if (core.length === 0) return;

    const carry = state.carry;
    const window = carry && carry.length
        ? (() => {
            const merged = new Float32Array(carry.length + core.length);
            merged.set(carry, 0);
            merged.set(core, carry.length);
            return merged;
        })()
        : core;

    const overlapSamples = Math.min(core.length, Math.floor(OVERLAP_SEC * state.sampleRate));
    state.carry = overlapSamples > 0 ? core.slice(core.length - overlapSamples) : null;

    const gap = state.pendingGap;
    state.pendingGap = false;
    const windowStartSec = state.originSec
        + Math.max(0, state.consumedSec - (carry ? carry.length / state.sampleRate : 0));
    const coreStartSec = state.originSec + state.consumedSec;
    state.consumedSec += core.length / state.sampleRate;
    enqueueWindow(window, gap, windowStartSec, coreStartSec, state.originSec + state.consumedSec)
        .catch(err => console.warn('Live transcription could not prepare a window:', err));

    pump();
}

function abandonWindowIndex(index, recId, epoch) {
    if (!state.active || state.recId !== recId || state.epoch !== epoch) return;
    state.droppedWindows++;
    state.pending.set(index, { items: [], gap: true });
    flushPending();
}

async function enqueueWindow(window, gap, windowStartSec, coreStartSec, coreEndSec) {
    const sourceRate = state.sampleRate;
    const recId = state.recId;
    const epoch = state.epoch;
    const index = state.nextIndex++;
    state.preparing++;
    try {
        let resampled;
        try {
            resampled = await resamplePcmTo16k(window, window.length, sourceRate);
        } catch (err) {
            abandonWindowIndex(index, recId, epoch);
            throw err;
        }
        if (!state.active || state.recId !== recId || state.epoch !== epoch) {
            abandonWindowIndex(index, recId, epoch);
            return;
        }
        const blob = encodeMonoWav(resampled, 16000);
        const coreFrom = Math.max(0, Math.round((coreStartSec - windowStartSec) * 16000));
        const coreLevel = summarizeChunkLevel(resampled.subarray(Math.min(coreFrom, resampled.length)));

        state.queue.push({ index, blob, bytes: queuedWindowBytes(blob, resampled), gap, windowStartSec, coreStartSec,
                           coreEndSec, pcm16k: resampled, coreLevel, envelope: levelEnvelope(resampled, 16000) });
        releaseReviewAudioOfWaitingWindows(state.queue);
        const capped = capRetryQueue(state.queue);
        state.queue = capped.queue;
        for (const lost of capped.dropped) {
            state.droppedWindows++;
            state.pending.set(lost.index, { items: [], gap: true });
        }
        if (capped.dropped.length) flushPending();
        drain();
    } finally {
        if (state.epoch === epoch) state.preparing--;
    }
}

function drain() {
    if (!state.active) return;
    const plan = planUpload({
        queued: state.queue.length,
        inFlight: state.inFlight,
        now: Date.now(),
        nextAttemptAt: state.nextAttemptAt,
        online: state.online
    });
    paintConnection();
    if (!plan.send) {
        if (plan.waitMs > 0 && !state.retryTimer) {
            state.retryTimer = setTimeout(() => { state.retryTimer = null; drain(); }, plan.waitMs);
        }
        return;
    }
    const item = state.queue.shift();
    if (!item) return;
    send(item);
    drain();
}

function flushPending() {
    const { ready, nextIndex, covered } = settleLiveWindows(state.pending, state.nextAppendIndex);
    state.nextAppendIndex = nextIndex;
    state.coverage.push(...covered);
    for (const entry of ready) {
        if (!entry.items.length) {
            // A window that was heard and held nothing new is not a gap: only a window whose audio
            // was dropped or left for later (no coverage), or one that came after dropped audio,
            // marks the next line.
            if (!entry.coverage || entry.gap) state.gapBeforeNext = true;
            else state.recentReviewWindows = [];
            if (entry.note) echoCommand(entry.note, entry.noteAtSec, 'warn');
            continue;
        }
        const afterGap = state.gapBeforeNext;
        state.gapBeforeNext = false;
        const next = appendLiveLines(state, entry.items, {
            gap: entry.gap || afterGap,
            seamUntilSec: afterGap ? null : entry.seamUntilSec
        });
        state.lines = next.lines;
        state.tail = next.tail;
        if (next.dropped) {
            state.archivedLines = archiveDroppedLines(state.archivedLines, next.droppedLines, state.translations,
                                                     translatedLanguages());
            pruneDroppedLines();
        }
        handleSpokenInstructions(entry.items);

        if (entry.gap || afterGap) state.recentReviewWindows = [];
        if (entry.reviewWindow && !entry.gap) {
            const keys = entry.items.map(item => item.key);
            const displayText = spokenTextOf(keys);
            const current = { ...entry.reviewWindow, keys, displayText };
            const previous = state.recentReviewWindows[state.recentReviewWindows.length - 1];
            if (previous && displayText) {
                const candidate = findBoundaryRepetition(previous.displayText, displayText);
                if (candidate) queueRepetitionReview(previous, current, candidate);
            }
            state.recentReviewWindows.push(current);
            if (state.recentReviewWindows.length > 3) state.recentReviewWindows.shift();
        }
    }
    if (ready.length) { state.preview = ''; paintText(); }
}

function invalidateTranslationsFor(keys) {
    const prefixes = (keys || []).map(key => `${key}::`);
    for (const key of Object.keys(state.translations)) {
        if (prefixes.some(prefix => key.startsWith(prefix))) delete state.translations[key];
    }
    for (const key of Object.keys(state.translateTries)) {
        if (prefixes.some(prefix => key.startsWith(prefix))) delete state.translateTries[key];
    }
    for (const key of [...state.translateGaveUp]) {
        if (prefixes.some(prefix => key.startsWith(prefix))) state.translateGaveUp.delete(key);
    }
}

function rebuildLiveTail() {
    const words = state.lines.filter(line => !line.system && line.text)
        .flatMap(line => String(line.text).trim().split(/\s+/).filter(Boolean));
    state.tail = words.slice(-40).join(' ');
}

function spokenTextOf(keys) {
    return state.lines.filter(line => keys.includes(line.key) && !line.system)
        .map(line => line.text).join(' ').trim();
}

function queueRepetitionReview(previous, current, candidate) {
    state.refineQueue.push({ previous, current, candidate, recId: state.recId });
    if (state.refineQueue.length > 4) state.refineQueue.shift();
    drainRepetitionReviews();
}

async function drainRepetitionReviews() {
    if (state.refineInFlight || !state.active) return;
    const job = state.refineQueue.shift();
    if (!job) return;
    state.refineInFlight = true;
    try {
        const merged = mergeTimedPcm([job.previous, job.current], 16000);
        if (!merged.pcm.length || state.recId !== job.recId) return;
        const result = await transcribeChunkServer(
            job.recId, -1000 - state.refineSeq++, merged.pcm,
            state.controller ? state.controller.signal : undefined, LIVE_REQUEST_TIMEOUT_MS
        );
        if (!state.active || state.recId !== job.recId) return;
        if (spokenTextOf(job.previous.keys) !== job.previous.displayText
            || spokenTextOf(job.current.keys) !== job.current.displayText) return;
        const original = `${job.previous.displayText} ${job.current.displayText}`.trim();
        if (!preferWiderRecheck(original, result.text || '', job.candidate)) return;

        const revised = replaceWindowLines(state.lines, job.previous.keys, job.current.keys, result.text);
        if (!revised.changed.length) return;
        state.lines = revised.lines;
        invalidateTranslationsFor(revised.changed);
        rebuildLiveTail();
        paintText();
        setStatus('↻ repeated phrase replaced by what a wider listen heard');
    } catch (err) {
        if (!(err && err.name === 'AbortError')) console.debug('Live repetition recheck skipped:', err);
    } finally {
        state.refineInFlight = false;
        if (state.active) drainRepetitionReviews();
    }
}

const BACKFILL_MAX_CHARS = 20000;

function capBackfillLines() {
    let chars = 0;
    for (const line of state.backfillLines) chars += String(line.text || '').length;
    if (chars <= BACKFILL_MAX_CHARS) return;
    const kept = [];
    let running = 0;
    for (let i = state.backfillLines.length - 1; i >= 0; i--) {
        const line = state.backfillLines[i];
        running += String(line.text || '').length;
        if (running > BACKFILL_MAX_CHARS && kept.length) break;
        kept.unshift(line);
    }
    const dropped = state.backfillLines.slice(0, state.backfillLines.length - kept.length);
    state.backfillLines = kept;
    if (dropped.length) {
        state.archivedLines = archiveDroppedLines(state.archivedLines, dropped, state.translations, translatedLanguages());
    }
}

function pruneDroppedLines() {
    const live = new Set([...state.backfillLines, ...state.lines].map(line => line.key));
    const lineOf = key => {
        const cut = String(key).lastIndexOf('::');
        return cut < 0 ? String(key) : String(key).slice(0, cut);
    };
    for (const key of Object.keys(state.translations)) {
        if (!live.has(lineOf(key))) delete state.translations[key];
    }
    for (const key of Object.keys(state.translateTries)) {
        if (!live.has(lineOf(key))) delete state.translateTries[key];
    }
    for (const key of [...state.translateGaveUp]) {
        if (!live.has(lineOf(key))) state.translateGaveUp.delete(key);
    }
}

function paintConnection() {
    const connection = describeConnection({
        online: state.online,
        queued: state.queue.length + state.inFlight,
        attempt: state.attempt,
        droppedWindows: state.droppedWindows,
        nowMs: Date.now(),
        nextAttemptAt: state.nextAttemptAt,
        autoTranscribe: autoTranscribeAfterRecording()
    });
    const note = connection || state.backfillNote || null;
    const nodes = panelElements();
    if (nodes.root) nodes.root.classList.toggle('offline', !!connection && state.attempt > 0);
    setStatus(note || state.status || '📝 listening…');
}

function peekTail(samples) {
    const total = Math.min(samples, state.bufferLength);
    const out = new Float32Array(total);
    let remaining = total;
    let write = total;
    for (let i = state.buffer.length - 1; i >= 0 && remaining > 0; i--) {
        const part = state.buffer[i];
        const take = Math.min(part.length, remaining);
        write -= take;
        out.set(part.subarray(part.length - take), write);
        remaining -= take;
    }
    return out;
}

function translationBoxesShown() {
    const panels = panelCount();
    return panels > 0 && currentPanelLanguages(panels).length > 1;
}

function pumpPreview() {
    if (!state.active) return;
    if (!state.online || state.attempt > 0 || state.queue.length > 0) return;
    const plan = planPreviewRequest({
        pendingSec: bufferedSec(),
        previewInFlight: state.previewInFlight,
        sinceLastMs: Date.now() - state.previewAt,
        stopping: state.stopping,
        shown: !translationBoxesShown(),
        hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        heardSpeech: state.speech.speaking || state.speech.speakingUntil > state.previewAt,
        windowSlotFree: state.inFlight < MAX_IN_FLIGHT
    });
    if (!plan.send) return;
    const audio = peekTail(Math.floor(plan.sec * state.sampleRate));
    if (audio.length === 0) return;
    const epoch = state.epoch;
    state.previewInFlight = true;
    state.previewAt = Date.now();
    sendPreview(audio).finally(() => {
        if (epoch !== state.epoch) return;
        state.previewInFlight = false;
        if (state.active) pumpPreview();
    });
}

async function sendPreview(audio) {
    const epoch = state.epoch;
    const recId = state.recId;
    try {
        const resampled = await resamplePcmTo16k(audio, audio.length, state.sampleRate);
        if (epoch !== state.epoch || !state.active || state.recId !== recId) return;
        const result = await transcribeChunkServer(
            recId, -1, resampled, state.controller ? state.controller.signal : undefined,
            LIVE_REQUEST_TIMEOUT_MS
        );
        if (epoch !== state.epoch || !state.active || state.recId !== recId) return;
        const preview = capLiveText(String(result.text || '').trim(), 600);
        if (preview === state.preview) return;
        state.preview = preview;
        paintText();
    } catch (_) {
    }
}

function skipWindow(item) {
    state.droppedWindows++;
    const from = fmtDur(Math.max(0, item.coreStartSec || 0) * 1000);
    const to = fmtDur(Math.max(0, item.coreEndSec || 0) * 1000);
    state.pending.set(item.index, {
        items: [], gap: true, noteAtSec: item.coreStartSec || 0,
        note: `the server kept failing on ${from}-${to} while it answered the rest; `
            + afterRecordingFate(autoTranscribeAfterRecording()).part
    });
    flushPending();
}

async function send(item) {
    const epoch = state.epoch;
    state.inFlight++;
    const recId = state.recId;
    if (!Number.isFinite(item.seenAnswered)) item.seenAnswered = state.answered;
    try {
        if (state.status.startsWith('⚠️') || state.attempt > 0) setStatus('📡 reconnecting…');
        const result = await transcribeBlobServer(
            recId, item.index, item.blob, state.controller ? state.controller.signal : undefined,
            LIVE_REQUEST_TIMEOUT_MS
        );
        if (epoch !== state.epoch || !state.active || state.recId !== recId) return;

        state.answered++;
        state.attempt = 0;
        state.nextAttemptAt = 0;
        if (result.language) {
            state.languages = addLanguageHeard(state.languages, result.language, result.text || '');
            paintLanguages();
            noticePanelsAreOff(item.coreStartSec || 0);
        }

        const chunk = { startSec: item.windowStartSec, coreSec: item.coreStartSec, coreEndSec: item.coreEndSec };
        const picked = pickCoreSegments(result, chunk, {
            reachIntoCoreSec: LIVE_CORE_REACH_SEC, coreLevel: item.coreLevel, envelope: item.envelope
        });
        const items = picked.segments.length
            ? picked.segments.map((segment, n) => ({
                key: `w${epoch}.${item.index}:${n}`,
                startSec: item.windowStartSec + segment.start,
                endSec: item.windowStartSec + segment.end,
                text: segment.text,
                embedding: segment.embedding,
                language: result.language || null
            }))
            : picked.useText
                ? [{ key: `w${epoch}.${item.index}:0`, startSec: item.coreStartSec, endSec: item.coreEndSec,
                     text: result.text || '', language: result.language || null }]
                : [];
        learnSpeakers(items);

        state.pending.set(item.index, {
            items, gap: item.gap,
            seamUntilSec: item.windowStartSec < item.coreStartSec ? item.coreStartSec : null,
            coverage: { fromSec: item.coreStartSec, toSec: item.coreEndSec },
            reviewWindow: item.pcm16k instanceof Float32Array
                ? { index: item.index, startSec: item.windowStartSec, pcm: item.pcm16k }
                : null
        });
        flushPending();
        setStatus('📝 listening…');
    } catch (err) {
        if (epoch !== state.epoch) return;
        if (!state.active) return;
        if (err && err.name === 'AbortError') return;
        const verdict = judgeWindowFailure(item, state.answered);
        item.strikes = verdict.strikes;
        item.seenAnswered = verdict.seenAnswered;
        if (verdict.giveUp) {
            console.warn(`Live transcription: the server failed on window ${item.index + 1} while answering others; `
                + 'leaving it to the transcription after recording:', err);
            skipWindow(item);
        } else {
            state.queue.unshift(item);
            state.attempt++;
            state.nextAttemptAt = Date.now() + retryDelayMs(state.attempt);
        }
        paintConnection();
    } finally {
        if (epoch === state.epoch) {
            state.inFlight--;
            if (state.active) { drain(); pump(); }
        }
    }
}

function handleOnline() {
    state.online = true;
    state.attempt = 0;
    state.nextAttemptAt = 0;
    state.translateFailures = 0;
    state.translateNextAt = 0;
    if (state.active) { paintConnection(); drain(); paintText(); }
}
function handleOffline() {
    state.online = false;
    if (state.active) paintConnection();
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
}

export function startLiveScribe(recId, sampleRate, originSec = 0) {
    if (state.active && state.recId === recId) return true;
    if (!confirmServerProcessing()) return false;

    const resuming = state.recId === recId && (state.lines.length > 0 || state.coverage.length > 0);
    const carried = resuming ? carryAcrossResume(state) : {};

    stopLiveScribe({ keepText: false, keepRowsOnScreen: true });
    if (state.translateWake) { clearTimeout(state.translateWake); state.translateWake = null; }
    Object.assign(state, freshSession(settingsPolicy()), carried, {
        active: true,
        recId,
        originSec: Math.max(0, Number(originSec) || 0),
        sampleRate: sampleRate || 48000,
        controller: new AbortController(),
        online: typeof navigator === 'undefined' || navigator.onLine !== false
    });

    paintText();
    if (panelCount() >= 2) {
        warmAiModel(state.controller.signal)
            .catch(err => { if (!err || err.name !== 'AbortError') console.info('AI model warm-up:', err); });
    }
    setStatus(`📝 listening… (lines settle every ${WINDOW_SEC}s)`);
    showPanel(true);
    if (state.meterTimer) clearInterval(state.meterTimer);
    state.meterTimer = setInterval(paintMeter, 100);
    return true;
}

export function stopLiveScribe({ keepText = true, keepRowsOnScreen = false } = {}) {
    const wasActive = state.active;
    state.active = false;
    state.epoch++;
    state.stopping = false;
    if (state.controller) { try { state.controller.abort(); } catch (_) {} }
    state.controller = null;
    state.buffer = [];
    state.bufferLength = 0;
    state.carry = null;
    state.inFlight = 0;
    state.preparing = 0;
    state.queue = [];
    state.pending = new Map();
    state.attempt = 0;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    state.previewInFlight = false;
    state.preview = '';
    if (!keepText) state.recId = null;
    if (state.meterTimer) { clearInterval(state.meterTimer); state.meterTimer = null; }
    state.speech = { floor: 0, level: 0, speaking: false, speakingUntil: 0 };
    paintMeter();
    if (!keepText) {
        state.lines = [];
        state.archivedLines = [];
        state.coverage = [];
        state.backfillLines = [];
        state.originSec = 0;
        state.consumedSec = 0;
        state.tail = '';
    }
    if (keepRowsOnScreen) return wasActive;
    paintText();
    if (!keepText || !wasActive) showPanel(false);
    return wasActive;
}

export async function flushLiveScribe(timeoutMs = 2500) {
    if (!state.active) return;
    state.stopping = true;
    setStatus('📝 finishing…');
    pump();

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (state.active && Date.now() < deadline) {
        if (state.inFlight === 0 && state.preparing === 0 && state.bufferLength === 0 && state.queue.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
        pump();
        drain();
    }
    const unsent = state.queue.length + state.inFlight + state.preparing;
    if (unsent > 0 || state.bufferLength > 0) {
        setStatus(`📝 ${Math.max(1, unsent)} window(s) unsent - ${afterRecordingFate(autoTranscribeAfterRecording()).unsent}`);
    }
}

export function liveTranscriptSizeAndSignature() {
    let chars = 0;
    let lines = 0;
    for (const list of [state.archivedLines, state.backfillLines, state.lines]) {
        for (const line of list || []) {
            if (!line || line.system) continue;
            lines++;
            chars += String(line.text || '').length;
            if (line.translations) for (const text of Object.values(line.translations)) chars += String(text || '').length;
        }
    }
    let translated = 0;
    for (const text of Object.values(state.translations || {})) { translated++; chars += String(text || '').length; }
    const last = state.lines[state.lines.length - 1];
    return { chars, signature: `${lines}:${translated}:${last ? last.key : ''}:${state.coverage.length}` };
}

export function liveScribeResult() {
    const labelled = labelledSnapshot();
    if (!labelled.length) return null;
    const targets = panelCount() ? currentPanelLanguages(panelCount()) : [];
    return {
        lines: labelled.map(line => {
            const speakerLabel = line.showSpeaker ? speakerDisplayName(state.diarization, line.speaker) : '';
            return {
                startSec: line.startSec, endSec: line.endSec,
                text: speakerLabel ? `${speakerLabel}: ${line.text}` : line.text,
                ...(speakerLabel ? { speakerLabel } : {}),
                language: line.language || null,
                translations: targets.reduce((out, target) => {
                    const done = lineTranslation(line, target, state.translations);
                    if (done) out[target] = done;
                    return out;
                }, {})
            };
        }),
        languages: targets,
        coverage: mergeIntervals(state.coverage)
    };
}

let _audioSource = async () => null;
export function setLiveScribeAudioSource(fn) { _audioSource = fn; }

const BACKFILL_WINDOW_SEC = 30;
const BACKFILL_OVERLAP_SEC = 2;
const BACKFILL_MIN_SEC = 0.2;

export function backfillLiveScribe(recId, uptoSec) {
    return runBackfill(recId, uptoSec).catch(err => {
        console.warn('Live transcription backfill failed:', err);
        setStatus(`⚠️ could not transcribe the audio from before you pressed 📝 (${err.message}) - it will be transcribed after the recording`);
    });
}

async function runBackfill(recId, uptoSec) {
    const epoch = state.epoch;
    if (state.backfillEpoch === epoch || uptoSec <= BACKFILL_MIN_SEC) return;
    const gaps = invertCoverage(state.coverage, uptoSec, BACKFILL_MIN_SEC);
    if (!gaps.length) return;

    const current = () => state.active && state.recId === recId && state.epoch === epoch;
    state.backfillEpoch = epoch;
    try {
        const blob = await _audioSource(recId);
        if (!blob || !current()) return;

        let loadAudio = null;
        const pcm = await inspectPcmWav(blob);
        if (pcm) {
            loadAudio = chunk => resamplePcmWavRangeTo16k(blob, pcm, chunk.startSec, chunk.endSec);
        } else {
            let webm = null;
            try {
                webm = await prepareWebmChunkSource(blob, uptoSec * 1000, { tolerateTruncation: true });
            } catch (err) {
                console.warn('Backfill could not index the prefix; decoding it whole:', err);
            }
            if (webm) {
                loadAudio = chunk => resampleWebmRangeTo16k(webm, chunk.startSec, Math.min(chunk.endSec, webm.durationSec));
            } else {
                const plan = planWholeFileDecode({ durationMs: Math.max(1, uptoSec * 1000) });
                if (!plan.allowed) throw new Error(plan.reason);
                const whole = await resampleTo16k(blob);
                loadAudio = chunk => whole.slice(
                    Math.max(0, Math.round(chunk.startSec * 16000)),
                    Math.min(whole.length, Math.round(chunk.endSec * 16000)));
            }
        }

        const chunks = planChunksForRanges(gaps, 16000, BACKFILL_WINDOW_SEC, BACKFILL_OVERLAP_SEC);
        const seam = createSeamState();
        let done = 0;
        for (const chunk of chunks) {
            if (!current()) return;
            while (current() && (state.queue.length > 0 || state.attempt > 0 || !state.online)) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!current()) return;

            state.backfillNote = `⏪ catching up on earlier audio · ${done}/${chunks.length}`;
            paintConnection();
            try {
                const audio = await loadAudio(chunk);
                const result = await transcribeChunkServer(
                    recId, chunk.idx, audio,
                    state.controller ? state.controller.signal : undefined, LIVE_REQUEST_TIMEOUT_MS);
                if (!current()) return;

                const language = result.language || null;
                if (language) {
                    state.languages = addLanguageHeard(state.languages, language, result.text || '');
                    paintLanguages();
                }
                const picked = pickCoreSegments(result, chunk, {
                    coreLevel: summarizeChunkLevel(chunkCoreSamples(audio, chunk)), envelope: levelEnvelope(audio, 16000)
                });
                const items = picked.segments.length
                    ? picked.segments.map((segment, n) => ({
                        key: `b${epoch}.${chunk.idx}:${n}`,
                        startSec: chunk.startSec + segment.start,
                        endSec: chunk.startSec + segment.end,
                        text: String(segment.text || '').trim(),
                        embedding: segment.embedding,
                        language
                    }))
                    : picked.useText
                        ? [{ key: `b${epoch}.${chunk.idx}:0`, startSec: chunk.coreSec, endSec: chunk.coreEndSec,
                             text: String(result.text || '').trim(), language }]
                        : [];
                learnSpeakers(items);
                for (const item of items) {
                    const text = passSeam(seam, { heardIn: `chunk:${chunk.idx}`, startSec: item.startSec,
                                                  endSec: item.endSec, text: item.text });
                    if (text) {
                        state.backfillLines.push({ key: item.key, startSec: item.startSec, endSec: item.endSec,
                                                   text, language: item.language });
                    }
                }
                capBackfillLines();
                const reached = Math.min(chunk.coreEndSec, chunk.startSec + (audio.length / 16000));
                if (reached > chunk.coreSec) {
                    state.coverage.push({ fromSec: chunk.coreSec, toSec: reached });
                }
                paintText();
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                console.warn('Live transcription backfill window failed:', err);
            }
            done++;
        }
    } catch (err) {
        console.warn('Live transcription could not read earlier audio:', err);
    } finally {
        if (state.backfillEpoch === epoch) state.backfillEpoch = null;
        if (state.epoch === epoch) {
            state.backfillNote = '';
            if (state.active) paintConnection();
        }
    }
}

export function pauseLiveScribe() {
    stopLiveScribe({ keepText: true });
    showPanel(false);
}

export function closeLiveScribe() {
    stopLiveScribe({ keepText: false });
    showPanel(false);
}

