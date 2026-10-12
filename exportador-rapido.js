/*
 * Exportador rápido de Recorte.
 * Lee los fotogramas y el audio directamente del archivo (WebCodecs + Mediabunny)
 * en lugar de reproducir y grabar en tiempo real. Devuelve false cuando el navegador
 * no lo permite, para que el editor use el método anterior como respaldo.
 */
(function(){
  'use strict';

  const AUDIO_RATE = 48000;
  const AUDIO_CHANNELS = 2;
  const WINDOW_SECONDS = 2;
  const REVERSE_CHUNK_SECONDS = 0.5;
  const AUDIO_GAIN = 1.1;

  let libraryLoading = null;
  let aacLoading = null;

  function loadScript(src){
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(script);
    });
  }

  function loadLibrary(){
    if (window.Mediabunny) return Promise.resolve(window.Mediabunny);
    if (!libraryLoading) {
      libraryLoading = loadScript('mediabunny.min.js').then(() => {
        if (!window.Mediabunny) throw new Error('Mediabunny no se inició.');
        return window.Mediabunny;
      }).catch(error => { libraryLoading = null; throw error; });
    }
    return libraryLoading;
  }

  async function canEncodeAac(MB){
    try { return await MB.canEncodeAudio('aac', {numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_RATE}); }
    catch (error) { return false; }
  }

  // AAC es el audio más compatible dentro de un MP4 (iPhone, Android, Windows, Mac).
  // Si el navegador no lo codifica (Firefox, Safari anterior a 26), se usa un codificador WASM.
  async function ensureAac(MB){
    if (await canEncodeAac(MB)) return true;
    if (!aacLoading) {
      aacLoading = loadScript('mediabunny-aac-encoder.min.js').then(() => {
        if (!window.MediabunnyAacEncoder) throw new Error('Codificador AAC no disponible.');
        window.MediabunnyAacEncoder.registerAacEncoder();
      }).catch(error => { aacLoading = null; throw error; });
    }
    try { await aacLoading; }
    catch (error) { return false; }
    return canEncodeAac(MB);
  }

  // Recibe el MP4 por partes y lo arma en memoria; admite reescrituras de cabecera.
  function createCollector(){
    const chunks = [];
    let end = 0;
    const writable = new WritableStream({
      write(chunk){
        const data = chunk.data;
        const position = chunk.position;
        const dataEnd = position + data.length;
        for (const part of chunks) {
          const partEnd = part.pos + part.data.length;
          if (partEnd <= position || part.pos >= dataEnd) continue;
          const from = Math.max(position, part.pos);
          const to = Math.min(dataEnd, partEnd);
          part.data.set(data.subarray(from - position, to - position), from - part.pos);
        }
        if (dataEnd > end) {
          if (position > end) chunks.push({pos: end, data: new Uint8Array(position - end)});
          const from = Math.max(position, end);
          chunks.push({pos: from, data: data.slice(from - position)});
          end = dataEnd;
        }
      }
    });
    return {
      writable,
      toBlob(type){ return new Blob(chunks.map(part => part.data), {type}); }
    };
  }

  // Mismo dibujo que la vista previa: encuadre, rotación, espejo y fundido.
  function drawFrame(ctx, frameCanvas, S, out, alpha){
    const width = frameCanvas.width, height = frameCanvas.height;
    const sx = S.crop.x * width, sy = S.crop.y * height;
    const sw = S.crop.w * width, sh = S.crop.h * height;
    const swap = S.rot === 90 || S.rot === 270;
    const dw = swap ? out.h : out.w, dh = swap ? out.w : out.h;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.w, out.h);
    ctx.globalAlpha = alpha;
    ctx.translate(out.w / 2, out.h / 2);
    ctx.rotate(S.rot * Math.PI / 180);
    ctx.scale(S.flipH ? -1 : 1, S.flipV ? -1 : 1);
    ctx.drawImage(frameCanvas, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  function clamp(value, min, max){ return Math.min(max, Math.max(min, value)); }

  function mixAudioBuffer(wrapped, windowStart, frames, left, right, gainAt){
    const buffer = wrapped.buffer;
    const rate = buffer.sampleRate;
    const length = buffer.length;
    if (!length) return;
    const bufferStart = wrapped.timestamp;
    const bufferEnd = bufferStart + length / rate;
    const first = Math.max(0, Math.ceil((bufferStart - windowStart) * AUDIO_RATE - 1e-6));
    const last = Math.min(frames, Math.ceil((bufferEnd - windowStart) * AUDIO_RATE - 1e-6));
    if (last <= first) return;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    for (let i = first; i < last; i++) {
      const time = windowStart + i / AUDIO_RATE;
      const position = (time - bufferStart) * rate;
      const i0 = Math.min(length - 1, Math.max(0, Math.floor(position)));
      const i1 = Math.min(length - 1, i0 + 1);
      const frac = clamp(position - i0, 0, 1);
      const gain = gainAt(time);
      left[i] = clamp((ch0[i0] + (ch0[i1] - ch0[i0]) * frac) * gain, -1, 1);
      right[i] = clamp((ch1[i0] + (ch1[i1] - ch1[i0]) * frac) * gain, -1, 1);
    }
  }

  async function decodeWithWebAudio(file){
    try {
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) return null;
      const context = new OfflineContext(AUDIO_CHANNELS, 1, AUDIO_RATE);
      const raw = await file.arrayBuffer();
      return await new Promise((resolve, reject) => {
        const result = context.decodeAudioData(raw, resolve, reject);
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      });
    } catch (error) {
      console.warn('No se pudo decodificar el audio con Web Audio.', error);
      return null;
    }
  }

  function decodedSink(buffer){
    return {
      buffers(){
        return (async function* (){ yield {buffer, timestamp: 0, duration: buffer.duration}; })();
      }
    };
  }

  async function exportar(app){
    const {S, els} = app;
    if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') return false;
    if (typeof WritableStream !== 'function') return false;

    const plan = app.buildExportPlan().filter(clip => clip.end - clip.start > 0.0005);
    if (!plan.length) return false;
    const sources = [...new Set(plan.map(clip => clip.sourceId))].map(id => app.sourceById(id));
    if (sources.some(source => !source || !source.file)) return false;

    let MB;
    try { MB = await loadLibrary(); }
    catch (error) { console.warn('Exportación rápida no disponible:', error); return false; }

    const keepAudio = !!(els.keepAudio && els.keepAudio.checked);
    const out = app.projectExportSize(sources);
    const inputs = new Map();
    const disposeInputs = () => inputs.forEach(item => { try { item.input.dispose(); } catch (error) {} });

    // 1. Comprobar que el navegador puede leer cada video del proyecto.
    try {
      for (const source of sources) {
        const input = new MB.Input({source: new MB.BlobSource(source.file), formats: MB.ALL_FORMATS});
        inputs.set(source.id, {input, source});
        const video = await input.getPrimaryVideoTrack();
        if (!video || !(await video.canDecode())) { disposeInputs(); return false; }
        let audio = null, decodedAudio = null;
        if (keepAudio) {
          audio = await input.getPrimaryAudioTrack();
          if (audio && !(await audio.canDecode())) {
            // Safari anterior a 26 no decodifica audio con WebCodecs: se usa Web Audio.
            decodedAudio = await decodeWithWebAudio(source.file);
            if (!decodedAudio) { disposeInputs(); return false; }
            audio = null;
          }
        }
        let fps = source.fps || 30;
        try {
          const stats = await video.computePacketStats(90);
          if (stats && isFinite(stats.averagePacketRate) && stats.averagePacketRate > 1) fps = stats.averagePacketRate;
        } catch (error) {}
        Object.assign(inputs.get(source.id), {
          video, audio, fps: clamp(fps, 1, 120),
          frames: new MB.CanvasSink(video, {poolSize: 3}),
          sound: audio ? new MB.AudioBufferSink(audio) : (decodedAudio ? decodedSink(decodedAudio) : null)
        });
      }
    } catch (error) {
      console.warn('Exportación rápida no disponible:', error);
      disposeInputs();
      return false;
    }

    // 2. Elegir códecs que este navegador pueda escribir.
    const fps = Math.max(...[...inputs.values()].map(item => item.fps), 1);
    const projectedRates = sources.map(source => {
      const sourceFps = Math.max(1, source.fps || 30);
      const pixels = Math.max(1, source.width * source.height);
      return ((source.bitrate || 3000000) / (pixels * sourceFps)) * out.w * out.h * fps;
    });
    const bitrate = Math.round(clamp(Math.max(...projectedRates, out.w * out.h * fps * 0.1) * 1.2, 2000000, 50000000));
    const format = new MB.Mp4OutputFormat();
    const videoCandidates = ['avc', 'hevc', 'vp9', 'av1', 'vp8'].filter(codec => format.getSupportedVideoCodecs().includes(codec));
    let videoCodec = null;
    let videoQuality = bitrate;
    try {
      videoCodec = await MB.getFirstEncodableVideoCodec(videoCandidates, {width: out.w, height: out.h, bitrate});
      if (!videoCodec) {
        videoQuality = MB.QUALITY_HIGH;
        videoCodec = await MB.getFirstEncodableVideoCodec(videoCandidates, {width: out.w, height: out.h});
      }
    } catch (error) { videoCodec = null; }
    if (!videoCodec) { disposeInputs(); return false; }

    let audioCodec = null;
    if (keepAudio) {
      if (await ensureAac(MB)) audioCodec = 'aac';
      else {
        const audioCandidates = ['opus', 'mp3'].filter(codec => format.getSupportedAudioCodecs().includes(codec));
        try { audioCodec = await MB.getFirstEncodableAudioCodec(audioCandidates, {numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_RATE}); }
        catch (error) { audioCodec = null; }
      }
      if (!audioCodec) { disposeInputs(); return false; }
    }

    // 3. Preparar la pantalla.
    const total = plan.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
    let wakeLock = null;
    S.exporting = true;
    S.exportKind = 'fast';
    S.fastExportCancelled = false;
    S.activationToken++;
    try { els.video.pause(); } catch (error) {}
    els.exportBtn.disabled = true;
    els.saveFrame.disabled = true;
    els.exportBtn.textContent = 'Exportando…';
    els.cancelBtn.classList.remove('hidden');
    els.prog.style.display = 'block';
    els.st.style.display = 'block';
    els.result.classList.add('hidden');
    els.prog.firstElementChild.style.width = '0%';
    els.st.textContent = 'Preparando…';
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (error) {}

    const restoreUi = () => {
      S.exporting = false;
      S.exportKind = null;
      S.fastExportCancelled = false;
      els.exportBtn.disabled = false;
      els.saveFrame.disabled = false;
      els.exportBtn.textContent = 'Exportar video';
      els.cancelBtn.classList.add('hidden');
      els.prog.style.display = 'none';
      els.st.style.display = 'none';
      els.prog.firstElementChild.style.width = '0%';
      if (wakeLock) { try { wakeLock.release(); } catch (error) {} wakeLock = null; }
      disposeInputs();
    };

    const startedAt = performance.now();
    const showProgress = done => {
      const p = total ? clamp(done / total, 0, 1) : 1;
      els.prog.firstElementChild.style.width = (p * 100).toFixed(1) + '%';
      const elapsed = (performance.now() - startedAt) / 1000;
      let text = Math.round(p * 100) + '%';
      if (p > 0.03 && p < 1) text += ' · quedan ~' + app.fmt(Math.max(0, elapsed / p - elapsed));
      els.st.textContent = text;
    };
    const cancelled = () => !!S.fastExportCancelled;

    const collector = createCollector();
    const output = new MB.Output({format, target: new MB.StreamTarget(collector.writable, {chunked: true})});
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext('2d', {alpha: false});
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const videoConfig = {codec: videoCodec, keyFrameInterval: 2, latencyMode: 'quality'};
    if (typeof videoQuality === 'number') videoConfig.bitrate = videoQuality;
    else videoConfig.quality = videoQuality;
    const videoSource = new MB.CanvasSource(canvas, videoConfig);
    // Sin frameRate fijo: se conservan los tiempos reales de cada fotograma (varios videos con distinto fps).
    output.addVideoTrack(videoSource);
    let audioSource = null;
    if (audioCodec) {
      audioSource = new MB.AudioSampleSource({codec: audioCodec, bitrate: 192000});
      output.addAudioTrack(audioSource);
    }

    let outputTime = 0;
    let audioFrames = 0;
    try {
      await output.start();

      for (const clip of plan) {
        if (cancelled()) break;
        const item = inputs.get(clip.sourceId);
        const length = clip.end - clip.start;
        const videoFade = !!((clip.fadeVideoIn || 0) || (clip.fadeVideoOut || 0));
        const audioFade = !!((clip.fadeAudioIn || 0) || (clip.fadeAudioOut || 0));
        const alphaAt = time => videoFade ? app.fadeFactor(clip, clamp(time, clip.start, clip.end), 'video') : 1;
        const gainAt = time => AUDIO_GAIN * (audioFade ? app.fadeFactor(clip, time, 'audio') : 1);

        // Video hacia adelante: fotogramas reales del archivo, sin depender del reloj.
        let frameIterator = null, pendingFrame = null, framesDone = false;
        if (!clip.reversed) frameIterator = item.frames.canvases(clip.start, clip.end)[Symbol.asyncIterator]();
        const writeForwardFrames = async localEnd => {
          while (!cancelled()) {
            let frame = pendingFrame;
            if (!frame) {
              if (framesDone) return;
              const next = await frameIterator.next();
              if (next.done) { framesDone = true; return; }
              frame = next.value;
            }
            const frameStart = Math.max(0, frame.timestamp - clip.start);
            if (frameStart >= localEnd - 1e-6 && localEnd < length) { pendingFrame = frame; return; }
            pendingFrame = null;
            if (frameStart >= length - 1e-6) continue;
            const duration = frame.duration > 0 ? frame.duration : 1 / item.fps;
            const frameEnd = Math.min(length, frame.timestamp + duration - clip.start);
            if (frameEnd <= frameStart) continue;
            drawFrame(ctx, frame.canvas, S, out, alphaAt(frame.timestamp));
            if (app.drawOverlays) app.drawOverlays(ctx, out.w, out.h, outputTime + frameStart);
            await videoSource.add(outputTime + frameStart, frameEnd - frameStart);
          }
        };

        // Video invertido: se decodifica por tramos cortos y se escribe al revés.
        const step = 1 / item.fps;
        const reverseCount = Math.max(1, Math.round(length / step));
        let reverseIndex = 0;
        const writeReversedFrames = async localEnd => {
          const chunkSize = Math.max(1, Math.round(REVERSE_CHUNK_SECONDS / step));
          while (!cancelled() && reverseIndex < reverseCount && reverseIndex * step < localEnd - 1e-6) {
            const indexes = [];
            for (let k = reverseIndex; k < Math.min(reverseCount, reverseIndex + chunkSize); k++) indexes.push(k);
            const times = indexes.map(k => Math.max(clip.start, clip.end - (k + 0.5) * step)).reverse();
            const composed = new Map();
            let position = 0;
            for await (const frame of item.frames.canvasesAtTimestamps(times)) {
              const k = indexes[indexes.length - 1 - position];
              position++;
              if (!frame) continue;
              const copy = document.createElement('canvas');
              copy.width = out.w; copy.height = out.h;
              const copyCtx = copy.getContext('2d', {alpha: false});
              drawFrame(copyCtx, frame.canvas, S, out, alphaAt(clip.end - k * step));
              if (app.drawOverlays) app.drawOverlays(copyCtx, out.w, out.h, outputTime + k * step);
              composed.set(k, copy);
            }
            for (const k of indexes) {
              if (cancelled()) return;
              const image = composed.get(k);
              if (image) { ctx.drawImage(image, 0, 0); }
              const start = k * step;
              const end = Math.min(length, (k + 1) * step);
              if (end > start) await videoSource.add(outputTime + start, end - start);
            }
            reverseIndex += indexes.length;
          }
        };

        // Audio: se toma del archivo, se ajusta a 48 kHz estéreo y se aplican los fundidos.
        // Los fragmentos invertidos van en silencio, igual que en la vista previa.
        const audioEndFrame = Math.round((outputTime + length) * AUDIO_RATE);
        let bufferIterator = null, bufferQueue = [], buffersDone = false;
        if (audioSource && item.sound && !clip.reversed) {
          bufferIterator = item.sound.buffers(clip.start, clip.end)[Symbol.asyncIterator]();
        }
        const writeAudio = async localEnd => {
          if (!audioSource) return;
          const targetFrame = localEnd >= length ? audioEndFrame : Math.round((outputTime + localEnd) * AUDIO_RATE);
          const frames = targetFrame - audioFrames;
          if (frames <= 0) return;
          const data = new Float32Array(frames * AUDIO_CHANNELS);
          const left = data.subarray(0, frames), right = data.subarray(frames);
          if (bufferIterator) {
            const windowStart = clip.start + (audioFrames / AUDIO_RATE - outputTime);
            const windowEnd = windowStart + frames / AUDIO_RATE;
            const lastEnd = () => {
              const b = bufferQueue[bufferQueue.length - 1];
              return b ? b.timestamp + b.buffer.length / b.buffer.sampleRate : -Infinity;
            };
            while (!buffersDone && lastEnd() < windowEnd) {
              const next = await bufferIterator.next();
              if (next.done) { buffersDone = true; break; }
              bufferQueue.push(next.value);
            }
            for (const wrapped of bufferQueue) mixAudioBuffer(wrapped, windowStart, frames, left, right, gainAt);
            bufferQueue = bufferQueue.filter(b => b.timestamp + b.buffer.length / b.buffer.sampleRate > windowEnd);
          }
          const sample = new MB.AudioSample({
            data, format: 'f32-planar', numberOfChannels: AUDIO_CHANNELS,
            sampleRate: AUDIO_RATE, timestamp: audioFrames / AUDIO_RATE
          });
          await audioSource.add(sample);
          sample.close();
          audioFrames = targetFrame;
        };

        for (let windowStart = 0; windowStart < length - 1e-9 && !cancelled(); windowStart += WINDOW_SECONDS) {
          const windowEnd = Math.min(length, windowStart + WINDOW_SECONDS);
          if (clip.reversed) await writeReversedFrames(windowEnd);
          else await writeForwardFrames(windowEnd);
          await writeAudio(windowEnd);
          showProgress(outputTime + windowEnd);
        }
        if (frameIterator && frameIterator.return) { try { await frameIterator.return(); } catch (error) {} }
        if (bufferIterator && bufferIterator.return) { try { await bufferIterator.return(); } catch (error) {} }
        outputTime += length;
      }

      if (cancelled()) {
        try { await output.cancel(); } catch (error) {}
        restoreUi();
        return true;
      }

      els.st.textContent = 'Guardando…';
      await output.finalize();
      const blob = collector.toBlob('video/mp4');
      restoreUi();
      app.setExportResult(blob, 'video/mp4', 'mp4', {output: out});
      return true;
    } catch (error) {
      console.error('La exportación rápida falló; se usará el método anterior.', error);
      try { await output.cancel(); } catch (err) {}
      const wasCancelled = cancelled();
      restoreUi();
      return wasCancelled;
    }
  }


  // ===== Exportar solo el audio del proyecto (M4A/AAC; WAV como respaldo) =====
  function lastBufferEnd(queue){
    const b = queue[queue.length - 1];
    return b ? b.timestamp + b.buffer.length / b.buffer.sampleRate : -Infinity;
  }

  async function renderPlanAudio(plan, sinkFor, gainFor, onWindow, cancelled, progress){
    let outputTime = 0, audioFrames = 0;
    for (const clip of plan) {
      if (cancelled()) return false;
      const length = clip.end - clip.start;
      const sink = clip.reversed ? null : sinkFor(clip.sourceId);
      const iterator = sink ? sink.buffers(clip.start, clip.end)[Symbol.asyncIterator]() : null;
      let queue = [], done = false;
      const gainAt = gainFor(clip);
      const endFrame = Math.round((outputTime + length) * AUDIO_RATE);
      for (let windowStart = 0; windowStart < length - 1e-9; windowStart += WINDOW_SECONDS) {
        if (cancelled()) return false;
        const windowEnd = Math.min(length, windowStart + WINDOW_SECONDS);
        const target = windowEnd >= length ? endFrame : Math.round((outputTime + windowEnd) * AUDIO_RATE);
        const frames = target - audioFrames;
        if (frames <= 0) continue;
        const data = new Float32Array(frames * AUDIO_CHANNELS);
        const left = data.subarray(0, frames), right = data.subarray(frames);
        if (iterator) {
          const from = clip.start + (audioFrames / AUDIO_RATE - outputTime);
          const to = from + frames / AUDIO_RATE;
          while (!done && lastBufferEnd(queue) < to) {
            const next = await iterator.next();
            if (next.done) { done = true; break; }
            queue.push(next.value);
          }
          for (const wrapped of queue) mixAudioBuffer(wrapped, from, frames, left, right, gainAt);
          queue = queue.filter(b => b.timestamp + b.buffer.length / b.buffer.sampleRate > to);
        }
        await onWindow(data, frames, audioFrames);
        audioFrames = target;
        progress(outputTime + windowEnd);
      }
      if (iterator && iterator.return) { try { await iterator.return(); } catch (error) {} }
      outputTime += length;
    }
    return true;
  }

  function wavHeader(totalFrames){
    const blockAlign = AUDIO_CHANNELS * 2, dataSize = totalFrames * blockAlign;
    const view = new DataView(new ArrayBuffer(44));
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, AUDIO_CHANNELS, true); view.setUint32(24, AUDIO_RATE, true);
    view.setUint32(28, AUDIO_RATE * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, dataSize, true);
    return view.buffer;
  }

  function toInt16(data, frames){
    const out = new Int16Array(frames * AUDIO_CHANNELS);
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < AUDIO_CHANNELS; ch++) {
        const v = clamp(data[ch * frames + i], -1, 1);
        out[i * AUDIO_CHANNELS + ch] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    return out;
  }

  async function exportarAudio(app){
    const {S, els} = app;
    if (S.exporting) return true;
    const plan = app.buildExportPlan().filter(clip => clip.end - clip.start > 0.0005);
    if (!plan.length) return true;
    const sourceIds = [...new Set(plan.map(clip => clip.sourceId))];
    const sources = sourceIds.map(id => app.sourceById(id));
    if (sources.some(source => !source || !source.file)) { alert('No se pudo leer el video.'); return true; }
    const total = plan.reduce((sum, clip) => sum + (clip.end - clip.start), 0);

    let wakeLock = null;
    S.exporting = true;
    S.exportKind = 'fast';
    S.fastExportCancelled = false;
    try { els.video.pause(); } catch (error) {}
    els.exportBtn.disabled = true;
    els.saveFrame.disabled = true;
    els.exportBtn.textContent = 'Exportando…';
    els.cancelBtn.classList.remove('hidden');
    els.prog.style.display = 'block';
    els.st.style.display = 'block';
    els.result.classList.add('hidden');
    els.prog.firstElementChild.style.width = '0%';
    els.st.textContent = 'Preparando…';
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (error) {}
    const restoreUi = () => {
      S.exporting = false;
      S.exportKind = null;
      S.fastExportCancelled = false;
      els.exportBtn.disabled = false;
      els.saveFrame.disabled = false;
      els.exportBtn.textContent = 'Exportar video';
      els.cancelBtn.classList.add('hidden');
      els.prog.style.display = 'none';
      els.st.style.display = 'none';
      els.prog.firstElementChild.style.width = '0%';
      if (wakeLock) { try { wakeLock.release(); } catch (error) {} wakeLock = null; }
    };
    const cancelled = () => !!S.fastExportCancelled;
    const startedAt = performance.now();
    const progress = done => {
      const p = total ? clamp(done / total, 0, 1) : 1;
      els.prog.firstElementChild.style.width = (p * 100).toFixed(1) + '%';
      const elapsed = (performance.now() - startedAt) / 1000;
      let text = Math.round(p * 100) + '%';
      if (p > 0.03 && p < 1) text += ' · quedan ~' + app.fmt(Math.max(0, elapsed / p - elapsed));
      els.st.textContent = text;
    };
    const gainFor = clip => {
      const fade = !!((clip.fadeAudioIn || 0) || (clip.fadeAudioOut || 0));
      return time => AUDIO_GAIN * (fade ? app.fadeFactor(clip, time, 'audio') : 1);
    };
    const NO_AUDIO = 'sin-audio';

    // Opción principal: AAC en M4A con Mediabunny.
    const viaMediabunny = async () => {
      const MB = await loadLibrary();
      const inputs = [];
      const sinks = new Map();
      try {
        let anyAudio = false;
        for (const source of sources) {
          const input = new MB.Input({source: new MB.BlobSource(source.file), formats: MB.ALL_FORMATS});
          inputs.push(input);
          const track = await input.getPrimaryAudioTrack();
          if (!track) { sinks.set(source.id, null); continue; }
          anyAudio = true;
          if (await track.canDecode()) sinks.set(source.id, new MB.AudioBufferSink(track));
          else {
            const decoded = await decodeWithWebAudio(source.file);
            sinks.set(source.id, decoded ? decodedSink(decoded) : null);
          }
        }
        if (!anyAudio) throw new Error(NO_AUDIO);
        if (!(await ensureAac(MB))) throw new Error('AAC no disponible');
        const collector = createCollector();
        const output = new MB.Output({format: new MB.Mp4OutputFormat(), target: new MB.StreamTarget(collector.writable, {chunked: true})});
        const audioSource = new MB.AudioSampleSource({codec: 'aac', bitrate: 192000});
        output.addAudioTrack(audioSource);
        await output.start();
        const ok = await renderPlanAudio(plan, id => sinks.get(id), gainFor, async (data, frames, at) => {
          const sample = new MB.AudioSample({data, format: 'f32-planar', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_RATE, timestamp: at / AUDIO_RATE});
          await audioSource.add(sample);
          sample.close();
        }, cancelled, progress);
        if (!ok) { try { await output.cancel(); } catch (error) {} return null; }
        els.st.textContent = 'Guardando…';
        await output.finalize();
        return {blob: collector.toBlob('audio/mp4'), type: 'audio/mp4', ext: 'm4a'};
      } finally {
        inputs.forEach(input => { try { input.dispose(); } catch (error) {} });
      }
    };

    // Respaldo: WAV con Web Audio (navegadores sin WebCodecs).
    const viaWav = async () => {
      const sinks = new Map();
      let anyAudio = false;
      for (const source of sources) {
        const decoded = await decodeWithWebAudio(source.file);
        sinks.set(source.id, decoded ? decodedSink(decoded) : null);
        if (decoded) anyAudio = true;
      }
      if (!anyAudio) throw new Error(NO_AUDIO);
      const parts = [];
      let written = 0;
      const ok = await renderPlanAudio(plan, id => sinks.get(id), gainFor, async (data, frames) => {
        parts.push(toInt16(data, frames));
        written += frames;
      }, cancelled, progress);
      if (!ok) return null;
      return {blob: new Blob([wavHeader(written), ...parts], {type: 'audio/wav'}), type: 'audio/wav', ext: 'wav'};
    };

    try {
      let result = null;
      try { result = await viaMediabunny(); }
      catch (error) {
        if (error && error.message === NO_AUDIO) throw error;
        if (cancelled()) { restoreUi(); return true; }
        console.warn('Se usará WAV para el audio.', error);
        progress(0);
        result = await viaWav();
      }
      if (cancelled() || !result) { restoreUi(); return true; }
      restoreUi();
      app.setExportResult(result.blob, result.type, result.ext, {output: {w: 0, h: 0}});
      els.outMeta.textContent = 'Audio · ' + (result.blob.size / 1048576).toFixed(1) + ' MB · ' + result.ext.toUpperCase();
      return true;
    } catch (error) {
      restoreUi();
      if (error && error.message === NO_AUDIO) alert('Este video no tiene audio.');
      else { console.error('No se pudo exportar el audio.', error); alert('No se pudo exportar el audio en este navegador.'); }
      return true;
    }
  }

  window.RecorteRapido = {exportar, exportarAudio};
})();
