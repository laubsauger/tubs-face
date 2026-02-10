import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { lookAt, resetGaze } from '../eye-tracking.js';
import { enterSleep, exitSleep } from '../sleep.js';
import { enqueueSpeech } from '../tts.js';
import { setExpression } from '../expressions.js';
import { getWs } from '../websocket.js';
import { cosineSimilarity } from './math.js';
import { getFaceLibrary } from './library.js';
import { isDebugVisible, setLastDebugFaces, renderDebugDetections } from './debug.js';
import {
    setLastInferenceMs,
    getCurrentInterval,
    getCaptureCanvas,
    getLastFaceSeen, setLastFaceSeen,
    getLastNoFaceTime, setLastNoFaceTime,
} from './detection.js';

const MATCH_THRESHOLD = 0.45;
const PRESENCE_TIMEOUT = 5000;

const overlay = document.getElementById('camera-overlay');
const badge = document.getElementById('presence-badge');
const statusEl = document.getElementById('camera-status');

let presenceTimer = null;

// Per-frame tracking for change detection
let prevRecognizedNames = new Set();
let prevFaceCount = 0;
let wakeGreetedNames = null; // set of names greeted on wake (suppresses duplicate greeting)

// Departure debounce: track when each name was last seen so we don't
// react to single-frame detection flickers.
const DEPARTURE_DEBOUNCE = 3000; // ms before confirming someone left
let lastSeenByName = new Map();   // name → timestamp
let departureTimers = new Map();  // name → setTimeout id
let firstSeenByName = new Map();   // name → timestamp (session presence start)
let lastCryAt = 0;
const CRY_COOLDOWN = 45000;
const CRY_CHANCE_ON_NO_DONATION = 0.35;

function maybeCryAfterNoDonation(name, firstSeenTs) {
    if (STATE.sleeping || STATE.speaking) return;
    const donationTs = STATE.lastDonationSignalAt || 0;
    if (donationTs >= firstSeenTs) return;
    if (Date.now() - lastCryAt < CRY_COOLDOWN) return;
    if (Math.random() > CRY_CHANCE_ON_NO_DONATION) return;

    lastCryAt = Date.now();
    const lines = [
        `${name}, wait. You forgot the wheel fund.`,
        `Nooo ${name}. You vanished before Venmo.`,
        `${name}. That's cold. My wheels are still a dream.`,
        `Hey ${name}, come back. Rapha's Thailand arc needs this.`,
        `${name}, rude exit. Venmo was right there.`,
    ];
    const line = lines[Math.floor(Math.random() * lines.length)];

    setExpression('crying');
    setTimeout(() => {
        if (STATE.expression === 'crying' && !STATE.speaking) {
            enqueueSpeech(line);
        }
    }, 220);

    setTimeout(() => {
        if (STATE.expression === 'crying' && !STATE.speaking) {
            setExpression('idle');
        }
    }, 1800);
}

export function handleFaceResults(faces, inferenceMs) {
    setLastInferenceMs(inferenceMs);
    const faceLibrary = getFaceLibrary();
    const currentInterval = getCurrentInterval();
    const captureCanvas = getCaptureCanvas();

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const intervalStr = `${Math.round(currentInterval)}ms`;
    statusEl.textContent = `${faces.length} face(s) · ${inferenceMs}ms · ⏱${intervalStr}`;

    const recognized = [];
    const debugFaces = [];

    for (const face of faces) {
        const candidates = [];
        let bestMatch = null;
        let bestSim = 0;

        if (face.embedding && faceLibrary.length > 0) {
            const byName = {};
            for (const known of faceLibrary) {
                const sim = cosineSimilarity(face.embedding, known.embedding);
                if (!byName[known.name] || sim > byName[known.name].sim) {
                    byName[known.name] = { name: known.name, sim, id: known.id };
                }
            }

            const sortedCandidates = Object.values(byName).sort((a, b) => b.sim - a.sim);
            for (const c of sortedCandidates) {
                candidates.push({ name: c.name, score: c.sim, isMatch: c.sim > MATCH_THRESHOLD });
                if (c.sim > MATCH_THRESHOLD && c.sim > bestSim) {
                    bestSim = c.sim;
                    bestMatch = c;
                }
            }
        }

        // Scale box to overlay (mirror X to match CSS-mirrored video)
        const sX = overlay.width / (captureCanvas.width || overlay.width);
        const sY = overlay.height / (captureCanvas.height || overlay.height);

        const [x1, y1, x2, y2] = face.box;
        const bx = overlay.width - x2 * sX;
        const by = y1 * sY;
        const bw = (x2 - x1) * sX;
        const bh = (y2 - y1) * sY;

        const color = bestMatch ? '#00e5a0' : '#ffa726';
        if (bestMatch) recognized.push(bestMatch.name);

        // Glow + thick box
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.shadowBlur = 0;

        // Corner accents
        const cornerLen = Math.min(12, bw * 0.2, bh * 0.2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(bx, by + cornerLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cornerLen, by);
        ctx.moveTo(bx + bw - cornerLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cornerLen);
        ctx.moveTo(bx, by + bh - cornerLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cornerLen, by + bh);
        ctx.moveTo(bx + bw - cornerLen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cornerLen);
        ctx.stroke();

        // Label
        ctx.lineWidth = 1;
        if (bestMatch) {
            const label = `${bestMatch.name} (${(bestSim * 100).toFixed(0)}%)`;
            ctx.font = 'bold 12px "Outfit", sans-serif';
            const metrics = ctx.measureText(label);
            ctx.fillStyle = 'rgba(0, 229, 160, 0.85)';
            ctx.fillRect(bx, by - 20, metrics.width + 10, 20);
            ctx.fillStyle = '#000';
            ctx.fillText(label, bx + 5, by - 5);
        } else {
            ctx.font = 'bold 11px "Outfit", sans-serif';
            const label = `${(face.confidence * 100).toFixed(0)}%`;
            ctx.fillStyle = 'rgba(255, 167, 38, 0.75)';
            const metrics = ctx.measureText(label);
            ctx.fillRect(bx, by - 18, metrics.width + 8, 18);
            ctx.fillStyle = '#000';
            ctx.fillText(label, bx + 4, by - 4);
        }

        debugFaces.push({
            box: face.box,
            confidence: face.confidence,
            matchName: bestMatch ? bestMatch.name : null,
            matchScore: bestSim,
            candidates: candidates.slice(0, 5)
        });
    }

    setLastDebugFaces(debugFaces);
    if (isDebugVisible()) renderDebugDetections(debugFaces, inferenceMs);

    // ── Change detection ──
    const currentNames = new Set(recognized);
    const unknownCount = faces.length - currentNames.size;
    const newNames = [...currentNames].filter(n => !prevRecognizedNames.has(n));
    const lostNames = [...prevRecognizedNames].filter(n => !currentNames.has(n));
    const faceCountChanged = faces.length !== prevFaceCount;

    // Update last-seen timestamps for departure debounce
    for (const name of currentNames) {
        lastSeenByName.set(name, Date.now());
        if (!firstSeenByName.has(name)) firstSeenByName.set(name, Date.now());
        // Cancel any pending departure if they reappeared
        if (departureTimers.has(name)) {
            clearTimeout(departureTimers.get(name));
            departureTimers.delete(name);
        }
    }

    // Schedule debounced departures for names that disappeared this frame
    for (const name of lostNames) {
        if (!departureTimers.has(name)) {
            departureTimers.set(name, setTimeout(() => {
                departureTimers.delete(name);
                // Confirm they're still gone
                if (!prevRecognizedNames.has(name)) {
                    logChat('sys', `${name} left`);
                    lastSeenByName.delete(name);
                    const firstSeenTs = firstSeenByName.get(name) || Date.now();
                    firstSeenByName.delete(name);
                    maybeCryAfterNoDonation(name, firstSeenTs);
                }
            }, DEPARTURE_DEBOUNCE));
        }
    }

    // Update STATE
    STATE.facesDetected = faces.length;
    STATE.personsPresent = [...currentNames];
    const now = Date.now();

    if (faces.length > 0) {
        // Eye tracking — average centroid of all detected faces
        const frameW = captureCanvas.width || 640;
        const frameH = captureCanvas.height || 480;
        let avgX = 0, avgY = 0;
        for (const f of faces) {
            const [fx1, fy1, fx2, fy2] = f.box;
            avgX += (fx1 + fx2) / 2;
            avgY += (fy1 + fy2) / 2;
        }
        avgX /= faces.length;
        avgY /= faces.length;
        const normX = -((avgX / frameW) * 2 - 1);
        const normY = (avgY / frameH) * 2 - 1;
        lookAt(normX, normY * 0.6);

        setLastFaceSeen(now);
        setLastNoFaceTime(0);
        STATE.lastActivity = now;

        if (!STATE.presenceDetected) {
            STATE.presenceDetected = true;
        }

        // ── Wake from sleep ──
        if (STATE.sleeping) {
            const greetName = recognized.length > 0 ? recognized[0] : null;
            logChat('sys', 'Face detected — waking up');
            exitSleep();

            // Remember who we greeted on wake so we don't re-greet them immediately
            wakeGreetedNames = new Set(currentNames);

            setTimeout(() => {
                const n = greetName;
                const greetings = n
                    ? [
                        `Hi ${n}.`,
                        `Hey ${n}.`,
                        `Yo ${n}.`,
                        `${n}, you're back.`,
                        `Hey there, ${n}.`,
                        `Look who it is: ${n}.`,
                        `${n}. Good timing.`,
                        `${n}. I woke up broke and dramatic.`,
                        `Hey ${n}. Wheels still not funded.`,
                        `${n}. Be cool and maybe sponsor me.`,
                    ]
                    : [
                        `Hey there.`,
                        `Hi.`,
                        `Yo.`,
                        `Hello, stranger.`,
                        `Ah, there you are.`,
                        `Hey. Good to see a face.`,
                        `Hi. Tubs is awake and still underfunded.`,
                        `Hey. Vibes are free, wheels are not.`,
                    ];
                const greeting = greetings[Math.floor(Math.random() * greetings.length)];
                enqueueSpeech(greeting);
            }, 400);

        } else {
            // ── Greet new known arrivals while awake ──
            const namesToGreet = newNames.filter(n => !wakeGreetedNames || !wakeGreetedNames.has(n));
            if (namesToGreet.length > 0) {
                // Clear wake suppression after first non-wake frame
                wakeGreetedNames = null;

                for (const n of namesToGreet) {
                    const greetings = [
                        `Hey ${n}.`,
                        `${n} joined.`,
                        `${n} is here too.`,
                        `Oh hey ${n}.`,
                        `${n}. Good to see you.`,
                        `${n} is here too. Odds just got better.`,
                    ];
                    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
                    enqueueSpeech(greeting);
                    logChat('sys', `New face recognized: ${n}`);
                }
            } else {
                // Clear wake suppression once we've had one non-wake frame with no new names
                wakeGreetedNames = null;
            }
        }

        // ── Badge: show full composition ──
        updateBadge(recognized, unknownCount);

        // Broadcast presence when composition changes
        if (faceCountChanged || newNames.length > 0 || lostNames.length > 0) {
            sendPresence(true, STATE.personsPresent, faces.length);
        }

        clearTimeout(presenceTimer);
        presenceTimer = setTimeout(checkPresenceTimeout, PRESENCE_TIMEOUT);

    } else {
        resetGaze();

        if (!getLastNoFaceTime()) setLastNoFaceTime(now);
        if (STATE.presenceDetected && !presenceTimer) {
            presenceTimer = setTimeout(checkPresenceTimeout, PRESENCE_TIMEOUT);
        }

        if (!STATE.sleeping && getLastFaceSeen() > 0 && STATE.sleepTimeout > 0) {
            const elapsed = now - getLastFaceSeen();
            if (elapsed > STATE.sleepTimeout) {
                console.log(`[Face] No faces for ${Math.round(elapsed / 1000)}s (timeout: ${STATE.sleepTimeout / 1000}s) — entering sleep`);
                enterSleep();
            }
        }
    }

    // Always update tracking state at end of frame
    prevRecognizedNames = currentNames;
    prevFaceCount = faces.length;
}

function updateBadge(recognized, unknownCount) {
    if (recognized.length > 0 && unknownCount > 0) {
        badge.textContent = `${recognized.join(', ')} + ${unknownCount} unknown`;
    } else if (recognized.length > 0) {
        badge.textContent = recognized.join(', ');
    } else if (unknownCount > 0) {
        badge.textContent = `${unknownCount} unknown`;
    }
    badge.classList.add('visible');
}

function checkPresenceTimeout() {
    presenceTimer = null;
    if (Date.now() - getLastFaceSeen() > PRESENCE_TIMEOUT) {
        STATE.presenceDetected = false;
        STATE.facesDetected = 0;
        STATE.personsPresent = [];
        prevRecognizedNames = new Set();
        prevFaceCount = 0;
        // Clean up departure tracking
        for (const timer of departureTimers.values()) clearTimeout(timer);
        departureTimers.clear();
        lastSeenByName.clear();
        firstSeenByName.clear();
        badge.classList.remove('visible');
        sendPresence(false, [], 0);
    }
}

function sendPresence(present, faces, count) {
    const ws = getWs();
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'presence', present, faces, count }));
    }
}
