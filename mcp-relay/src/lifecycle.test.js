// node mcp-relay/src/lifecycle.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CallRoom } from './index.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const originalInfo = console.info;
console.info = () => {};
const deadline = setTimeout(() => { throw new Error('Lifecycle checks timed out'); }, 10000);
const scope = (call = 'call-a') => ({ session_id: 'session-one', call_id: call });
const event = (type, id, call = 'call-a', rest = {}) => ({ type, request_id: id, trace_id: id, ...scope(call), ...rest });
async function post(room, path, body) {
  const response = await room.fetch(new Request(`https://room/${path}`, { method: 'POST', body: JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
}
const poll = async (room, call) => (await room.fetch(new Request(`https://room/app/replies?after=0&wait=0&call_id=${call}`))).json();

function client() {
  let now = 1000, nextTimer = 0;
  const timers = new Map();
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', src: '', style: {},
      prepend() {}, removeAttribute() {}, setAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} }, querySelector() { return this; },
    });
    return nodes.get(id);
  };
  const sandbox = vm.createContext({
    crypto, TextEncoder, URL, Blob, FormData, AbortController, DOMException, btoa, atob, console: { info() {} },
    performance: { now: () => now }, Date,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++nextTimer, clearInterval() {},
    window: { addEventListener() {} },
    location: { protocol: 'https:', origin: 'https://relay.test' },
    document: { addEventListener() {}, createElement: () => ({}), getElementById: element },
  });
  const run = code => vm.runInContext(code, sandbox);
  run(readFileSync(new URL('../../video.js', import.meta.url), 'utf8'));
  run(`cfg={aiMode:'mcp'}; isInCall=true; callTraceId='call-a'; sessionTraceId='session-one';`);
  return { sandbox, run, element, setNow: value => { now = value; }, fire(delay) {
    const scheduled = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of scheduled) if (timers.delete(id)) timer.fn();
  }, timers };
}

try {
  const room = new CallRoom({}, {});
  const start = event('call_started', 'start-a');
  assert.equal((await post(room, 'app/event', start)).status, 200);
  const message = event('message', 'request-a', 'call-a', { text: 'hello' });
  await post(room, 'app/event', message);
  assert.equal((await post(room, 'app/event', message)).data.duplicate, true);
  assert.equal((await post(room, 'app/event', start)).data.duplicate, true);
  assert.equal(room.inbox.length, 2, 'duplicate call_started must not discard queued input');
  const delivered = (await post(room, 'ai/wait', {})).data.events;
  assert.equal(delivered[1].request_id, 'request-a');
  assert.equal(delivered[1].call_id, 'call-a');
  assert.equal(delivered[1].session_id, 'session-one');
  assert.equal((await post(room, 'ai/reply', { text: 'anonymous' })).status, 409);
  const reply = { text: 'visible', speech_text: '[warmly] voice', reply_to: 'request-a' };
  await post(room, 'ai/reply', reply);
  assert.equal((await post(room, 'ai/reply', reply)).data.duplicate, true);
  assert.equal((await post(room, 'ai/reply', { text: 'same batch', reply_to: 'start-a' })).data.duplicate, true);
  assert.equal(room.seq, 1);
  assert.equal((await poll(room, 'call-a')).replies[0].speech_text, '[warmly] voice');
  assert.equal((await poll(room, 'call-b')).replies.length, 0);
  const ending = event('call_ended', 'end-a');
  await post(room, 'app/event', ending);
  assert.equal((await post(room, 'app/event', ending)).data.duplicate, true, 'end notification must be idempotent');
  assert.equal((await post(room, 'app/event', start)).status, 409);
  await post(room, 'app/event', event('call_started', 'start-b', 'call-b'));
  assert.equal((await post(room, 'app/event', message)).status, 409);
  assert.equal((await post(room, 'ai/reply', { text: 'late unknown', reply_to: 'unknown-a' })).status, 409);
  await post(room, 'ai/reply', reply); // A completed callback is harmless even after redial.
  assert.equal(room.outbox.length, 0);
  assert.equal(room.callId, 'call-b');
  // A delayed start cannot resurrect a call whose end arrived first.
  await post(room, 'app/event', event('call_ended', 'end-c', 'call-c'));
  assert.equal((await post(room, 'app/event', event('call_started', 'start-c', 'call-c'))).status, 409);
  assert.equal(room.callId, 'call-b');
  assert.equal(room.inCall, true);
  const reordered = new CallRoom({}, {});
  await post(reordered, 'app/event', event('call_ended', 'end-c', 'call-c'));
  assert.equal((await post(reordered, 'app/event', event('call_started', 'start-c', 'call-c'))).status, 409);
  assert.equal(reordered.inCall, false);

  // Async R2 writes cannot duplicate an enqueue or insert an old call into a new one.
  const r2 = deferred();
  let puts = 0;
  const imageRoom = new CallRoom({}, { VISION: { put: () => { puts++; return r2.promise; } } });
  await post(imageRoom, 'app/event', start);
  const image = event('message', 'image-a', 'call-a', { text: 'look', image: 'AA==', image_source: 'camera' });
  const uploading = post(imageRoom, 'app/event', image);
  await flush();
  assert.equal((await post(imageRoom, 'app/event', image)).data.duplicate, true);
  assert.equal(puts, 1);
  await post(imageRoom, 'app/event', event('call_started', 'start-b', 'call-b'));
  r2.resolve();
  assert.equal((await uploading).status, 409);
  assert.equal(imageRoom.inbox.length, 1);
  assert.equal(imageRoom.lastFrame, null);
  const successfulUpload = deferred();
  const uploadRoom = new CallRoom({}, { VISION: { put: () => successfulUpload.promise } });
  await post(uploadRoom, 'app/event', start);
  const originalUpload = post(uploadRoom, 'app/event', image);
  await flush();
  assert.equal((await post(uploadRoom, 'app/event', image)).data.duplicate, true);
  successfulUpload.resolve();
  assert.equal((await originalUpload).status, 200);
  assert.equal(uploadRoom.inbox.filter(item => item.request_id === 'image-a').length, 1);

  // Optional camera caching cannot reorder delivery or revive a frame after a later screen capture.
  const slowCamera = deferred();
  const orderedImages = new CallRoom({}, { VISION: { put: () => slowCamera.promise } });
  await post(orderedImages, 'app/event', start);
  const cameraRequest = post(orderedImages, 'app/event', image);
  await flush();
  await post(orderedImages, 'app/event', event('message', 'screen-b', 'call-a', {
    text: 'screen', image: 'AQ==', image_source: 'screen',
  }));
  assert.deepEqual(orderedImages.inbox.filter(item => item.type === 'message').map(item => item.request_id), ['image-a', 'screen-b']);
  assert.equal(orderedImages.lastFrame, null);
  slowCamera.resolve();
  assert.equal((await cameraRequest).status, 200);
  assert.deepEqual(orderedImages.inbox.filter(item => item.type === 'message').map(item => item.request_id), ['image-a', 'screen-b']);
  assert.equal(orderedImages.lastFrame, null);

  const legacy = new CallRoom({}, {});
  const batchRoom = new CallRoom({}, {});
  await post(batchRoom, 'app/event', start);
  await post(batchRoom, 'app/event', message);
  await post(batchRoom, 'app/event', event('message', 'request-b', 'call-a', { text: 'supplement' }));
  await post(batchRoom, 'ai/wait', {});
  await post(batchRoom, 'ai/reply', { text: 'answering the whole batch', reply_to: 'request-a' });
  assert.equal(batchRoom.outbox[0].request_id, 'request-b', 'a batch reply belongs to the latest included supplement');
  await post(legacy, 'app/event', { type: 'call_started' });
  await post(legacy, 'app/event', { type: 'message', text: 'legacy', trace_id: 'legacy-request' });
  await post(legacy, 'ai/wait', {});
  assert.equal((await post(legacy, 'ai/reply', { text: 'legacy answer' })).status, 200);
  assert.equal(legacy.outbox[0].trace_match, 'single_pending_batch');

  // A response from a poll opened by A cannot advance B's cursor or play A's reply.
  {
    const c = client(), response = deferred();
    c.sandbox.transport = () => response.promise;
    c.run(`relayRequest=transport; globalThis.spoken=[]; speak=(...args)=>spoken.push(args);`);
    const oldPoll = c.run('pollRelay()');
    c.run(`callTraceId='call-b'; relayLastSeq=17; relayPolling='call-b';`);
    response.resolve({ last_seq: 99, replies: [{ seq: 99, text: 'late' }] });
    await oldPoll;
    assert.equal(c.run('relayLastSeq'), 17);
    assert.equal(c.run('relayPolling'), 'call-b');
    assert.equal(c.run('spoken.length'), 0);
  }

  // A new turn invalidates the pending answer to the previous turn, even in the same call.
  {
    const c = client();
    c.run(`relayRequest=async()=>({}); globalThis.a=inputTrace('recording'); globalThis.b=inputTrace('recording');`);
    await c.run(`relayEvent('message','first',undefined,a)`);
    await c.run(`relayEvent('message','supplement',undefined,b)`);
    assert.equal(c.run('a.cancelled'), true);
    c.run(`globalThis.spoken=[]; speak=(text)=>{spoken.push(text); isInCall=false;};
      relayRequest=async()=>({diagnostics_version:2,call_id:callTraceId,session_id:sessionTraceId,last_seq:2,
        replies:[{seq:1,text:'old',trace_id:a.id},{seq:2,text:'current',trace_id:b.id}]});`);
    await c.run('pollRelay()');
    assert.deepEqual(Array.from(c.sandbox.spoken), ['current']);
  }

  // Late direct-model and non-realtime ASR results do not pollute the redialled call.
  {
    const c = client(), response = deferred();
    c.sandbox.transport = () => response.promise;
    c.run(`cfg={aiMode:'api',llmBase:'https://llm.test',llmKey:'test'}; httpJson=transport;
      globalThis.oldTrace=inputTrace('recording');`);
    const request = c.run(`chatWithLLM('old input',oldTrace)`);
    c.run(`callTraceId='call-b'; chatHistory=[];`);
    response.resolve({ ok: true, data: { choices: [{ message: { content: 'old reply' } }] } });
    assert.equal(await request, '');
    assert.equal(c.run('chatHistory.length'), 0);
  }
  {
    const c = client(), transcript = deferred();
    c.sandbox.transcription = () => transcript.promise;
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.run(`cfg={sttKey:'test',sttProvider:'openai'}; transcribe=transcription;`);
    await c.run('startListening()');
    c.sandbox.vadCallbacks.onSpeechStart();
    const recognizing = c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['audio']));
    c.run(`callTraceId='call-b'; stopListening();`);
    transcript.resolve('old speech');
    await recognizing;
    assert.equal(c.run('voiceTurn'), null);
    assert.equal(c.run('pendingMcpMessages.size'), 0);
  }

  // Out-of-order ASR completion preserves spoken order and submits one aggregate turn.
  {
    const c = client();
    c.run(`globalThis.sent=[]; handleUserInput=(text,trace)=>sent.push({text,trace});
      globalThis.a=inputTrace('recording'); a.startedAt=1;
      globalThis.b=inputTrace('recording'); b.startedAt=2;
      globalThis.d=inputTrace('recording'); d.startedAt=3;
      pendingVoiceTranscriptions.add(a); pendingVoiceTranscriptions.add(b); pendingVoiceTranscriptions.add(d);
      queueVoiceTranscript('他说什么超级智能体',b); pendingVoiceTranscriptions.delete(b);
      queueVoiceTranscript('我感觉就是换个名字',d); pendingVoiceTranscriptions.delete(d); scheduleVoiceTurn();`);
    c.fire(300);
    assert.equal(c.run('sent.length'), 0);
    c.run(`queueVoiceTranscript('你看这个',a); pendingVoiceTranscriptions.delete(a); scheduleVoiceTurn();`);
    c.fire(300);
    assert.equal(c.run('sent.length'), 1);
    assert.equal(c.run('sent[0].text'), '你看这个\n他说什么超级智能体\n我感觉就是换个名字');
    c.run(`queueVoiceTranscript('继续说',inputTrace('recording')); localSpeechActive=true;`);
    c.fire(300);
    assert.equal(c.run('sent.length'), 1);
    c.run(`localSpeechActive=false; scheduleVoiceTurn(); isMuted=true; stopListening();`);
    c.fire(300);
    assert.equal(c.run('sent.length'), 1);
    assert.equal(c.run('voiceTurn'), null);
  }

  // Local VAD owns Scribe commit boundaries; partials alone never submit a turn.
  {
    const c = client();
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.run(`cfg={sttProvider:'elevenlabs',sttKey:'test'}; globalThis.pcm=[];
      openElevenLabsStt=async(callback,strategy)=>{globalThis.commitStrategy=strategy;return {sendPcm:(samples,commit)=>{pcm.push({samples,commit});return true;},close(){}};};
      globalThis.sent=[]; handleUserInput=(text)=>sent.push(text);`);
    assert.equal(c.run("isUnusableTranscript('。')"), true);
    assert.equal(c.run("isUnusableTranscript('...')"), true);
    assert.equal(c.run("isUnusableTranscript('你看这个')"), false);
    c.run("handleRealtimeSttMessage({message_type:'partial_transcript',text:'。'});");
    assert.equal(c.element('subtitle').textContent, '', 'punctuation must never appear as an ASR subtitle');
    await c.run('startListening()');
    await flush();
    assert.equal(c.run('commitStrategy'), 'manual');
    c.run(`globalThis.previous=inputTrace('recording');pendingMcpMessages.set(previous.id,previous);`);
    c.sandbox.vadCallbacks.onSpeechStart();
    assert.equal(c.run('previous.cancelled'), true, 'new speech must invalidate an old answer before ASR completes');
    c.run(`handleRealtimeSttMessage({message_type:'partial_transcript',text:'。'});
      handleRealtimeSttMessage({message_type:'partial_transcript',text:'你看这个'});`);
    assert.equal(c.element('subtitle').textContent, '你看这个');
    c.fire(300);
    assert.equal(c.run('sent.length'), 0);
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['audio']));
    assert.equal(c.run('pcm.at(-1).commit'), true);
    c.run(`handleRealtimeSttMessage({message_type:'committed_transcript',text:'你看这个'});`);
    c.fire(300);
    assert.equal(c.run('sent[0]'), '你看这个');
    c.sandbox.vadCallbacks.onSpeechStart();
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['short answer']));
    c.run(`handleRealtimeSttMessage({message_type:'committed_transcript',text:'嗯。'});`);
    c.fire(300);
    assert.equal(c.run('sent[1]'), '嗯。', 'Scribe should retain short spoken acknowledgements');
    c.run('stopListening()');
  }

  // A partial created before a photo must not hide the later, confirmed speech onset.
  {
    const c = client(), requests = [];
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.sandbox.transport = async (path, { body }) => { requests.push(body); return { ok: true }; };
    c.run(`cfg={aiMode:'mcp',sttProvider:'elevenlabs',sttKey:'test'}; relayRequest=transport;
      openElevenLabsStt=async()=>({sendPcm:()=>true,close(){}});
      handleRealtimeSttMessage({message_type:'partial_transcript',text:'。'});`);
    await c.run('startListening()');
    await flush();
    c.setNow(1100);
    c.run(`beginVisualRound('photo', 'camera'); stageVisualRound({roundId:'photo', source:'camera', image:'AQ=='});
      handleRealtimeSttMessage({message_type:'partial_transcript',text:'。'});`);
    assert.notEqual(c.run('visualRoundTimer'), null);
    c.setNow(1200);
    c.sandbox.vadCallbacks.onSpeechStart();
    assert.equal(c.run('visualRoundTimer'), null);
    c.fire(5000);
    assert.equal(requests.length, 0);
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['audio']));
    c.run(`handleRealtimeSttMessage({message_type:'committed_transcript',text:'看看这张照片'});`);
    c.fire(300);
    await flush();
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, '看看这张照片');
    assert.equal(requests[0].images[0].image, 'AQ==');
  }

  // A cancelled reply does not undo an accepted upload or retain its photo for the next round.
  {
    const c = client(), upload = deferred(), uploadStarted = deferred();
    c.sandbox.transport = () => { uploadStarted.resolve(); return upload.promise; };
    c.run(`relayRequest=transport;
      beginVisualRound('first-photo','camera'); stageVisualRound({roundId:'first-photo',source:'camera',image:'AQ=='});`);
    const sending = c.run(`sendVisualRound('看看照片')`);
    await uploadStarted.promise;
    c.run(`cancelPendingReplies(); setStatus('說話中');`);
    upload.resolve({ ok: true });
    await sending;
    assert.equal(c.run('visualRound.sent'), true);
    assert.equal(c.run('visualRound.imageCount'), 0);
    assert.equal(c.element('call-status').textContent, '說話中');
    c.run(`beginVisualRound('next-photo','camera'); stageVisualRound({roundId:'next-photo',source:'camera',image:'Ag=='});`);
    assert.equal(c.run('visualRound.imageCount'), 1);
    assert.equal(c.run('visualRound.frames[0].image'), 'Ag==');
  }

  // A newer voice request cancels an older screenshot while its local fingerprint is pending.
  {
    const c = client(), digest = deferred(), requests = [];
    c.sandbox.crypto = { randomUUID: crypto.randomUUID.bind(crypto), subtle: { digest: () => digest.promise } };
    c.sandbox.transport = async (_path, { body }) => { requests.push(body); return { ok: true }; };
    c.run(`relayRequest=transport;
      beginVisualRound('slow-photo','camera'); stageVisualRound({roundId:'slow-photo',source:'camera',image:'AQ=='});
      globalThis.oldPhotoTrace=inputTrace('visual');`);
    const oldSend = c.run(`sendVisualRound('旧照片',oldPhotoTrace)`);
    await flush();
    const newSend = c.run(`globalThis.newVoiceTrace=inputTrace('recording'); relayEvent('message','新语音',undefined,newVoiceTrace)`);
    await newSend;
    digest.resolve(new Uint8Array(32).buffer);
    await oldSend;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, '新语音');
    assert.equal(requests[0].images, undefined);
    assert.equal(c.run('visualRound.sent'), false);
    assert.equal(c.run('visualRound.imageCount'), 1);
    assert.match(c.run('visualRound.status'), /重试/);
  }

  // An empty final leaves the live socket usable while the old recording falls back.
  {
    const c = client(), first = deferred();
    c.sandbox.transcription = () => first.promise;
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.run(`cfg={sttProvider:'elevenlabs',sttKey:'test'}; connectRealtimeStt=async()=>{};
      transcribeElevenLabsBlob=transcription; globalThis.sent=[]; handleUserInput=text=>sent.push(text);
      globalThis.closes=0; globalThis.pcm=[];`);
    await c.run('startListening()');
    c.run(`realtimeStt={sendPcm(samples,commit){pcm.push({samples,commit});return true;},close(){closes++;}};`);
    c.sandbox.vadCallbacks.onSpeechStart();
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['a']));
    c.run(`handleRealtimeSttMessage({message_type:'committed_transcript',text:'。'});`);
    assert.equal(c.run('closes'), 0);
    assert.equal(c.run('realtimeSttReconnectTimer'), null);
    c.setNow(2000);
    c.sandbox.vadCallbacks.onSpeechStart();
    c.run(`sendRealtimeSttFrame(new Float32Array(1600).fill(0.1),16000);`);
    assert.equal(c.run('currentSpeechTrace.needsFallback'), false);
    assert.equal(c.run('currentSpeechTrace.liveSamples'), 1600);
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['b']));
    c.run(`handleRealtimeSttMessage({message_type:'committed_transcript',text:'。 第二句'});`);
    c.fire(300);
    assert.equal(c.run('sent.length'), 0, 'new live transcript waits for the older recording in the same turn');
    first.resolve('第一句');
    await flush();
    c.fire(300);
    assert.deepEqual(Array.from(c.sandbox.sent), ['第一句\n第二句']);
    assert.equal(c.run('pendingVoiceTranscriptions.size'), 0);
    c.run('stopListening()');
  }

  // Reconnecting mid-utterance cannot give the new live socket a recording with a missing prefix.
  {
    const c = client(), transcriptions = [];
    c.sandbox.transcription = () => {
      const next = deferred();
      transcriptions.push(next);
      return next.promise;
    };
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.run(`cfg={sttProvider:'elevenlabs',sttKey:'test'}; connectRealtimeStt=async()=>{};
      transcribeElevenLabsBlob=transcription; globalThis.sent=[]; handleUserInput=text=>sent.push(text);`);
    await c.run('startListening()');
    c.sandbox.vadCallbacks.onSpeechStart();
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['a']));
    c.setNow(3000);
    c.sandbox.vadCallbacks.onSpeechStart();
    c.run(`realtimeStt={sendPcm(){return true;},close(){}};
      handleRealtimeSttMessage({message_type:'partial_transcript',text:'前段殘留'});`);
    assert.equal(c.element('subtitle').textContent, '');
    transcriptions[0].resolve('第一句');
    await flush();
    assert.equal(c.run('currentSpeechTrace.needsFallback'), true);
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['b']));
    assert.equal(transcriptions.length, 2);
    assert.equal(c.run('realtimePendingUtterance'), null);
    transcriptions[1].resolve('第二句');
    await flush();
    assert.equal(c.run('pendingVoiceTranscriptions.size'), 0);
    c.fire(300);
    assert.deepEqual(Array.from(c.sandbox.sent), ['第一句\n第二句']);
    c.run('stopListening()');
  }

  // An old fallback waiting on I/O cannot block or submit into the next call.
  {
    const c = client(), first = deferred(), second = deferred(), signals = [];
    c.sandbox.transcription = (_blob, _trace, signal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    };
    c.sandbox.window.createVAD = async options => { c.sandbox.vadCallbacks = options; return { stop() {} }; };
    c.run(`cfg={sttProvider:'elevenlabs',sttKey:'test'}; connectRealtimeStt=async()=>{};
      transcribeElevenLabsBlob=transcription; globalThis.sent=[]; handleUserInput=text=>sent.push(text);`);
    await c.run('startListening()');
    c.sandbox.vadCallbacks.onSpeechStart();
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['a']));
    c.run(`stopListening(); callTraceId='call-b';`);
    assert.equal(signals[0].aborted, true);
    await c.run('startListening()');
    c.sandbox.vadCallbacks.onSpeechStart();
    await c.sandbox.vadCallbacks.onSpeechEnd(new Blob(['b']));
    assert.equal(signals.length, 2);
    first.resolve('上一通');
    await flush();
    assert.equal(c.run('pendingVoiceTranscriptions.size'), 1);
    second.resolve('这一通');
    await flush();
    c.fire(300);
    assert.deepEqual(Array.from(c.sandbox.sent), ['这一通']);
    c.run('stopListening()');
  }

  // Vocabulary context appears only on the first outgoing chunk of each connection.
  {
    const c = client(), sockets = [];
    c.sandbox.WebSocket = class {
      static OPEN = 1; static CLOSING = 2;
      constructor(url) { this.url = url; this.readyState = 1; this.frames = []; sockets.push(this); }
      send(frame) { this.frames.push(JSON.parse(frame)); }
      close() { this.readyState = 3; }
    };
    c.run(`cfg={sttKey:'test'}; httpJson=async()=>({ok:true,data:{token:'temporary'}});`);
    const connecting = c.run(`openElevenLabsStt(()=>{},'manual')`);
    await flush();
    sockets[0].onmessage({ data: JSON.stringify({ message_type: 'session_started' }) });
    const session = await connecting;
    session.sendPcm(new Int16Array([1])); session.sendPcm(new Int16Array([2]), true);
    assert.match(sockets[0].frames[0].previous_text, /琳琳.*臭面包.*Lumeet.*MCP.*Harness.*LangGraph.*ElevenLabs.*Claude.*Codex/);
    assert.equal('previous_text' in sockets[0].frames[1], false);
    session.close();

    const token = deferred();
    const cancel = new AbortController();
    c.sandbox.tokenResponse = () => token.promise;
    c.sandbox.signal = cancel.signal;
    c.run('httpJson=tokenResponse');
    const cancelled = c.run(`openElevenLabsStt(()=>{},'manual',undefined,signal)`);
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    cancel.abort();
    token.resolve({ ok: true, data: { token: 'late' } });
    await rejected;
    assert.equal(sockets.length, 1, 'late token must not open a new socket after hangup');
    await assert.rejects(c.run(`openElevenLabsStt(()=>{},'manual',undefined,{aborted:true})`), { name: 'AbortError' });
  }
  console.log('Lifecycle checks passed');
} finally {
  clearTimeout(deadline);
  console.info = originalInfo;
}
