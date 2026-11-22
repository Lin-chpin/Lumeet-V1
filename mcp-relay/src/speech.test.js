// node mcp-relay/src/speech.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../video.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const timers = new Set();
const clients = [];

function client() {
  const requests = [], audios = [], subtitles = [], logs = [], statuses = [];
  class Audio {
    constructor(src) { this.src = src; audios.push(this); }
    play() { this.played = true; this.onplaying?.(); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
  }
  const c = vm.createContext({
    crypto, performance, URL, btoa, atob, Audio, WebSocket: { OPEN: 1 },
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => ({}) },
    console,
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
    clearTimeout, setInterval, clearInterval,
    synth: text => new Promise((resolve, reject) => requests.push({ text, resolve, reject })),
    subtitle: text => subtitles.push(text),
    status: text => statuses.push(text),
    record: (event, detail) => logs.push({ event, detail }),
  });
  vm.runInContext(source, c);
  vm.runInContext(`isInCall = true;
    cfg = {ttsProvider:'elevenlabs', elKey:'test', elVoice:'original-voice', elModel:'eleven_turbo_v2_5'};
    textToSpeech = synth; setSubtitle = subtitle; setStatus = status;
    latencyLog = record; log = () => {};
  `, c);
  const run = script => vm.runInContext(script, c);
  run(`globalThis.makeTrace = () => inputTrace('test');`);
  const result = { c, run, requests, audios, subtitles, logs, statuses };
  clients.push(result);
  return result;
}

try {
  // A later segment may finish first; playback still starts with part one immediately.
  const ordered = client();
  ordered.run(`globalThis.done = speak('第一句。第二句。第三句。', '', 1, makeTrace());`);
  await tick();
  assert.deepEqual(ordered.requests.map(r => r.text), ['第一句。', '第二句。']);
  ordered.requests[1].resolve('second');
  await tick();
  assert.equal(ordered.audios.length, 0);
  ordered.requests[0].resolve('first');
  await tick();
  assert.equal(ordered.audios.length, 1);
  assert.equal(ordered.audios[0].played, true);
  assert.equal(ordered.requests[2].text, '第三句。');
  ordered.requests[2].resolve('third');
  await tick();
  assert.equal(ordered.audios.length, 1);
  ordered.audios[0].onended();
  await tick();
  assert.match(ordered.audios[1].src, /second$/);
  ordered.audios[1].onended();
  await tick();
  assert.match(ordered.audios[2].src, /third$/);
  ordered.audios[2].onended();
  await ordered.c.done;
  assert.deepEqual(ordered.subtitles, ['第一句。第二句。第三句。']);

  // A second reply cannot replace the first reply while its audio is still playing.
  const queued = client();
  queued.run(`globalThis.first = speak('前一个。', '', 0, makeTrace());
    globalThis.second = speak('后一个。', '', 0, makeTrace());`);
  await tick();
  queued.requests[0].resolve('first');
  await tick();
  assert.equal(queued.requests.length, 1);
  assert.equal(queued.audios[0].paused, undefined);
  queued.audios[0].onended();
  await tick();
  assert.equal(queued.requests[1].text, '后一个。');
  queued.requests[1].resolve('second');
  await tick();
  queued.run('cancelVivixResponse()');
  await queued.c.second;
  assert.equal(queued.audios[1].paused, true);

  // Cancellation invalidates synthesis, queued replies, and future prefetches.
  const cancelled = client();
  cancelled.run(`globalThis.old = speak('旧一。旧二。旧三。', '', 0, makeTrace());
    globalThis.queued = speak('不应该生成。', '', 0, makeTrace());`);
  await tick();
  cancelled.run('cancelVivixResponse()');
  cancelled.requests[0].resolve('stale-first');
  cancelled.requests[1].reject(new Error('late failure'));
  await cancelled.c.old;
  await cancelled.c.queued;
  assert.equal(cancelled.requests.length, 2);
  assert.equal(cancelled.audios.length, 0);
  assert.equal(cancelled.logs.some(log => log.event === 'tts_failed'), false);

  // A completed synthesis from an old call cannot speak or clear a new call's state.
  const late = client();
  late.run(`globalThis.old = speak('上一通。', '', 0, makeTrace());`);
  await tick();
  late.run(`cancelVivixResponse(); callTraceId = crypto.randomUUID(); isInCall = true;
    globalThis.fresh = speak('当前通话。', '', 0, makeTrace());`);
  await tick();
  late.requests[1].resolve('fresh');
  await tick();
  const statusCount = late.statuses.length;
  late.requests[0].resolve('stale');
  await late.c.old;
  assert.equal(late.audios.length, 1);
  assert.match(late.audios[0].src, /fresh$/);
  assert.equal(late.run('aiSpeaking'), true);
  assert.equal(late.statuses.length, statusCount);
  late.audios[0].onended();
  await late.c.fresh;

  // Performance tags are only passed to ElevenLabs; subtitles keep normal text.
  const envelope = client();
  envelope.run(`globalThis.done = speak('正常字幕。', '', 0, makeTrace(), '[whispers]表演文本。');`);
  await tick();
  assert.deepEqual(envelope.subtitles, ['正常字幕。']);
  assert.equal(envelope.requests[0].text, '[whispers]表演文本。');
  envelope.requests[0].resolve('speech');
  await tick();
  envelope.audios[0].onended();
  await envelope.c.done;

  // Cancelling before MediaSource opens settles ready as well as playback promises.
  const stream = client();
  stream.c.window.MediaSource = class {
    static isTypeSupported() { return true; }
    addEventListener() {}
  };
  stream.c.MediaSource = stream.c.window.MediaSource;
  stream.c.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  stream.run(`globalThis.player = createMp3StreamPlayer(makeTrace()); player.close();`);
  await assert.rejects(stream.c.player.ready, /取消/);
  await assert.rejects(stream.c.player.playbackStarted, /取消/);
  await assert.rejects(stream.c.player.playbackEnded, /取消/);
  stream.run(`cfg.elModel = 'eleven_v4'; globalThis.done = speak('等待媒体打开。', '', 0, makeTrace());`);
  await tick();
  stream.run('cancelVivixResponse()');
  await stream.c.done;
  assert.equal(stream.logs.some(log => log.event === 'tts_failed'), false);

  // A dialogue socket cancelled before opening rejects promptly without orphaned done/ready promises.
  const connection = client();
  connection.c.WebSocket = class {
    static OPEN = 1;
    static CLOSING = 2;
    constructor(url) { this.url = url.href; this.readyState = 0; }
    close() { this.readyState = 3; this.onclose?.(); }
  };
  connection.run(`globalThis.done = textToDialogueSpeech('未连接。', 'eleven_v4', undefined, makeTrace());`);
  const cancelledConnection = assert.rejects(connection.c.done, /取消|關閉/);
  connection.run('cancelVivixResponse()');
  await cancelledConnection;
  assert.equal(connection.run('activeDialogueConnection'), null);

  console.log('Speech checks passed');
} finally {
  for (const { run } of clients) run('cancelVivixResponse()');
  for (const timer of timers) clearTimeout(timer);
}
