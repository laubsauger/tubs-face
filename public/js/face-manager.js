// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face Manager
//  Camera, worker orchestration, face matching, UI overlay
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

(function () {
  // ── Config ──
  const MATCH_THRESHOLD = 0.45;
  const PRESENCE_TIMEOUT = 5000;
  // Adaptive throttling bounds
  const MIN_INTERVAL = 800;    // fastest: never quicker than 800ms
  const MAX_INTERVAL = 5000;   // slowest: at most 5s between frames
  const IDLE_INTERVAL = 3000;  // interval when no faces seen for a while
  const IDLE_AFTER = 10000;    // switch to idle rate after 10s without faces
  const INFERENCE_MULTIPLIER = 1.5; // wait at least 1.5x the inference time
  let manualInterval = 0; // 0 = auto

  let worker = null;
  let workerReady = false;
  let captureTimeout = null;
  let workerBusy = false;
  let faceLibrary = [];
  let lastFaceSeen = 0;
  let presenceTimer = null;

  // Adaptive throttling state
  let lastInferenceMs = 500;
  let currentInterval = 1500;
  let lastNoFaceTime = 0;

  // Debug state
  let debugVisible = false;
  let lastDebugFaces = [];

  // DOM refs
  const pip = document.getElementById('camera-pip');
  const pipHeader = document.getElementById('camera-pip-header');
  const video = document.getElementById('camera-feed');
  const overlay = document.getElementById('camera-overlay');
  const statusEl = document.getElementById('camera-status');
  const badge = document.getElementById('presence-badge');
  const toggle = document.getElementById('camera-toggle');

  // Debug DOM refs
  const debugPanel = document.getElementById('face-debug');
  const debugCanvas = document.getElementById('face-debug-canvas');
  const debugDetections = document.getElementById('face-debug-detections');
  const debugClose = document.getElementById('face-debug-close');

  // Delay slider refs
  const delayRow = document.getElementById('detect-delay-row');
  const delaySlider = document.getElementById('detect-delay');
  const delayVal = document.getElementById('detect-delay-val');

  // Offscreen canvas for frame capture
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

  // ── Camera Toggle ──
  toggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      startCamera();
    } else {
      stopCamera();
    }
  });

  pipHeader.addEventListener('click', () => {
    pip.classList.toggle('collapsed');
  });

  debugClose.addEventListener('click', () => {
    toggleDebug();
  });

  delaySlider.addEventListener('input', () => {
    const v = parseInt(delaySlider.value, 10);
    manualInterval = v;
    delayVal.textContent = v === 0 ? 'auto' : (v / 1000).toFixed(1) + 's';
  });

  // ── Camera Start/Stop ──
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      });
      video.srcObject = stream;

      video.onloadedmetadata = () => {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
      };

      pip.classList.remove('hidden');
      delayRow.style.display = '';
      STATE.cameraActive = true;
      window.logChat('sys', 'Camera active');

      await loadFaceLibrary();

      if (!worker) {
        initWorker();
      } else if (workerReady) {
        scheduleNextCapture();
      }
    } catch (err) {
      console.error('[Camera] Init failed:', err);
      window.logChat('sys', `Camera error: ${err.message}`);
      toggle.checked = false;
      STATE.cameraActive = false;
    }
  }

  function stopCamera() {
    clearTimeout(captureTimeout);
    captureTimeout = null;

    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }

    pip.classList.add('hidden');
    delayRow.style.display = 'none';
    STATE.cameraActive = false;
    STATE.facesDetected = 0;
    STATE.personsPresent = [];
    STATE.presenceDetected = false;
    badge.classList.remove('visible');

    const ctx = overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);

    window.logChat('sys', 'Camera off');
  }

  // ── Face Library ──
  async function loadFaceLibrary() {
    try {
      const res = await fetch('/faces');
      const data = await res.json();
      faceLibrary = data.faces || [];
      if (faceLibrary.length > 0) {
        // Group by name for display
        const names = [...new Set(faceLibrary.map(f => f.name))];
        window.logChat('sys', `Face library: ${faceLibrary.length} embedding(s) for ${names.length} person(s)`);
      }
    } catch (err) {
      console.warn('[Faces] Could not load face library:', err);
      faceLibrary = [];
    }
  }

  // ── Worker Init ──
  function initWorker() {
    worker = new Worker('js/face-worker.js');
    statusEl.textContent = 'Loading models...';

    worker.onmessage = (e) => {
      const msg = e.data;

      switch (msg.type) {
        case 'ready':
          workerReady = true;
          STATE.faceWorkerReady = true;
          statusEl.textContent = 'Ready';
          window.logChat('sys', 'Face detection ready');
          scheduleNextCapture();
          break;

        case 'progress':
          statusEl.textContent = msg.detail;
          window.logChat('sys', `[Face] ${msg.stage}: ${msg.detail}`);
          break;

        case 'faces':
          workerBusy = false;
          handleFaceResults(msg.faces, msg.inferenceMs);
          scheduleNextCapture();
          break;

        case 'error':
          workerBusy = false;
          console.error('[FaceWorker]', msg.message);
          statusEl.textContent = 'Error';
          scheduleNextCapture();
          break;
      }
    };

    worker.onerror = (err) => {
      console.error('[FaceWorker] Error:', err);
      statusEl.textContent = 'Worker error';
    };

    worker.postMessage({ type: 'init' });
  }

  // ── Adaptive Throttling ──
  function computeInterval() {
    // Manual override
    if (manualInterval > 0) return manualInterval;

    // Base: proportional to inference time
    let interval = Math.max(MIN_INTERVAL, lastInferenceMs * INFERENCE_MULTIPLIER);

    // If no faces seen for a while, slow down
    const timeSinceLastFace = Date.now() - lastFaceSeen;
    if (lastFaceSeen > 0 && timeSinceLastFace > IDLE_AFTER) {
      interval = Math.max(interval, IDLE_INTERVAL);
    }

    return Math.min(interval, MAX_INTERVAL);
  }

  function scheduleNextCapture() {
    if (!STATE.cameraActive || !workerReady) return;
    clearTimeout(captureTimeout);
    currentInterval = computeInterval();
    captureTimeout = setTimeout(captureFrame, currentInterval);
  }

  function captureFrame() {
    if (!video.srcObject || video.readyState < 2 || workerBusy || !workerReady) {
      scheduleNextCapture();
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      scheduleNextCapture();
      return;
    }

    const scale = Math.min(1, 640 / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);

    captureCanvas.width = w;
    captureCanvas.height = h;
    captureCtx.drawImage(video, 0, 0, w, h);

    const imageData = captureCtx.getImageData(0, 0, w, h);

    // Keep a copy for debug visualization before transferring
    if (debugVisible) {
      renderDebugFrame(w, h);
    }

    const buffer = imageData.data.buffer;
    workerBusy = true;
    worker.postMessage({
      type: 'detect',
      imageBuffer: buffer,
      width: w,
      height: h
    }, [buffer]);
  }

  // ── Handle Face Results ──
  function handleFaceResults(faces, inferenceMs) {
    lastInferenceMs = inferenceMs;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const intervalStr = `${Math.round(currentInterval)}ms`;
    statusEl.textContent = `${faces.length} face(s) · ${inferenceMs}ms · ⏱${intervalStr}`;

    const recognized = [];
    const debugFaces = [];

    for (const face of faces) {
      // Collect ALL match candidates for this face (for debug)
      const candidates = [];
      let bestMatch = null;
      let bestSim = 0;

      if (face.embedding && faceLibrary.length > 0) {
        // Group library by name, find best embedding per name
        const byName = {};
        for (const known of faceLibrary) {
          const sim = cosineSimilarity(face.embedding, known.embedding);
          if (!byName[known.name] || sim > byName[known.name].sim) {
            byName[known.name] = { name: known.name, sim, id: known.id };
          }
        }

        // Sort by similarity descending
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
      // Mirror: overlay.width - right edge becomes left edge
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

      // Corner accents (small L-shapes at each corner)
      const cornerLen = Math.min(12, bw * 0.2, bh * 0.2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.beginPath();
      // top-left
      ctx.moveTo(bx, by + cornerLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cornerLen, by);
      // top-right
      ctx.moveTo(bx + bw - cornerLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cornerLen);
      // bottom-left
      ctx.moveTo(bx, by + bh - cornerLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cornerLen, by + bh);
      // bottom-right
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
        candidates: candidates.slice(0, 5) // top 5
      });
    }

    lastDebugFaces = debugFaces;
    if (debugVisible) renderDebugDetections(debugFaces, inferenceMs);

    // Update STATE
    STATE.facesDetected = faces.length;
    STATE.personsPresent = [...new Set(recognized)];
    const now = Date.now();

    if (faces.length > 0) {
      // ── Eye tracking: look toward the primary face ──
      const primary = faces[0];
      const [fx1, fy1, fx2, fy2] = primary.box;
      const faceCX = (fx1 + fx2) / 2;
      const faceCY = (fy1 + fy2) / 2;
      const frameW = captureCanvas.width || 640;
      const frameH = captureCanvas.height || 480;
      const normX = -((faceCX / frameW) * 2 - 1);
      const normY = (faceCY / frameH) * 2 - 1;
      if (window.lookAt) window.lookAt(normX, normY * 0.6);

      lastFaceSeen = now;
      lastNoFaceTime = 0;
      STATE.lastActivity = now;

      if (!STATE.presenceDetected) {
        STATE.presenceDetected = true;
        sendPresence(true, STATE.personsPresent, faces.length);
      }

      if (STATE.sleeping) {
        const greetName = recognized.length > 0 ? recognized[0] : null;
        window.logChat('sys', 'Face detected — waking up');
        window.exitSleep();
        // Greeting after wake
        setTimeout(() => {
          const n = greetName;
          const greetings = n
            ? [
                `Hey ${n}!`,
                `Hi ${n}!`,
                `Oh hey, ${n}!`,
                `${n}! Good to see you.`,
                `Well well, ${n}.`,
                `There you are, ${n}.`,
                `Ah, ${n}. What's up?`,
                `Oh! Hey ${n}.`,
                `${n}, hello!`,
                `Look who it is. Hey ${n}.`,
                `Yo ${n}!`,
                `${n}! I was just thinking about you.`,
                `Hey hey, ${n}.`,
                `Oh hi ${n}, didn't see you there.`,
                `${n}. Welcome back.`,
              ]
            : [
                `Hey there!`,
                `Hi!`,
                `Oh, hello!`,
                `Hey!`,
                `Well hello there.`,
                `Oh! Hi.`,
                `Hey, what's up?`,
                `Hello hello.`,
                `Ah, there you are.`,
                `Hi there!`,
              ];
          const greeting = greetings[Math.floor(Math.random() * greetings.length)];
          if (window.enqueueSpeech) window.enqueueSpeech(greeting);
        }, 400);
      }

      if (recognized.length > 0) {
        badge.textContent = recognized.join(', ');
        badge.classList.add('visible');
      } else {
        badge.textContent = `${faces.length} unknown`;
        badge.classList.add('visible');
      }

      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(checkPresenceTimeout, PRESENCE_TIMEOUT);

    } else {
      // No faces — reset gaze to center
      if (window.resetGaze) window.resetGaze();

      if (!lastNoFaceTime) lastNoFaceTime = now;
      if (STATE.presenceDetected && !presenceTimer) {
        presenceTimer = setTimeout(checkPresenceTimeout, PRESENCE_TIMEOUT);
      }

      // Direct elapsed-time check: sleep if no face for sleepTimeout
      if (!STATE.sleeping && lastFaceSeen > 0 && STATE.sleepTimeout > 0) {
        const elapsed = now - lastFaceSeen;
        if (elapsed > STATE.sleepTimeout) {
          console.log(`[Face] No faces for ${Math.round(elapsed / 1000)}s (timeout: ${STATE.sleepTimeout / 1000}s) — entering sleep`);
          window.enterSleep();
        }
      }
    }
  }

  function checkPresenceTimeout() {
    presenceTimer = null;
    if (Date.now() - lastFaceSeen > PRESENCE_TIMEOUT) {
      STATE.presenceDetected = false;
      STATE.facesDetected = 0;
      STATE.personsPresent = [];
      badge.classList.remove('visible');
      sendPresence(false, [], 0);
    }
  }

  function sendPresence(present, faces, count) {
    if (window.ws && window.ws.readyState === 1) {
      window.ws.send(JSON.stringify({ type: 'presence', present, faces, count }));
    }
  }

  // ── Cosine Similarity ──
  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ── Debug Panel ──
  function toggleDebug() {
    debugVisible = !debugVisible;
    debugPanel.classList.toggle('hidden', !debugVisible);
    if (debugVisible && lastDebugFaces.length > 0) {
      renderDebugDetections(lastDebugFaces, lastInferenceMs);
    }
  }

  function renderDebugFrame(w, h) {
    // Draw the captured frame + bounding boxes into the debug canvas
    debugCanvas.width = w;
    debugCanvas.height = h;
    const ctx = debugCanvas.getContext('2d');
    ctx.drawImage(captureCanvas, 0, 0);

    // Draw stored detections on top
    for (const f of lastDebugFaces) {
      const [x1, y1, x2, y2] = f.box;
      ctx.lineWidth = 2;
      ctx.strokeStyle = f.matchName ? '#00e5a0' : '#ffa726';
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      if (f.matchName) {
        ctx.font = '12px Outfit, sans-serif';
        ctx.fillStyle = 'rgba(0, 229, 160, 0.8)';
        ctx.fillText(`${f.matchName} ${(f.matchScore * 100).toFixed(0)}%`, x1 + 2, y1 - 4);
      }
    }
  }

  function renderDebugDetections(faces, inferenceMs) {
    // Update info row
    document.getElementById('dbg-interval').textContent = `${Math.round(currentInterval)}ms`;
    document.getElementById('dbg-inference').textContent = `${inferenceMs}ms`;
    document.getElementById('dbg-faces').textContent = faces.length;
    const names = [...new Set(faceLibrary.map(f => f.name))];
    document.getElementById('dbg-library').textContent = `${faceLibrary.length} emb / ${names.length} ppl`;

    // Render per-face details
    debugDetections.innerHTML = '';

    if (faces.length === 0) {
      debugDetections.innerHTML = '<div style="color:var(--text-dim);padding:4px 0;">No faces detected</div>';
      return;
    }

    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const entry = document.createElement('div');
      entry.className = 'debug-face-entry';

      let header = `<div class="debug-face-header">`;
      header += `<span class="face-idx">Face #${i + 1}</span>`;
      header += `<span class="face-conf">det: ${(f.confidence * 100).toFixed(1)}%</span>`;
      header += `</div>`;

      let candidatesHtml = '<div class="debug-face-candidates">';
      if (f.candidates.length === 0) {
        candidatesHtml += '<div style="color:var(--text-dim)">No library entries</div>';
      } else {
        for (const c of f.candidates) {
          const pct = (c.score * 100).toFixed(1);
          const cls = c.isMatch ? 'match' : (c.score > 0.3 ? '' : 'below');
          candidatesHtml += `<div class="debug-candidate ${cls}">`;
          candidatesHtml += `<span class="cand-name">${escapeDebugHTML(c.name)}</span>`;
          candidatesHtml += `<span class="cand-score">${pct}%</span>`;
          candidatesHtml += `</div>`;
        }
      }
      candidatesHtml += '</div>';

      entry.innerHTML = header + candidatesHtml;
      debugDetections.appendChild(entry);
    }
  }

  function escapeDebugHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Face Enrollment (multi-sample) ──
  async function enrollFace() {
    if (!STATE.cameraActive || !workerReady) {
      window.logChat('sys', 'Camera must be active to enroll a face');
      return;
    }

    // Pre-fill with recognized name if a face is currently detected
    const defaultName = STATE.personsPresent.length > 0 ? STATE.personsPresent[0] : '';
    const promptMsg = defaultName
      ? `Adding samples to "${defaultName}" (or enter a different name):`
      : 'Enter name for this face (multiple samples will be captured):';
    const name = prompt(promptMsg, defaultName);
    if (!name || !name.trim()) return;
    const trimmedName = name.trim();

    window.logChat('sys', `Enrolling "${trimmedName}" — capturing 5 samples over ~4s...`);

    const embeddings = [];
    const SAMPLES = 5;
    const SAMPLE_DELAY = 800;

    for (let i = 0; i < SAMPLES; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, SAMPLE_DELAY));
      }

      window.logChat('sys', `  Sample ${i + 1}/${SAMPLES}...`);

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) continue;

      const scale = Math.min(1, 640 / vw);
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);

      captureCanvas.width = w;
      captureCanvas.height = h;
      captureCtx.drawImage(video, 0, 0, w, h);

      const imageData = captureCtx.getImageData(0, 0, w, h);
      const buffer = imageData.data.buffer.slice(0);

      const embedding = await new Promise((resolve) => {
        const handler = (e) => {
          if (e.data.type === 'faces') {
            worker.removeEventListener('message', handler);
            const faces = e.data.faces;
            if (faces.length === 1 && faces[0].embedding) {
              resolve(faces[0].embedding);
            } else {
              resolve(null);
            }
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({
          type: 'detect',
          imageBuffer: buffer,
          width: w,
          height: h
        }, [buffer]);
      });

      if (embedding) {
        // Check if this embedding is distinct enough from already-collected ones
        let isDuplicate = false;
        for (const prev of embeddings) {
          if (cosineSimilarity(embedding, prev) > 0.95) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          embeddings.push(embedding);
        }
      }
    }

    workerBusy = false;

    if (embeddings.length === 0) {
      window.logChat('sys', `No valid face samples captured for "${trimmedName}"`);
      return;
    }

    window.logChat('sys', `Saving ${embeddings.length} distinct embedding(s) for "${trimmedName}"...`);

    let saved = 0;
    for (const emb of embeddings) {
      try {
        const res = await fetch('/faces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, embedding: emb })
        });
        const data = await res.json();
        if (data.ok) saved++;
      } catch (err) {
        console.error('[Enroll] Save error:', err);
      }
    }

    window.logChat('sys', `Enrolled "${trimmedName}" with ${saved} sample(s)`);
    await loadFaceLibrary();

    // Resume normal capture
    scheduleNextCapture();
  }

  // ── Expose to main.js ──
  window.faceManager = {
    startCamera,
    stopCamera,
    enrollFace,
    toggleDebug,
    get isActive() { return STATE.cameraActive; },
    get isReady() { return workerReady; }
  };

})();
