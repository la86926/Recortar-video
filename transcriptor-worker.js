/*
 * Transcripción en el propio dispositivo (Whisper con Transformers.js).
 * Recibe audio mono de 16 kHz y devuelve el texto por tramos, sin enviar el audio a ningún servidor.
 * El modelo se descarga una sola vez y el navegador lo guarda para las siguientes veces.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = 'onnx-community/whisper-base';
const RATE = 16000;
const WINDOW = 28;      // segundos por tramo (Whisper trabaja con 30 s)
const SEARCH = 4;       // segundos al final del tramo donde se busca una pausa para cortar
let asr = null;
let loading = null;

async function hasWebGPU(){
  try {
    if (!self.navigator || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (error) { return false; }
}

async function load(){
  if (asr) return asr;
  if (loading) return loading;
  const progress_callback = info => {
    if (info && info.status === 'progress' && info.total) {
      postMessage({type: 'download', file: info.file, loaded: info.loaded, total: info.total});
    }
  };
  loading = (async () => {
    if (await hasWebGPU()) {
      try {
        asr = await pipeline('automatic-speech-recognition', MODEL, {
          device: 'webgpu',
          dtype: {encoder_model: 'fp32', decoder_model_merged: 'q4'},
          progress_callback
        });
        return asr;
      } catch (error) {
        postMessage({type: 'note', message: 'WebGPU no disponible, se usa WASM'});
      }
    }
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      dtype: {encoder_model: 'fp32', decoder_model_merged: 'q8'},
      progress_callback
    });
    return asr;
  })();
  try { return await loading; }
  finally { loading = null; }
}

function rms(audio, from, to){
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / n);
}

// Corta el audio en tramos de ~28 s, buscando una pausa cerca del final de cada tramo.
function splitAudio(audio){
  const pieces = [];
  const step = Math.round(RATE * 0.05);
  let start = 0;
  while (start < audio.length) {
    let end = Math.min(audio.length, start + WINDOW * RATE);
    if (end < audio.length) {
      let best = end, bestEnergy = Infinity;
      for (let t = end - SEARCH * RATE; t <= end - step; t += step) {
        const energy = rms(audio, t, t + step);
        if (energy < bestEnergy) { bestEnergy = energy; best = t + Math.round(step / 2); }
      }
      end = best;
    }
    pieces.push([start, end]);
    start = end;
  }
  return pieces;
}

function clean(text){
  return String(text || '')
    .replace(/\[(?:m[uú]sica|music|aplausos|applause|risas|laughter|silencio|silence|blank_audio)\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

self.onmessage = async event => {
  const {type, audio} = event.data || {};
  if (type !== 'transcribe') return;
  try {
    postMessage({type: 'status', stage: 'model'});
    const transcriber = await load();
    postMessage({type: 'status', stage: 'transcribe'});
    const pieces = splitAudio(audio);
    let previous = '';
    for (let i = 0; i < pieces.length; i++) {
      const [from, to] = pieces[i];
      const chunk = audio.subarray(from, to);
      let text = '';
      // Se omiten los tramos casi en silencio (Whisper tiende a inventar texto en ellos).
      if (to - from > RATE * 0.4 && rms(chunk, 0, chunk.length) > 0.004) {
        // Siempre en español.
        const result = await transcriber(chunk, {language: 'spanish', task: 'transcribe', return_timestamps: false});
        text = clean(result && result.text);
        // Evita repetir el mismo texto si Whisper lo duplica entre tramos.
        if (text && text === previous) text = '';
        if (text) previous = text;
      }
      postMessage({type: 'piece', index: i, total: pieces.length, text});
    }
    postMessage({type: 'done'});
  } catch (error) {
    postMessage({type: 'error', message: error && error.message ? error.message : String(error)});
  }
};
