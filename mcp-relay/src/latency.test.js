// node mcp-relay/src/latency.test.js
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { CallRoom } from './index.js';

// Cloudflare exposes this Web Crypto helper; Node supplies it from node:crypto.
if (!crypto.subtle.timingSafeEqual) Object.defineProperty(crypto.subtle, 'timingSafeEqual', { value: timingSafeEqual });

const room = new CallRoom({}, {});
let now = 1_000;
const originalNow = Date.now;
const originalInfo = console.info;
const serverLogs = [];
const imageHash = image => createHash('sha256').update(image).digest('hex');
console.info = (...parts) => serverLogs.push(parts.join(' '));
Date.now = () => now;
const post = async (op, body) => (await room.fetch(new Request(`https://room/${op}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'X-Call-Received-At': String(now - 10) },
}))).json();
const replies = async () => (await room.fetch(new Request('https://room/app/replies?after=0&wait=0'))).json();

try {
  await post('app/event', { type: 'call_started' });
  await post('ai/wait', {});
  await post('app/event', { type: 'message', text: 'PRIVATE_BODY_DO_NOT_LOG', trace_id: 'trace-1' });
  now = 1_300;
  const first = await post('ai/wait', {});
  assert.equal(first.events[0].trace_id, 'trace-1');
  now = 2_000;
  await post('ai/reply', { text: 'reply', reply_to: 'trace-1' });
  now = 2_100;
  const response = await replies();
  assert.equal(response.diagnostics_version, 3);
  assert.equal(response.replies[0].trace_match, 'explicit_batch');
  const t = response.replies[0].traces[0].timing;
  assert.equal(t.ai_delivered_at - t.enqueued_at, 300);
  assert.equal(t.reply_received_at - t.ai_delivered_at, 700);
  assert.equal(t.app_dispatched_at - t.reply_received_at, 100);
  assert.equal(t.relay_received_at - t.edge_received_at, 10);

  // 没有 reply_to 的旧连接器，同批多条输入都能带回独立计时。
  await post('app/event', { type: 'message', text: 'two', trace_id: 'trace-2' });
  await post('app/event', { type: 'message', text: 'three', trace_id: 'trace-3' });
  await post('ai/wait', {});
  await post('ai/reply', { text: 'batch reply' });
  const batch = (await replies()).replies[1];
  assert.equal(batch.trace_match, 'single_pending_batch');
  assert.deepEqual(batch.traces.map(x => x.trace_id), ['trace-2', 'trace-3']);

  // 不同批次不能猜；明确编号仍然可以关联正确批次。
  for (const id of ['trace-4', 'trace-5']) {
    await post('app/event', { type: 'message', text: 'another', trace_id: id });
    await post('ai/wait', {});
  }
  await post('ai/reply', { text: 'ambiguous' });
  assert.equal((await replies()).replies[2].trace_match, 'unmatched');
  assert.equal((await replies()).pending_traces.length, 2);
  await post('ai/reply', { text: 'matched', reply_to: 'trace-4' });
  assert.deepEqual((await replies()).replies[3].traces.map(x => x.trace_id), ['trace-4']);

  await post('app/event', { type: 'call_started' });
  await post('ai/wait', {});
  const waiting = post('ai/wait', { timeout_seconds: 1 });
  await new Promise(resolve => setImmediate(resolve));
  now = 3_000;
  await post('app/event', { type: 'message', text: 'wake', trace_id: 'bad\ninjected' });
  const awakened = await waiting;
  assert.match(awakened.events[0].trace_id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(awakened.events[0].timing.ai_wait_started_at, 2_100);
  assert.equal(awakened.events[0].timing.ai_delivered_at, 3_000);
  assert.equal((await replies()).pending_traces.length, 1);

  // 实际手机脚本与房间接口联跑，检查时间字段、消息关联和播放队列传参。
  await post('app/event', { type: 'call_started' });
  await post('ai/wait', {});
  const clientLogs = [];
  const client = vm.createContext({
    crypto, TextEncoder, Date, setTimeout, clearTimeout, performance: { now: () => now }, window: { addEventListener() {} },
    document: { addEventListener() {}, createElement: () => ({}), getElementById: () => ({
      prepend() {}, removeAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
    }) },
    console: { info: line => clientLogs.push(line) },
    relayTransport: async (path, { body } = {}) => (await room.fetch(new Request(`https://room${path}`, {
      method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    }))).json(),
  });
  vm.runInContext(readFileSync(new URL('../../video.js', import.meta.url), 'utf8'), client);
  const canvasEncodings = [];
  const originalCreateElement = client.document.createElement;
  client.document.createElement = tag => {
    assert.equal(tag, 'canvas');
    return {
      width: 0, height: 0,
      getContext: () => ({ drawImage() {}, translate() {}, scale() {} }),
      toDataURL(type, quality) {
        canvasEncodings.push({ width: this.width, height: this.height, quality });
        return 'data:image/jpeg;base64,AA==';
      },
    };
  };
  const portraitFrame = vm.runInContext('captureVideoFrame({videoWidth:1260, videoHeight:2800})', client);
  assert.equal(portraitFrame.width, 1152);
  assert.equal(portraitFrame.height, 2560);
  assert.equal(portraitFrame.sourceWidth, 1260);
  assert.equal(portraitFrame.cropWidth, 1260);
  assert.deepEqual(canvasEncodings[0], { width: 1152, height: 2560, quality: 0.9 });
  const croppedFrame = vm.runInContext('captureVideoFrame({videoWidth:1920, videoHeight:1080, clientWidth:767, clientHeight:1080}, undefined, 2560, true, true)', client);
  assert.ok(croppedFrame.cropX > 0 && croppedFrame.cropWidth < croppedFrame.sourceWidth);
  assert.equal(croppedFrame.mirrored, true);
  assert.equal(await vm.runInContext('imageFingerprint("AQ==")', client), imageHash('AQ=='));
  client.document.createElement = originalCreateElement;
  vm.runInContext(`beginVisualRound('speech-before-frame', 'screen');
    markVisualSpeechStarted(inputTrace('recording'));
    stageVisualRound({roundId:'speech-before-frame', source:'screen', image:'AA==', width:1152, height:2560});`, client);
  assert.match(vm.runInContext('visualRound.status', client), /等待语音最终分句/);
  assert.equal(vm.runInContext('visualRoundTimer', client), null);
  vm.runInContext('clearVisualRound()', client);
  now = 4_000;
  await vm.runInContext(`cfg = { aiMode: 'mcp' }; isInCall = true; relayRequest = relayTransport;
    relayEvent('call_started')`, client);
  await post('ai/wait', {});
  await vm.runInContext(`cfg = { aiMode: 'mcp' }; isInCall = true; relayRequest = relayTransport;
    relayLastSeq = 4; globalThis.testTrace = inputTrace('test');
    relayEvent('message', 'PRIVATE_BODY_DO_NOT_LOG', undefined, testTrace)`, client);
  now = 4_100;
  await post('ai/wait', {});
  now = 4_400;
  await post('ai/reply', { text: 'PRIVATE_REPLY_DO_NOT_LOG', reply_to: client.testTrace.id });
  now = 4_600;
  await vm.runInContext(`speak = (text, action, receivedAt, trace) => {
    globalThis.spokenTrace = trace; isInCall = false;
  }; pollRelay()`, client);
  assert.equal(client.spokenTrace.id, client.testTrace.id);
  assert.ok(clientLogs.some(line => /ai_pickup_ms=100 ai_roundtrip_ms=300 reply_queue_ms=200 outside_relay_ms=0/.test(line)));
  assert.ok(clientLogs.some(line => /request_ms=600/.test(line)));
  assert.ok(![...serverLogs, ...clientLogs].some(line => /PRIVATE_BODY|PRIVATE_REPLY/.test(line)));
  vm.runInContext(`const subtitleTrace = inputTrace('elevenlabs_realtime');
    setSubtitle('。', 'stt_partial', subtitleTrace);
    setSubtitle('PRIVATE_SUBTITLE_DO_NOT_LOG', 'stt_partial', subtitleTrace);
    setSubtitle('');`, client);
  assert.ok(clientLogs.some(line => line.includes('subtitle_changed') && line.includes('source=stt_partial shape=period_only chars=1')));
  assert.ok(clientLogs.some(line => line.includes('subtitle_changed') && line.includes('source=clear shape=empty')));
  assert.ok(!clientLogs.some(line => line.includes('PRIVATE_SUBTITLE_DO_NOT_LOG')));

  // Combined MCP tool delivers the reply to the app, then waits for the next message.
  const combinedRoom = new CallRoom({}, {});
  const combinedEnv = {
    RELAY_SECRET: 'test-secret',
    ROOM: { idFromName: () => 'main', get: () => ({ fetch: (url, init) => combinedRoom.fetch(new Request(url, init)) }) },
  };
  const combinedPost = async (op, body) => (await combinedRoom.fetch(new Request(`https://room/${op}`, {
    method: 'POST', body: JSON.stringify(body),
  }))).json();
  await combinedPost('app/event', { type: 'call_started' });
  await combinedPost('ai/wait', {}); // call_started
  const firstCombinedWait = combinedPost('ai/wait', { timeout_seconds: 5 });
  await new Promise(resolve => setImmediate(resolve));
  await combinedPost('app/event', { type: 'message', text: 'first', trace_id: 'combined-first' });
  await firstCombinedWait;
  const appPoll = combinedRoom.fetch(new Request('https://room/app/replies?after=0&wait=10'));
  const combinedCall = worker.fetch(new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'call_reply_and_wait', arguments: { text: 'reply', reply_to: 'combined-first', timeout_seconds: 5 } },
    }),
  }), combinedEnv);
  for (let i = 0; i < 20 && !combinedRoom.aiWaiters.size; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const earlyCombinedResult = await Promise.race([
    combinedCall.then(response => response.clone().text()),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 100)),
  ]);
  assert.equal(combinedRoom.aiWaiters.size, 1, earlyCombinedResult);
  const dispatched = await (await appPoll).json();
  assert.equal(dispatched.replies[0].text, 'reply');
  now = 5_000;
  await combinedPost('app/event', { type: 'message', text: 'second', trace_id: 'combined-next' });
  const combinedResult = await (await combinedCall).json();
  assert.match(combinedResult.result.content.map(c => c.text || '').join('\n'), /combined-next/);

  // A screenshot round may auto-submit without speech; MCP receives the image as the only content.
  const imageOnlyRoom = new CallRoom({}, {});
  const imageOnlyEnv = {
    RELAY_SECRET: 'test-secret',
    ROOM: { idFromName: () => 'main', get: () => ({ fetch: (url, init) => imageOnlyRoom.fetch(new Request(url, init)) }) },
  };
  const imageOnlyPost = (op, body) => imageOnlyRoom.fetch(new Request(`https://room/${op}`, {
    method: 'POST', body: JSON.stringify(body),
  }));
  await imageOnlyPost('app/event', { type: 'call_started' });
  await imageOnlyPost('ai/wait', {}); // consume call_started
  const emptyMessage = await imageOnlyPost('app/event', { type: 'message', text: '', trace_id: 'empty-message' });
  assert.equal(emptyMessage.status, 400);
  assert.equal(imageOnlyRoom.inbox.length, 0);
  const pureImage = await imageOnlyPost('app/event', {
    type: 'message', text: '', image: 'AA==', image_source: 'screen', image_fingerprints: [imageHash('AA==')], trace_id: 'image-only',
  });
  assert.equal(pureImage.status, 200);
  const pureImageAccepted = await pureImage.json();
  assert.equal(pureImageAccepted.timing.image_count, 1);
  assert.deepEqual(pureImageAccepted.timing.client_image_fingerprints, [imageHash('AA==')]);
  const imageWait = await worker.fetch(new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'call_wait_message', arguments: {} },
    }),
  }), imageOnlyEnv);
  const imageWaitResult = await imageWait.json();
  assert.deepEqual(imageWaitResult.result.content, [
    { type: 'image', data: 'AA==', mimeType: 'image/jpeg' },
  ]);
  const imageOnlyPendingData = await (await imageOnlyRoom.fetch(new Request('https://room/app/replies?after=0&wait=0'))).json();
  const imageOnlyTiming = imageOnlyPendingData.pending_traces.find(item => item.trace_id === 'image-only').timing;
  assert.deepEqual(imageOnlyTiming.mcp_image_fingerprints, [imageHash('AA==')]);
  assert.ok(serverLogs.some(line => line.includes('mcp_result_images') && line.includes('image-only') && line.includes('"image_blocks":1') && line.includes('"client_mcp_result_fingerprint_match":true')));
  const largerImage = 'A'.repeat(800_000);
  const highResolution = await imageOnlyPost('app/event', {
    type: 'message', text: '', image: largerImage, image_source: 'screen', trace_id: 'larger-image',
  });
  assert.equal(highResolution.status, 200);
  assert.equal(imageOnlyRoom.inbox.at(-1).image, largerImage);
  await imageOnlyPost('ai/wait', {});
  const batchImages = [
    { image: 'AQ==', image_source: 'camera' },
    { image: 'Ag==', image_source: 'screen' },
  ];
  const earlierImage = await imageOnlyPost('app/event', {
    type: 'message', text: 'earlier', image: 'Aw==', trace_id: 'earlier-image',
  });
  assert.equal(earlierImage.status, 200);
  const imageBatch = await imageOnlyPost('app/event', {
    type: 'message', text: '请看一下我发送的画面。', images: batchImages,
    image_fingerprints: batchImages.map(frame => imageHash(frame.image)), trace_id: 'image-batch',
  });
  assert.equal(imageBatch.status, 200);
  assert.deepEqual((await imageBatch.clone().json()).timing.client_image_fingerprints, batchImages.map(frame => imageHash(frame.image)));
  assert.deepEqual(imageOnlyRoom.inbox.at(-1).images, batchImages);
  const batchWait = await worker.fetch(new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'call_wait_message', arguments: {} },
    }),
  }), imageOnlyEnv);
  const batchContent = (await batchWait.json()).result.content;
  assert.deepEqual(batchContent.filter(item => item.type === 'image').map(item => item.data), ['AQ==', 'Ag==']);
  assert.match(batchContent.map(item => item.text || '').join('\n'), /按拍攝順序|拍摄顺序/);
  assert.equal(imageOnlyRoom.pendingMessages.find(item => item.trace_id === 'image-batch').timing.mcp_images_selected, 2);
  assert.deepEqual(imageOnlyRoom.pendingMessages.find(item => item.trace_id === 'image-batch').timing.mcp_image_fingerprints, ['AQ==', 'Ag=='].map(imageHash));
  assert.equal(imageOnlyRoom.pendingMessages.find(item => item.trace_id === 'earlier-image').timing.mcp_images_selected, 0);
  assert.ok(!serverLogs.some(line => /AA==|AQ==|Ag==|Aw==/.test(line)));
  for (const [image, expectedStatus] of [
    ['A'.repeat(4_000_004), 413], ['not base64!', 400], ['A', 400], ['====', 400], ['AA=A', 400],
  ]) {
    const invalidImage = await imageOnlyPost('app/event', { type: 'message', text: 'keep image attached', image });
    assert.equal(invalidImage.status, expectedStatus);
    assert.equal(imageOnlyRoom.inbox.length, 0);
  }
  const tooManyImages = await imageOnlyPost('app/event', {
    type: 'message', text: 'too many', images: Array.from({ length: 11 }, () => ({ image: 'AA==' })),
  });
  assert.equal(tooManyImages.status, 413);
  assert.equal(imageOnlyRoom.inbox.length, 0);

  // Multi-screenshot rounds wait after an empty final transcript and use the default question only after 5 seconds.
  vm.runInContext(`globalThis.visualTimerDelay = 0; globalThis.runVisualTimer = null; globalThis.visualPayload = null;
    isInCall = true;
    imageFingerprint = async () => 'a'.repeat(64);
    setTimeout = (callback, delay) => { globalThis.visualTimerDelay = delay; globalThis.runVisualTimer = callback; return 1; };
    clearTimeout = () => {};
    relayRequest = async (path, { body } = {}) => { globalThis.visualPayload = body; return { ok: true }; };
    beginVisualRound('batch-one', 'camera');
    stageVisualRound({roundId:'batch-one', source:'camera', image:'AQ=='});
    beginVisualRound('batch-two', 'screen');
    stageVisualRound({roundId:'batch-two', source:'screen', image:'Ag=='});
    globalThis.emptyFinalTrace = inputTrace('recording');
    markVisualSpeechStarted(emptyFinalTrace);
    finishVisualRoundWithoutText(emptyFinalTrace);`, client);
  assert.equal(vm.runInContext('visualRound.imageCount', client), 2);
  assert.equal(vm.runInContext('visualTimerDelay', client), 5000);
  assert.equal(client.visualPayload, null);
  vm.runInContext('runVisualTimer()', client);
  for (let i = 0; i < 50 && !client.visualPayload; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(client.visualPayload, clientLogs.slice(-12).join('\n'));
  assert.equal(client.visualPayload.text, '请看一下我发送的画面。');
  assert.deepEqual(Array.from(client.visualPayload.images, frame => frame.image), ['AQ==', 'Ag==']);
  assert.deepEqual(Array.from(client.visualPayload.images, frame => frame.image_source), ['camera', 'screen']);
  vm.runInContext(`clearVisualRound(); globalThis.visualPayload = null;
    beginVisualRound('speech-batch', 'camera');
    stageVisualRound({roundId:'speech-batch', source:'camera', image:'Aw=='});
    globalThis.speechFinalTrace = inputTrace('recording');`, client);
  await vm.runInContext(`handleUserInput('說明一下這張圖', speechFinalTrace)`, client);
  assert.equal(client.visualPayload.text, '說明一下這張圖');
  assert.equal(client.visualPayload.images.length, 1);

  console.log('Latency checks passed');
} finally {
  Date.now = originalNow;
  console.info = originalInfo;
}
