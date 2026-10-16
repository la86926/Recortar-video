/*
 * Botón "Transcripción": pasa a texto plano lo que se dice en el proyecto (con sus cortes).
 * Todo ocurre en el dispositivo; el audio no se envía a ningún servidor.
 */
(function(){
  'use strict';
  const B = window.RecorteBridge;
  if (!B) return;
  const {S} = B;

  const button = document.getElementById('transcribeBtn');
  if (!button) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'transcript-dialog';
  dialog.innerHTML =
    '<div class="transcript-head">' +
      '<h3>Transcripción</h3>' +
      '<button class="transcript-close" type="button" aria-label="Cerrar" title="Cerrar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
    '</div>' +
    '<div class="transcript-status">' +
      '<p class="transcript-msg">Preparando…</p>' +
      '<div class="transcript-bar"><i></i></div>' +
    '</div>' +
    '<textarea class="transcript-text" spellcheck="false" placeholder=""></textarea>' +
    '<div class="transcript-foot">' +
      '<button class="btn primary transcript-copy" type="button">Copiar</button>' +
    '</div>';
  document.body.appendChild(dialog);
  const msg = dialog.querySelector('.transcript-msg');
  const bar = dialog.querySelector('.transcript-bar i');
  const status = dialog.querySelector('.transcript-status');
  const textArea = dialog.querySelector('.transcript-text');
  const copyBtn = dialog.querySelector('.transcript-copy');

  let worker = null;
  let running = false;
  let cancelled = false;
  let cache = {key: '', text: ''};

  const projectKey = () => S.clips.map(c => c.sourceId + ':' + c.start.toFixed(3) + ':' + c.end.toFixed(3) + ':' + (c.reversed ? 1 : 0)).join('|');

  function setProgress(fraction, text){
    status.hidden = false;
    msg.textContent = text;
    bar.style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + '%';
  }
  function finish(){
    running = false;
    status.hidden = true;
    copyBtn.disabled = !textArea.value.trim();
  }

  function stop(){
    cancelled = true;
    if (worker) { try { worker.terminate(); } catch (error) {} worker = null; }
    running = false;
  }

  function close(){
    if (running) stop();
    if (dialog.open) dialog.close();
  }
  dialog.querySelector('.transcript-close').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

  copyBtn.addEventListener('click', async () => {
    const text = textArea.value;
    if (!text.trim()) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (error) {}
    if (!ok) {
      textArea.focus(); textArea.select();
      try { ok = document.execCommand('copy'); } catch (error) {}
      textArea.setSelectionRange(0, 0);
    }
    copyBtn.textContent = ok ? 'Copiado' : 'No se pudo copiar';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1600);
  });
  textArea.addEventListener('input', () => {
    cache.text = textArea.value;
    copyBtn.disabled = !textArea.value.trim();
  });

  function mb(bytes){ return (bytes / 1048576).toFixed(0) + ' MB'; }

  async function transcribe(){
    const key = projectKey();
    if (cache.key === key && cache.text) {
      textArea.value = cache.text;
      finish();
      return;
    }
    running = true;
    cancelled = false;
    textArea.value = '';
    copyBtn.disabled = true;
    setProgress(0, 'Preparando el audio…');
    let audio;
    try {
      const exporter = await B.loadFastExporter();
      audio = await exporter.audioParaTranscribir(B.exportApp(), p => setProgress(p * 0.15, 'Preparando el audio…'), () => cancelled);
    } catch (error) {
      if (cancelled) return;
      finish();
      setProgress(0, error && error.message === 'sin-audio' ? 'Este video no tiene audio.' : 'No se pudo leer el audio del video.');
      status.querySelector('.transcript-bar').hidden = true;
      return;
    }
    if (cancelled || !audio) return;

    const files = new Map();
    worker = new Worker('transcriptor-worker.js?v=' + B.version, {type: 'module'});
    const pieces = [];
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'download') {
        files.set(data.file, data);
        let loaded = 0, total = 0;
        files.forEach(f => { loaded += f.loaded || 0; total += f.total || 0; });
        setProgress(0.15 + 0.25 * (total ? loaded / total : 0), 'Descargando el transcriptor (solo la primera vez)… ' + mb(loaded) + ' de ' + mb(total));
      } else if (data.type === 'status' && data.stage === 'model') {
        setProgress(0.15, 'Cargando el transcriptor…');
      } else if (data.type === 'status' && data.stage === 'transcribe') {
        setProgress(0.4, 'Transcribiendo…');
      } else if (data.type === 'piece') {
        pieces[data.index] = data.text;
        textArea.value = pieces.filter(Boolean).join(' ');
        setProgress(0.4 + 0.6 * ((data.index + 1) / data.total), 'Transcribiendo… ' + Math.round((data.index + 1) / data.total * 100) + '%');
      } else if (data.type === 'done') {
        const text = pieces.filter(Boolean).join(' ').trim();
        textArea.value = text;
        cache = {key, text};
        if (worker) { worker.terminate(); worker = null; }
        finish();
        if (!text) { status.hidden = false; status.querySelector('.transcript-bar').hidden = true; msg.textContent = 'No se detectó voz en el video.'; }
      } else if (data.type === 'error') {
        console.error('Transcripción:', data.message);
        if (worker) { worker.terminate(); worker = null; }
        finish();
        status.hidden = false;
        status.querySelector('.transcript-bar').hidden = true;
        msg.textContent = 'No se pudo transcribir en este navegador. Revisa tu conexión e inténtalo de nuevo.';
      }
    };
    worker.onerror = event => {
      console.error('Transcripción:', event.message || event);
      if (worker) { worker.terminate(); worker = null; }
      finish();
      status.hidden = false;
      status.querySelector('.transcript-bar').hidden = true;
      msg.textContent = 'No se pudo iniciar el transcriptor en este navegador.';
    };
    worker.postMessage({type: 'transcribe', audio}, [audio.buffer]);
  }

  button.addEventListener('click', () => {
    if (S.exporting || !S.clips.length) return;
    status.querySelector('.transcript-bar').hidden = false;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (!running) transcribe();
  });

  (function sync(){
    const busy = !!S.exporting;
    if (button.classList.contains('hidden') !== busy) button.classList.toggle('hidden', busy);
    requestAnimationFrame(sync);
  })();
})();
