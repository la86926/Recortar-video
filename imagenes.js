/*
 * Imágenes sobre el video (Recorte).
 * - Botón "Añadir imagen" en la barra de herramientas.
 * - Línea de tiempo propia (encima de la del video): bordes arrastrables y fundido al tocar cada borde.
 * - Mientras una imagen está seleccionada, el visor muestra el encuadre final y la imagen
 *   se mueve con un dedo, se agranda/achica y gira con dos dedos.
 * - Sección "Imagen" (entre Recortes y Vista previa): esquinas redondeadas y fundidos de entrada/salida.
 * - Efecto imán: si se borran o recortan tramos del video, la imagen sigue al contenido.
 * Se dibuja igual en la vista previa, en la vista flotante y en el video exportado.
 */
(function(){
  'use strict';
  const B = window.RecorteBridge;
  if (!B) return;
  const {S, els} = B;
  if (!Array.isArray(S.overlays)) S.overlays = [];

  const MAX_IMAGE_SIDE = 2048;
  const MIN_DURATION = 0.2;
  const images = new Map(); // id -> {id, name, file, canvas, width, height, url}
  let selectedId = null;
  let editingDraw = false;
  let counter = 0;
  const newId = prefix => prefix + Date.now().toString(36) + (counter++).toString(36);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const totalDuration = () => Math.max(0, B.projectDuration());
  const findOverlay = id => S.overlays.find(o => o.id === id) || null;

  // ---------- Dibujo ----------
  function roundedRect(ctx, x, y, w, h, r){
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function overlayAlpha(o, t){
    if (t < o.start || t >= o.end) return 0;
    let a = 1;
    if (o.fadeIn > 0) a = Math.min(a, (t - o.start) / o.fadeIn);
    if (o.fadeOut > 0) a = Math.min(a, (o.end - t) / o.fadeOut);
    return clamp(a, 0, 1);
  }

  function overlayBox(o, w, h){
    const image = images.get(o.imageId);
    const iw = o.scale * w;
    const ih = image ? iw * image.height / image.width : iw;
    return {iw, ih, cx: o.x * w, cy: o.y * h, r: Math.min(iw, ih) / 2 * o.radius};
  }

  function draw(ctx, w, h, t){
    if (!S.overlays.length) return;
    for (const o of S.overlays) {
      const image = images.get(o.imageId);
      if (!image) continue;
      let alpha = overlayAlpha(o, t);
      if (alpha <= 0) continue;
      const box = overlayBox(o, w, h);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(box.cx, box.cy);
      ctx.rotate(o.rot);
      roundedRect(ctx, -box.iw / 2, -box.ih / 2, box.iw, box.ih, box.r);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.canvas, -box.iw / 2, -box.ih / 2, box.iw, box.ih);
      ctx.restore();
    }
  }

  // ---------- Barra de herramientas ----------
  const addVideoBtn = document.getElementById('addVideo');
  const addBtn = document.createElement('button');
  addBtn.className = 'icon-btn';
  addBtn.id = 'addImage';
  addBtn.type = 'button';
  addBtn.setAttribute('aria-label', 'Añadir imagen');
  addBtn.title = 'Añadir imagen';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="m3.5 17 5-4.5 3.5 3 3-2.5 5.5 4.5"/></svg>';
  if (addVideoBtn) addVideoBtn.after(addBtn);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  document.body.appendChild(fileInput);
  addBtn.addEventListener('click', () => {
    if (S.exporting || !S.clips.length) return;
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) addImageFile(file).catch(error => { console.error(error); alert('No se pudo abrir esta imagen.'); });
  });

  // ---------- Línea de tiempo de imágenes ----------
  const strip = document.getElementById('projectStrip');
  const track = document.createElement('div');
  track.className = 'overlay-track hidden';
  const trackContent = document.createElement('div');
  trackContent.className = 'overlay-content';
  track.appendChild(trackContent);
  strip.parentNode.insertBefore(track, strip);

  // ---------- Sección "Imagen" (solo cuando hay imágenes) ----------
  const projectCard = document.getElementById('projectCard');
  const card = document.createElement('section');
  card.className = 'card image-card hidden';
  card.innerHTML =
    '<h2>Imagen <span class="r image-card-name"></span></h2>' +
    '<div class="image-card-body">' +
      '<div class="image-card-thumb" aria-hidden="true"></div>' +
      '<div class="image-card-rows">' +
        '<label class="image-row"><span>Esquinas</span><input class="image-radius" type="range" min="0" max="100" step="1" value="0"><output class="image-radius-out">0%</output></label>' +
        '<label class="image-row"><span>Aparecer</span><input class="image-fade-in" type="range" min="0" max="5" step="0.1" value="1"><output class="image-fade-in-out">1.0 s</output></label>' +
        '<label class="image-row"><span>Desaparecer</span><input class="image-fade-out" type="range" min="0" max="5" step="0.1" value="1"><output class="image-fade-out-out">1.0 s</output></label>' +
      '</div>' +
    '</div>' +
    '<button class="btn image-delete" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 3h6l1 4H8zM6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>Quitar imagen</button>';
  if (projectCard) projectCard.after(card);
  const radiusInput = card.querySelector('.image-radius');
  const fadeInInput = card.querySelector('.image-fade-in');
  const fadeOutInput = card.querySelector('.image-fade-out');
  const activeOverlay = () => findOverlay(selectedId) || S.overlays[S.overlays.length - 1] || null;
  function syncCard(){
    const o = activeOverlay();
    card.classList.toggle('hidden', !o);
    if (!o) return;
    const image = images.get(o.imageId);
    card.querySelector('.image-card-name').textContent = image ? image.name : '';
    const thumb = card.querySelector('.image-card-thumb');
    const url = image && image.url ? 'url("' + image.url + '")' : '';
    if (thumb.style.backgroundImage !== url) thumb.style.backgroundImage = url;
    thumb.style.borderRadius = Math.round(o.radius * 50) + '%';
    const maxFade = Math.max(0, Math.min(5, o.end - o.start));
    fadeInInput.max = fadeOutInput.max = String(Math.max(0.1, Math.round(maxFade * 10) / 10));
    if (document.activeElement !== radiusInput) radiusInput.value = String(Math.round(o.radius * 100));
    if (document.activeElement !== fadeInInput) fadeInInput.value = String(o.fadeIn);
    if (document.activeElement !== fadeOutInput) fadeOutInput.value = String(o.fadeOut);
    card.querySelector('.image-radius-out').textContent = Math.round(o.radius * 100) + '%';
    card.querySelector('.image-fade-in-out').textContent = o.fadeIn.toFixed(1) + ' s';
    card.querySelector('.image-fade-out-out').textContent = o.fadeOut.toFixed(1) + ' s';
  }
  radiusInput.addEventListener('input', () => {
    const o = activeOverlay(); if (!o) return;
    o.radius = Number(radiusInput.value) / 100;
    syncCard(); B.requestDraw();
  });
  fadeInInput.addEventListener('input', () => {
    const o = activeOverlay(); if (!o) return;
    o.fadeIn = clamp(Number(fadeInInput.value), 0, o.end - o.start);
    syncCard(); renderTrack(); B.requestDraw();
  });
  fadeOutInput.addEventListener('input', () => {
    const o = activeOverlay(); if (!o) return;
    o.fadeOut = clamp(Number(fadeOutInput.value), 0, o.end - o.start);
    syncCard(); renderTrack(); B.requestDraw();
  });
  card.querySelector('.image-delete').addEventListener('click', () => { const o = activeOverlay(); if (o) removeOverlay(o.id); });

  // ---------- Diálogo de fundido ----------
  const dialog = document.createElement('dialog');
  dialog.className = 'apple-dialog';
  dialog.innerHTML =
    '<form method="dialog">' +
    '<h3 class="ov-fade-title">Fundido</h3>' +
    '<div class="fade-grid ov-fade-grid"><label><span class="ov-fade-label">Duración</span><input class="ov-fade-input" type="number" inputmode="decimal" min="0" step="0.1" value="0"><span>s</span></label></div>' +
    '<div class="dialog-actions"><button class="btn ghost" value="cancel">Cancelar</button><button class="btn primary" value="ok">Aceptar</button></div>' +
    '</form>';
  document.body.appendChild(dialog);
  const fadeInput = dialog.querySelector('.ov-fade-input');
  let fadeTarget = null;
  function openFade(o, kind){
    fadeTarget = {id: o.id, kind};
    dialog.querySelector('.ov-fade-title').textContent = kind === 'in' ? 'Fundido de entrada' : 'Fundido de salida';
    fadeInput.value = String(Math.round((kind === 'in' ? o.fadeIn : o.fadeOut) * 10) / 10);
    dialog.returnValue = '';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      const answer = prompt(kind === 'in' ? 'Fundido de entrada (segundos)' : 'Fundido de salida (segundos)', fadeInput.value);
      if (answer !== null) { fadeInput.value = answer; applyFade(); }
    }
  }
  function applyFade(){
    const o = fadeTarget && findOverlay(fadeTarget.id);
    if (!o) return;
    const value = clamp(parseFloat(String(fadeInput.value).replace(',', '.')) || 0, 0, o.end - o.start);
    if (fadeTarget.kind === 'in') o.fadeIn = value; else o.fadeOut = value;
    renderTrack();
    syncCard();
    B.requestDraw();
  }
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'ok') applyFade(); fadeTarget = null; });

  // ---------- Visor en modo imagen ----------
  const stage = els.stage;
  const editCanvas = document.createElement('canvas');
  editCanvas.className = 'image-edit-canvas';
  stage.appendChild(editCanvas);
  const editCtx = editCanvas.getContext('2d', {alpha: false});
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'image-done-pill';
  doneBtn.textContent = 'Listo';
  stage.appendChild(doneBtn);
  ['pointerdown', 'pointerup', 'click'].forEach(type => doneBtn.addEventListener(type, e => e.stopPropagation()));
  doneBtn.addEventListener('click', () => exitEdit());

  function enterEdit(id){
    if (!findOverlay(id)) return;
    selectedId = id;
    stage.classList.add('image-mode');
    const size = B.outSize();
    stage.style.aspectRatio = size.w + ' / ' + size.h;
    renderTrack();
    syncCard();
    B.requestDraw();
  }
  function exitEdit(){
    if (!selectedId && !stage.classList.contains('image-mode')) return;
    selectedId = null;
    stage.classList.remove('image-mode');
    if (S.VW && S.VH) stage.style.aspectRatio = S.VW + ' / ' + S.VH;
    stageGestures.clear();
    renderTrack();
    syncCard();
    try { B.syncCrop(); } catch (error) {}
    B.requestDraw();
  }
  // Elegir una proporción de encuadre vuelve al modo de recorte.
  const ratios = document.getElementById('ratios');
  if (ratios) ratios.addEventListener('click', () => exitEdit(), true);

  // Gestos sobre la imagen: 1 dedo mueve, 2 dedos agrandan/achican y giran.
  // Funcionan en el visor (modo imagen) y también en la ventana flotante.
  function makeImageGestures(el, pickOverlay){
    const pointers = new Map();
    let gesture = null;
    let activeOverlay = null;
    const pointInfo = e => {
      const r = el.getBoundingClientRect();
      return {x: e.clientX, y: e.clientY, u: (e.clientX - r.left) / Math.max(1, r.width), v: (e.clientY - r.top) / Math.max(1, r.height)};
    };
    function startGesture(){
      const o = activeOverlay;
      const list = [...pointers.values()];
      if (!o || !list.length) { gesture = null; return; }
      if (list.length >= 2) {
        const [a, b] = list;
        gesture = {
          type: 'pinch', o,
          dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
          mu: (a.u + b.u) / 2, mv: (a.v + b.v) / 2,
          scale: o.scale, rot: o.rot, x: o.x, y: o.y
        };
      } else {
        gesture = {type: 'drag', o, u: list[0].u, v: list[0].v, x: o.x, y: o.y};
      }
    }
    el.addEventListener('pointerdown', e => {
      if (S.exporting) return;
      if (!pointers.size) {
        activeOverlay = pickOverlay(e, pointInfo(e));
        if (!activeOverlay) return;
      }
      e.preventDefault();
      e.stopPropagation();
      pointers.set(e.pointerId, pointInfo(e));
      try { el.setPointerCapture(e.pointerId); } catch (error) {}
      startGesture();
    });
    el.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      e.stopPropagation();
      pointers.set(e.pointerId, pointInfo(e));
      if (!gesture) return;
      const o = gesture.o;
      const list = [...pointers.values()];
      if (gesture.type === 'pinch' && list.length >= 2) {
        const [a, b] = list;
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        o.scale = clamp(gesture.scale * dist / gesture.dist, 0.03, 4);
        o.rot = gesture.rot + (angle - gesture.angle);
        o.x = clamp(gesture.x + ((a.u + b.u) / 2 - gesture.mu), -0.25, 1.25);
        o.y = clamp(gesture.y + ((a.v + b.v) / 2 - gesture.mv), -0.25, 1.25);
      } else if (gesture.type === 'drag' && list.length === 1) {
        o.x = clamp(gesture.x + (list[0].u - gesture.u), -0.25, 1.25);
        o.y = clamp(gesture.y + (list[0].v - gesture.v), -0.25, 1.25);
      }
      B.requestDraw();
    });
    const endPointer = e => {
      if (!pointers.has(e.pointerId)) return;
      e.stopPropagation();
      pointers.delete(e.pointerId);
      if (!pointers.size) { activeOverlay = null; gesture = null; return; }
      startGesture();
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    ['click', 'dblclick'].forEach(type => el.addEventListener(type, e => { if (activeOverlay || el === editCanvas) e.stopPropagation(); }));
    // Computadora: rueda o pellizco del trackpad para el tamaño; Mayús + rueda para girar.
    el.addEventListener('wheel', e => {
      const o = pickOverlay(e, pointInfo(e));
      if (!o) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey || e.altKey) o.rot += (e.deltaY || e.deltaX) * 0.004;
      else o.scale = clamp(o.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0.03, 4);
      B.requestDraw();
    }, {passive: false});
    return {clear(){ pointers.clear(); gesture = null; activeOverlay = null; }};
  }

  // En el visor (modo imagen) los gestos siempre mueven la imagen seleccionada.
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(type => {
    editCanvas.addEventListener(type, e => e.stopPropagation());
  });
  const stageGestures = makeImageGestures(editCanvas, () => findOverlay(selectedId));

  // En la ventana flotante: si el dedo toca una imagen, se edita la imagen;
  // si toca fuera de ella, la ventana se mueve o cambia de tamaño como siempre.
  function hitOverlay(info, el){
    const r = el.getBoundingClientRect();
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    const t = B.currentProjectTime();
    const list = S.overlays.slice().reverse();
    const selected = findOverlay(selectedId);
    if (selected) { list.splice(list.indexOf(selected), 1); list.unshift(selected); }
    for (const o of list) {
      const image = images.get(o.imageId);
      if (!image) continue;
      if (o.id !== selectedId && overlayAlpha(o, t) <= 0) continue;
      const box = overlayBox(o, W, H);
      const dx = info.u * W - box.cx, dy = info.v * H - box.cy;
      const cos = Math.cos(-o.rot), sin = Math.sin(-o.rot);
      const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      const pad = 10;
      if (Math.abs(lx) <= box.iw / 2 + pad && Math.abs(ly) <= box.ih / 2 + pad) return o;
    }
    return null;
  }
  const floatingCanvas = els.floatingCanvas || document.getElementById('floatingCanvas');
  if (floatingCanvas) {
    floatingCanvas.style.touchAction = 'none';
    makeImageGestures(floatingCanvas, (e, info) => {
      if (!S.floatingPreview) return null;
      const o = hitOverlay(info, floatingCanvas);
      if (o && o.id !== selectedId) enterEdit(o.id);
      return o;
    });
  }

  // ---------- Línea de tiempo: segmentos ----------
  function renderTrack(){
    const total = totalDuration();
    track.classList.toggle('hidden', !S.overlays.length);
    const existing = new Map([...trackContent.children].map(el => [el.dataset.id, el]));
    for (const o of S.overlays) {
      let seg = existing.get(o.id);
      if (!seg) {
        seg = document.createElement('div');
        seg.className = 'overlay-seg';
        seg.dataset.id = o.id;
        seg.innerHTML = '<i class="ov-fade in"></i><i class="ov-fade out"></i><span class="ov-handle l"></span><span class="ov-handle r"></span>';
        bindSegment(seg);
        trackContent.appendChild(seg);
        const image = images.get(o.imageId);
        if (image && image.url) seg.style.backgroundImage = 'url("' + image.url + '")';
      }
      existing.delete(o.id);
      const start = clamp(o.start, 0, total), end = clamp(o.end, 0, total);
      const length = Math.max(0.0001, o.end - o.start);
      seg.style.left = (total ? start / total * 100 : 0) + '%';
      seg.style.width = (total ? Math.max(0, end - start) / total * 100 : 0) + '%';
      seg.querySelector('.ov-fade.in').style.width = Math.min(100, o.fadeIn / length * 100) + '%';
      seg.querySelector('.ov-fade.out').style.width = Math.min(100, o.fadeOut / length * 100) + '%';
      seg.classList.toggle('selected', o.id === selectedId);
    }
    existing.forEach(el => el.remove());
  }

  function bindSegment(seg){
    let drag = null;
    seg.addEventListener('pointerdown', e => {
      const o = findOverlay(seg.dataset.id);
      if (!o || S.exporting) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move';
      drag = {o, mode, x: e.clientX, start: o.start, end: o.end, moved: false, width: trackContent.getBoundingClientRect().width};
      try { seg.setPointerCapture(e.pointerId); } catch (error) {}
    });
    seg.addEventListener('pointermove', e => {
      if (!drag) return;
      e.preventDefault();
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 6) drag.moved = true;
      if (!drag.moved) return;
      const total = totalDuration();
      const dt = dx / Math.max(1, drag.width) * total;
      const o = drag.o;
      if (drag.mode === 'start') o.start = clamp(drag.start + dt, 0, o.end - MIN_DURATION);
      else if (drag.mode === 'end') o.end = clamp(drag.end + dt, o.start + MIN_DURATION, total);
      else {
        const length = drag.end - drag.start;
        o.start = clamp(drag.start + dt, 0, Math.max(0, total - length));
        o.end = o.start + length;
      }
      o.fadeIn = Math.min(o.fadeIn, o.end - o.start);
      o.fadeOut = Math.min(o.fadeOut, o.end - o.start);
      renderTrack();
      B.requestDraw();
    });
    const finish = e => {
      if (!drag) return;
      const {o, mode, moved} = drag;
      drag = null;
      if (moved) { setAnchors(o); syncCard(); if (mode === 'move') enterEdit(o.id); return; }
      if (mode === 'start') openFade(o, 'in');
      else if (mode === 'end') openFade(o, 'out');
      else if (selectedId === o.id) exitEdit();
      else enterEdit(o.id);
    };
    seg.addEventListener('pointerup', finish);
    seg.addEventListener('pointercancel', () => { if (drag && drag.moved) setAnchors(drag.o); drag = null; });
  }


  // ---------- Efecto imán: la imagen queda anclada al contenido del video ----------
  function clipLayout(){
    let offset = 0;
    return S.clips.map(c => {
      const item = {c, offset, dur: Math.max(0, c.end - c.start)};
      offset += item.dur;
      return item;
    });
  }
  function anchorAt(t, kind){
    const layout = clipLayout();
    if (!layout.length) return null;
    let hit = null;
    for (const item of layout) {
      const a = item.offset, b = item.offset + item.dur;
      if (kind === 'end' ? (t > a + 1e-6 && t <= b + 1e-6) : (t >= a - 1e-6 && t < b - 1e-6)) { hit = item; break; }
    }
    if (!hit) hit = kind === 'end' ? layout[layout.length - 1] : layout[0];
    const local = clamp(t - hit.offset, 0, hit.dur);
    const c = hit.c;
    return {sourceId: c.sourceId, rev: !!c.reversed, st: c.reversed ? c.end - local : c.start + local};
  }
  function resolveAnchor(anchor, previous){
    const total = totalDuration();
    if (!anchor) return clamp(previous, 0, total);
    let best = null;
    for (const item of clipLayout()) {
      const c = item.c;
      if (c.sourceId !== anchor.sourceId || !!c.reversed !== anchor.rev) continue;
      const st = clamp(anchor.st, c.start, c.end);
      const distance = Math.abs(anchor.st - st);
      const time = item.offset + (c.reversed ? c.end - st : st - c.start);
      const score = distance * 1000 + Math.abs(time - previous) * 0.001;
      if (!best || score < best.score) best = {score, time};
    }
    return best ? clamp(best.time, 0, total) : clamp(previous, 0, total);
  }
  function setAnchors(o){
    o.aStart = anchorAt(o.start, 'start');
    o.aEnd = anchorAt(o.end, 'end');
  }
  let clipsSignature = '';
  function clipsKey(){
    return S.clips.map(c => c.sourceId + ':' + c.start.toFixed(4) + ':' + c.end.toFixed(4) + ':' + (c.reversed ? 1 : 0)).join('|');
  }
  function followClips(){
    const key = clipsKey();
    if (key === clipsSignature) return;
    const first = !clipsSignature;
    clipsSignature = key;
    if (first) { S.overlays.forEach(o => { if (!o.aStart || !o.aEnd) setAnchors(o); }); return; }
    for (const o of S.overlays) {
      if (!o.aStart || !o.aEnd) setAnchors(o);
      const start = resolveAnchor(o.aStart, o.start);
      const end = Math.max(start, resolveAnchor(o.aEnd, o.end));
      o.start = start; o.end = end;
      o.fadeIn = Math.min(o.fadeIn, end - start);
      o.fadeOut = Math.min(o.fadeOut, end - start);
    }
    renderTrack();
    syncCard();
    B.requestDraw();
  }

  // ---------- Añadir / quitar ----------
  async function decodeImage(blob){
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob); } catch (error) {}
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function prepareImage(id, blob, name){
    const decoded = await decodeImage(blob);
    const w0 = decoded.width || decoded.naturalWidth, h0 = decoded.height || decoded.naturalHeight;
    if (!w0 || !h0) throw new Error('Imagen vacía');
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * k));
    canvas.height = Math.max(1, Math.round(h0 * k));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    if (decoded.close) { try { decoded.close(); } catch (error) {} }
    let file = blob;
    if (k < 1) {
      file = await new Promise(resolve => canvas.toBlob(out => resolve(out || blob), 'image/png'));
    }
    const image = {id, name: name || 'imagen', file, canvas, width: canvas.width, height: canvas.height, url: URL.createObjectURL(file)};
    images.set(id, image);
    return image;
  }

  async function addImageFile(file){
    const image = await prepareImage(newId('img'), file, (file.name || 'imagen').replace(/\.[^.]+$/, ''));
    const total = totalDuration();
    const fade = Math.min(1, total / 2);
    const o = {id: newId('ov'), imageId: image.id, start: 0, end: total, fadeIn: fade, fadeOut: fade, x: 0.5, y: 0.5, scale: 0.4, rot: 0, radius: 0};
    setAnchors(o);
    S.overlays.push(o);
    syncCard();
    renderTrack();
    enterEdit(o.id);
  }

  function removeOverlay(id){
    const o = findOverlay(id);
    if (!o) return;
    S.overlays = S.overlays.filter(item => item.id !== id);
    if (!S.overlays.some(item => item.imageId === o.imageId)) {
      const image = images.get(o.imageId);
      if (image && image.url) URL.revokeObjectURL(image.url);
      images.delete(o.imageId);
    }
    exitEdit();
    renderTrack();
    syncCard();
    B.requestDraw();
  }

  // ---------- Bucle: visor en modo imagen y línea de tiempo sincronizada ----------
  let lastTotal = -1, lastWidth = '';
  function loop(){
    if (selectedId && !findOverlay(selectedId)) exitEdit();
    if (S.overlays.length && !S.exporting) followClips();
    else if (!S.overlays.length) clipsSignature = '';
    if (card.classList.contains('hidden') === !!S.overlays.length) syncCard();
    if (stage.classList.contains('image-mode')) {
      const rect = editCanvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(2, Math.min(1600, Math.round(rect.width * dpr)));
      const h = Math.max(2, Math.min(1600, Math.round(rect.height * dpr)));
      if (editCanvas.width !== w || editCanvas.height !== h) { editCanvas.width = w; editCanvas.height = h; }
      editCtx.fillStyle = '#000';
      editCtx.fillRect(0, 0, w, h);
      editingDraw = true;
      try { B.drawComposite(editCtx, w, h); } finally { editingDraw = false; }
      const o = findOverlay(selectedId);
      if (o && images.get(o.imageId)) {
        const box = overlayBox(o, w, h);
        editCtx.save();
        editCtx.translate(box.cx, box.cy);
        editCtx.rotate(o.rot);
        editCtx.lineWidth = Math.max(1.5, 2 * dpr);
        editCtx.setLineDash([6 * dpr, 5 * dpr]);
        editCtx.strokeStyle = 'rgba(255,255,255,.9)';
        roundedRect(editCtx, -box.iw / 2, -box.ih / 2, box.iw, box.ih, box.r);
        editCtx.stroke();
        editCtx.restore();
      }
    }
    if (S.overlays.length) {
      const total = totalDuration();
      const width = els.timelineContent.style.width || '100%';
      if (total !== lastTotal) { lastTotal = total; renderTrack(); syncCard(); }
      if (width !== lastWidth) { lastWidth = width; trackContent.style.width = width; }
      trackContent.style.transform = 'translateX(' + (-strip.scrollLeft) + 'px)';
    } else if (!track.classList.contains('hidden')) {
      renderTrack();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Guardado del proyecto ----------
  function exportState(){
    return {
      overlays: S.overlays.map(o => ({...o})),
      images: [...images.values()].map(image => ({id: image.id, name: image.name, width: image.width, height: image.height}))
    };
  }
  function files(){
    return [...images.values()].map(image => ({id: image.id, file: image.file}));
  }
  async function importState(state, getFile){
    if (!state) return;
    for (const meta of state.images || []) {
      try {
        const blob = await getFile(meta.id);
        if (blob) await prepareImage(meta.id, blob, meta.name);
      } catch (error) { console.warn('No se pudo recuperar una imagen.', error); }
    }
    S.overlays = (state.overlays || []).filter(o => images.has(o.imageId));
    clipsSignature = '';
    renderTrack();
    syncCard();
    B.requestDraw();
  }

  window.RecorteImagenes = {draw, exportState, files, importState, exitEdit};
})();
