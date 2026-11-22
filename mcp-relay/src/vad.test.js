// node mcp-relay/src/vad.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let now = 0, level = 0, processor, stoppedTracks = 0, closedContexts = 0, disconnected = 0;
const timers = new Map();
let nextTimer = 0;
const node = () => ({ connect() {}, disconnect() { disconnected++; } });
class AudioContext {
  state = 'running';
  sampleRate = 48000;
  destination = {};
  createMediaStreamSource() { return node(); }
  createAnalyser() { return { ...node(), getFloatTimeDomainData: buffer => buffer.fill(level) }; }
  createScriptProcessor() { processor = node(); return processor; }
  createGain() { return { ...node(), gain: {} }; }
  async close() { closedContexts++; }
}
const context = vm.createContext({
  Blob, Float32Array, DataView, ArrayBuffer,
  window: { AudioContext },
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] }) } },
  document: { addEventListener() {}, removeEventListener() {} }, performance: { now: () => now },
  setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
});
vm.runInContext(readFileSync(new URL('../../vad.js', import.meta.url), 'utf8'), context);
const segments = [];
const segmentStats = [];
const health = [];
let starts = 0;
const vad = await context.window.createVAD({
  calibrateMs: 0, silenceMs: 180, preRollMs: 300, maxSpeechMs: 600,
  onSpeechStart(stats) { starts++; assert.ok(stats.level > stats.threshold); },
  onSpeechEnd(blob, stats) { segments.push(blob); segmentStats.push(stats); },
  onAudioHealth(stats) { health.push(stats); },
});
function tick(value) {
  level = value;
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1440).fill(value) } });
  now += 30;
  const pending = [...timers.values()]; timers.clear();
  for (const fn of pending) fn();
}
for (let i = 0; i < 15; i++) tick(0.001);
for (let i = 0; i < 25; i++) tick(0.05);
assert.equal(starts, 1);
assert.equal(segments.length, 1, 'hard max ends continuous noise/speech');
assert.equal(segmentStats[0].reason, 'max_duration');
assert.ok(segmentStats[0].peak > 0.04 && segmentStats[0].durationMs >= 600);
assert.equal(segments[0].type, 'audio/wav');
const wav = new DataView(await segments[0].arrayBuffer());
assert.equal(wav.getUint32(24, true), 16000);
assert.equal(wav.getUint32(40, true), wav.byteLength - 44);
assert.ok(wav.getInt16(44, true) > 0 && wav.getInt16(44, true) < 100, 'pre-roll contains quiet audio before onset');
assert.ok(wav.byteLength <= 44 + 16000 * 2, 'recording is bounded including pre-roll');
for (let i = 0; i < 30; i++) tick(0.05);
assert.ok(segments.length >= 2, 'the next segment remains independently decodable');
for (let i = 0; i < 270; i++) tick(0.001);
assert.ok(health.some(item => item.samples > 0 && item.peak < item.threshold), 'quiet periods still report microphone samples');
const beforeStop = segments.length;
vad.stop();
tick(0.05);
assert.equal(segments.length, beforeStop);
assert.equal(timers.size, 0);
assert.equal(processor.onaudioprocess, null);
assert.equal(stoppedTracks, 1);
assert.equal(closedContexts, 1);
assert.equal(disconnected, 4);
console.log('VAD checks passed');
