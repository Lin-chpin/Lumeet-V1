// 視訊通話 MCP 橋接：App 把使用者說的話放進來，AI 透過 MCP 取走並回覆
import WEB from './web-assets.js';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_AI_WAIT = 50;
const MAX_APP_WAIT = 25;
const AI_ONLINE_TTL_MS = 90_000;
const KEEP = 100;
const MAX_IMAGE_CHARS = 4_000_000; // Base64 JPEG 最多 3MB，與手機端一致。
const MAX_VISUAL_IMAGES = 10;

const INSTRUCTIONS = `這是視訊通話橋接。對方在手機 App 上跟你視訊，你回覆的文字會用對方設定的聲音和角色畫面說出來。
通話流程：
1. 呼叫 call_wait_message 等對方說話。
2. 收到對方的話後，用 call_reply_and_wait 回覆：口語、1 到 3 句短句，不要列點、表情符號或括號動作。想做的表情動作寫在 action（例如「微笑看著鏡頭」）。這個工具會先立刻把回覆送到手機，再在同一個 MCP 呼叫裡等待下一條消息；手機會同時播放回覆。
3. call_reply_and_wait 返回新消息後，直接繼續回覆；若它返回「暫時沒說話」，再呼叫 call_wait_message 等待。收到「通話結束」就停止。
回覆消息時，必須把消息編號填入 call_reply_and_wait 的 reply_to，讓回覆只進入所屬通話與回合；同批多則補充合併回答，reply_to 填最後一則消息編號，不逐條回答。不要把編號念出來。call_reply 保留給只需單獨發送、不接著等待的情況。可選 speech_text 只供 ElevenLabs 語音表演，text 保留正常正文；不需要表演時省略。
收到附圖時，這是對方主動發送的攝像頭畫面或共享屏幕截圖；同一消息可能包含多張，按拍攝順序排列。每張只代表那一刻，不是連續畫面；結合消息回應，不要過度解讀模糊細節。`;

const TOOLS = [
  {
    name: 'call_wait_message',
    description: '等待視訊通話中的消息（最多等 50 秒）。回傳對方說的內容、手動發送的攝像頭/屏幕畫面（每則最多 10 張）或通話開始／結束事件。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_AI_WAIT, description: '最多等幾秒，預設 45' },
      },
    },
  },
  {
    name: 'call_reply',
    description: '在視訊通話中說話。text 會轉成語音並讓角色對嘴說出。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要說的話，口語短句' },
        speech_text: { type: 'string', description: '選填，僅供 ElevenLabs 的語音表演文本；字幕仍使用 text' },
        action: { type: 'string', description: '表情或動作描述（選填），例如「微笑看著鏡頭」' },
        reply_to: { type: 'string', description: '本次回覆的消息編號，填 call_wait_message 返回的編號；不朗讀' },
      },
      required: ['text'],
    },
  },
  {
    name: 'call_reply_and_wait',
    description: '先把回覆送到手機，然後在同一個 MCP 呼叫中等待下一條消息（最多 50 秒）。手機會同時播放語音；收到新消息後一起返回，減少下一輪等待工具啟動的空檔。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要說的話，口語短句' },
        speech_text: { type: 'string', description: '選填，僅供 ElevenLabs 的語音表演文本；字幕仍使用 text' },
        action: { type: 'string', description: '表情或動作描述（選填），例如「微笑看著鏡頭」' },
        reply_to: { type: 'string', description: '本次回覆的消息編號，填 call_wait_message 返回的編號；不朗讀' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_AI_WAIT, description: '回覆送出後等待下一條消息的秒數，預設 45' },
      },
      required: ['text'],
    },
  },
  {
    name: 'call_remember_frame',
    description: '把對方最近單獨發送的攝像頭照片存成長期記憶（需要橋接器有綁定 R2）。共享屏幕截圖不會存入長期記憶。',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '為什麼想記住這一刻（選填）' },
      },
    },
  },
  {
    name: 'call_status',
    description: '查看視訊通話狀態：App 是否在線、MCP 最近是否有 AI 活動、是否通話中、有幾則未讀。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Durable Object：保存訊息佇列與等待者 ───────────────────

// 台灣時間的日期與時間，用來當 R2 檔名
function stamp(ms) {
  const d = new Date(ms + 8 * 3600_000).toISOString();
  return { day: d.slice(0, 10), time: d.slice(11, 19).replace(/:/g, '') };
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function imageFingerprint(image) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function traceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function traceLog(event, id, fields = {}) {
  console.info('CallLatency', JSON.stringify({ event, trace_id: id, at: Date.now(), ...fields }));
}

function latestVisualEvent(events) {
  return events.findLast(event => event.images?.length || event.image);
}

export class CallRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.lastFrame = null;
    this.inbox = [];
    this.outbox = [];
    this.seq = 0;
    this.inCall = false;
    this.appSeenAt = 0;
    this.aiSeenAt = 0;
    this.aiWaiters = new Set();
    this.appWaiters = new Set();
    this.pendingMessages = [];
    this.callId = null;
    this.sessionId = null;
    this.scopedCall = false;
    this.closedCalls = new Set();
    this.acceptedEvents = new Map();
    this.completedReplies = new Map();
    this.frameGeneration = 0;
  }

  waitFor(set, ms) {
    return new Promise(resolve => {
      const w = {};
      const timer = setTimeout(() => { set.delete(w); resolve(false); }, ms);
      w.wake = () => { clearTimeout(timer); set.delete(w); resolve(true); };
      set.add(w);
    });
  }

  wakeAll(set) {
    for (const w of [...set]) w.wake();
  }

  aiOnline() {
    return this.aiWaiters.size > 0 || Date.now() - this.aiSeenAt < AI_ONLINE_TTL_MS;
  }

  async fetch(request) {
    const receivedAt = Date.now();
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (op.startsWith('app/')) this.appSeenAt = Date.now();
    if (['ai/wait', 'ai/reply', 'ai/remember'].includes(op)) this.aiSeenAt = Date.now();

    switch (op) {
      case 'app/event': {
        const type = ['message', 'call_started', 'call_ended'].includes(body.type) ? body.type : null;
        if (!type) return Response.json({ error: 'type 無效' }, { status: 400 });
        const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
        const callId = traceId(body.call_id);
        const sessionId = traceId(body.session_id);
        if ((body.call_id != null && !callId) || (body.session_id != null && !sessionId) ||
            (body.request_id != null && !traceId(body.request_id)) || (!!callId !== !!sessionId)) {
          return Response.json({ error: '通話或回合編號無效' }, { status: 400 });
        }
        const id = traceId(body.request_id) || traceId(body.trace_id) || crypto.randomUUID();
        const eventKey = `${callId || 'legacy'}:${id}`;
        if (type === 'call_ended' && callId) {
          this.closedCalls.add(callId);
          if (this.closedCalls.size > KEEP) this.closedCalls.delete(this.closedCalls.values().next().value);
          if (callId === this.callId && sessionId === this.sessionId && !this.inCall) return Response.json({ ok: true, duplicate: true, last_seq: this.seq });
        }
        if (type === 'call_started') {
          if (callId && this.closedCalls.has(callId)) return Response.json({ error: '通話已結束' }, { status: 409 });
          if (callId && callId === this.callId && sessionId === this.sessionId) {
            return Response.json({ ok: true, duplicate: true, last_seq: this.seq });
          }
          if (this.callId) this.closedCalls.add(this.callId);
          if (this.closedCalls.size > KEEP) this.closedCalls.delete(this.closedCalls.values().next().value);
          this.callId = callId || crypto.randomUUID();
          this.sessionId = sessionId;
          this.scopedCall = !!callId;
          this.inCall = true;
          this.inbox = []; this.pendingMessages = []; this.outbox = [];
          this.lastFrame = null;
          this.frameGeneration++;
        } else if (this.scopedCall && (callId !== this.callId || sessionId !== this.sessionId || !this.inCall)) {
          return Response.json({ error: '過期通話' }, { status: 409 });
        }
        const existing = this.acceptedEvents.get(eventKey);
        if (existing) return Response.json({ ok: true, duplicate: true, last_seq: this.seq, trace_id: id, timing: existing, ai_online: this.aiOnline() });
        if (type === 'call_ended') {
          this.inCall = false;
          this.closedCalls.add(this.callId);
          this.inbox = []; this.pendingMessages = []; this.outbox = [];
          this.lastFrame = null;
          this.frameGeneration++;
        }
        let images = [];
        if (type === 'message') {
          const submittedImages = body.images != null
            ? body.images
            : body.image != null ? [{ image: body.image, image_source: body.image_source }] : [];
          if (!Array.isArray(submittedImages)) return Response.json({ error: '圖片格式無效' }, { status: 400 });
          if (submittedImages.length > MAX_VISUAL_IMAGES) return Response.json({ error: `每則消息最多 ${MAX_VISUAL_IMAGES} 張圖片` }, { status: 413 });
          for (const frame of submittedImages) {
            const data = frame?.image;
            if (typeof data !== 'string' || !data) return Response.json({ error: '圖片格式無效' }, { status: 400 });
            if (data.length > MAX_IMAGE_CHARS) return Response.json({ error: '圖片超過 3MB，請降低圖片大小' }, { status: 413 });
            if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return Response.json({ error: '圖片格式無效' }, { status: 400 });
            images.push({ image: data, image_source: frame.image_source === 'screen' ? 'screen' : 'camera' });
          }
        }
        const image = images.at(-1)?.image || null;
        if (type === 'message' && !text.trim() && images.length === 0) return Response.json({ error: 'text 或有效圖片不可同時為空' }, { status: 400 });
        const imageSource = images.at(-1)?.image_source || (body.image_source === 'screen' ? 'screen' : 'camera');
        const acceptedCallId = this.callId;
        const clientFingerprints = Array.isArray(body.image_fingerprints) &&
          body.image_fingerprints.length === images.length &&
          body.image_fingerprints.every(fingerprint => typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint))
          ? body.image_fingerprints : [];
        const at = Date.now();
        const timing = {
          edge_received_at: Number(request.headers.get('X-Call-Received-At')) || receivedAt,
          relay_received_at: receivedAt,
          image_count: images.length,
          client_image_fingerprints: clientFingerprints,
        };
        const eventCallId = acceptedCallId;
        this.acceptedEvents.set(eventKey, timing);
        if (this.acceptedEvents.size > KEEP) this.acceptedEvents.delete(this.acceptedEvents.keys().next().value);
        traceLog('relay_message_received', id, { type, ai_waiting: this.aiWaiters.size, call_id: this.callId, image_count: images.length, image_chars: images.reduce((sum, frame) => sum + frame.image.length, 0), client_image_fingerprints: clientFingerprints.join(',') || 'none' });
        timing.enqueued_at = Date.now();
        this.inbox.push({ type, text, image, images, image_source: imageSource, at, trace_id: id, request_id: id, call_id: this.callId, session_id: this.sessionId, timing });
        if (this.inbox.length > KEEP) this.inbox = this.inbox.slice(-KEEP);
        this.wakeAll(this.aiWaiters);
        if (images.length) this.frameGeneration++;
        const frameGeneration = this.frameGeneration;
        // 攝像頭照片沿用既有的可選 R2 視覺快取；屏幕截圖只留在待取消息裡
        if (imageSource === 'screen') this.lastFrame = null;
        if (image && imageSource === 'camera' && this.env.VISION) {
          const { day, time } = stamp(at);
          const key = `vision-cache/${day}/${time}-${at % 1000}.jpg`;
          try {
            await this.env.VISION.put(key, b64ToBytes(image), {
              httpMetadata: { contentType: 'image/jpeg' },
              customMetadata: { said: encodeURIComponent(text.slice(0, 500)) },
            });
            if (eventCallId === this.callId && this.inCall && frameGeneration === this.frameGeneration) this.lastFrame = { key, text, at };
          } catch {}
        }
        if (eventCallId !== this.callId || (type === 'message' && !this.inCall)) return Response.json({ error: '過期通話' }, { status: 409 });
        return Response.json({ ok: true, last_seq: this.seq, trace_id: id, timing, ai_online: this.aiOnline() });
      }

      case 'app/replies': {
        const after = Number(url.searchParams.get('after')) || 0;
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_APP_WAIT);
        const requestedCall = url.searchParams.get('call_id');
        const pick = () => this.outbox.filter(r => r.seq > after && (!requestedCall || r.call_id === requestedCall));
        if (!pick().length && wait > 0) await this.waitFor(this.appWaiters, wait * 1000);
        const dispatchedAt = Date.now();
        const replies = pick().map(r => ({ ...r, traces: (r.traces || []).map(t => ({ ...t, timing: { ...t.timing, app_dispatched_at: dispatchedAt } })) }));
        for (const r of replies) traceLog('relay_reply_dispatched', r.trace_id, { seq: r.seq, queued_ms: dispatchedAt - r.at });
        const pending = [...this.inbox, ...this.pendingMessages].filter(e => e.type === 'message' || e.batch_id)
          .map(e => ({ trace_id: e.trace_id, timing: e.timing }));
        return Response.json({ replies, last_seq: this.seq, diagnostics_version: 3, call_id: this.callId, session_id: this.sessionId, pending_traces: pending, ai_online: this.aiOnline() });
      }

      case 'ai/wait': {
        const sec = Math.min(Math.max(Number(body.timeout_seconds) || 45, 1), MAX_AI_WAIT);
        if (!this.inbox.length) await this.waitFor(this.aiWaiters, sec * 1000);
        const events = this.inbox.splice(0);
        const deliveredAt = Date.now();
        const batchId = crypto.randomUUID();
        const visual = latestVisualEvent(events);
        for (const e of events) {
          e.timing.ai_wait_started_at = receivedAt;
          e.timing.ai_delivered_at = deliveredAt;
          e.timing.mcp_images_selected = e === visual ? e.timing.image_count : 0;
          e.timing.mcp_image_fingerprints = e === visual ? [...(e.timing.client_image_fingerprints || [])] : [];
          if (e.type === 'message' || (this.scopedCall && e.type === 'call_started')) this.pendingMessages.push({ trace_id: e.trace_id, call_id: e.call_id, session_id: e.session_id, timing: e.timing, batch_id: batchId });
          traceLog('ai_message_dispatched', e.trace_id, { call_id: e.call_id, queue_ms: deliveredAt - e.timing.enqueued_at, already_waiting: receivedAt <= e.timing.enqueued_at, image_count: e.timing.image_count, mcp_images_selected: e.timing.mcp_images_selected, selected_client_image_fingerprints: e.timing.mcp_image_fingerprints.join(',') || 'none' });
        }
        this.pendingMessages = this.pendingMessages.slice(-KEEP);
        if (!events.length) traceLog('ai_wait_timeout', null, { wait_ms: deliveredAt - receivedAt });
        return Response.json({ events, in_call: this.inCall });
      }

      case 'ai/reply': {
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
        if (!text) return Response.json({ error: 'text 不可空白' }, { status: 400 });
        const action = typeof body.action === 'string' ? body.action.slice(0, 200) : '';
        const requestedId = traceId(body.reply_to);
        if (body.reply_to != null && !requestedId) return Response.json({ error: 'reply_to 無效' }, { status: 400 });
        const completed = requestedId && this.completedReplies.get(requestedId);
        if (completed) return Response.json({ ok: true, duplicate: true, in_call: this.inCall });
        const target = requestedId ? this.pendingMessages.find(e => e.trace_id === requestedId) : null;
        // 新版通話不猜匿名 callback 的歸屬；舊通話的回覆不能借用新通話的 pending batch。
        if ((requestedId && !target) || (this.scopedCall && (!this.inCall || !target))) {
          traceLog('ai_reply_rejected', requestedId, { call_id: this.callId, reason: !this.inCall ? 'call_ended' : requestedId ? 'unknown_request' : 'missing_reply_to' });
          return Response.json({ error: '過期或未關聯的回覆，請帶回本輪 reply_to' }, { status: 409 });
        }
        // 舊連接器沒有 reply_to；只有一批待回覆消息時才自動關聯，避免把併發回覆配錯。
        const batchId = target?.batch_id || (!requestedId && new Set(this.pendingMessages.map(e => e.batch_id)).size === 1 ? this.pendingMessages[0].batch_id : null);
        const matched = this.pendingMessages.filter(e => e.batch_id === batchId);
        // 一個 batch 是共同交給 AI 的上下文；回答涵蓋同批較新的補充，歸到最後一個 request。
        const primaryId = matched.at(-1)?.trace_id || null;
        const match = target ? 'explicit_batch' : matched.length ? 'single_pending_batch' : 'unmatched';
        const traces = matched.map(e => ({ trace_id: e.trace_id, timing: { ...e.timing, reply_received_at: receivedAt } }));
        for (const e of matched) this.completedReplies.set(e.trace_id, true);
        while (this.completedReplies.size > KEEP) this.completedReplies.delete(this.completedReplies.keys().next().value);
        this.pendingMessages = this.pendingMessages.filter(e => e.batch_id !== batchId);
        this.seq += 1;
        const speechText = typeof body.speech_text === 'string' ? body.speech_text.trim().slice(0, 2000) : '';
        this.outbox.push({ seq: this.seq, text, action, speech_text: speechText || undefined, at: receivedAt, trace_id: primaryId, request_id: primaryId, call_id: this.callId, session_id: this.sessionId, trace_match: match, traces });
        traceLog('ai_reply_received', primaryId, { seq: this.seq, match, matched_messages: traces.length });
        if (this.outbox.length > KEEP) this.outbox = this.outbox.slice(-KEEP);
        this.wakeAll(this.appWaiters);
        return Response.json({ ok: true, in_call: this.inCall });
      }

      case 'ai/remember': {
        if (!this.env.VISION) return Response.json({ error: '橋接器沒有綁定 R2，無法存畫面' }, { status: 400 });
        if (!this.lastFrame) return Response.json({ error: '還沒有可以存的畫面' }, { status: 400 });
        const obj = await this.env.VISION.get(this.lastFrame.key);
        if (!obj) return Response.json({ error: '畫面已經從快取消失了' }, { status: 404 });
        const { day, time } = stamp(this.lastFrame.at);
        const base = `memories/${day}/${time}`;
        const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
        await this.env.VISION.put(`${base}.jpg`, await obj.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
        await this.env.VISION.put(`${base}.md`, `對方說：${this.lastFrame.text}\n\n${note}\n`, {
          httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        });
        return Response.json({ ok: true, key: `${base}.jpg` });
      }

      // 角色圖片：App 上傳後由這裡保管，Vivix 用公開網址來拿（網址帶隨機代碼，猜不到）
      case 'app/portrait': {
        const image = typeof body.image === 'string' && body.image.length <= 2_000_000
          && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
        if (!image) return Response.json({ error: '圖片無效或太大' }, { status: 400 });
        const token = crypto.randomUUID().replace(/-/g, '');
        await this.state.storage.put('portrait', { token, image });
        return Response.json({ ok: true, token });
      }

      case 'portrait': {
        const saved = await this.state.storage.get('portrait');
        if (!saved || saved.token !== url.searchParams.get('token')) {
          return new Response('not found', { status: 404 });
        }
        return new Response(b64ToBytes(saved.image), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
      }

      case 'ai/status':
        return Response.json({
          app_online: Date.now() - this.appSeenAt < 60_000,
          ai_online: this.aiOnline(),
          in_call: this.inCall,
          pending_messages: this.inbox.length,
        });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

// ─── MCP ────────────────────────────────────────────────

function room(env) {
  return env.ROOM.get(env.ROOM.idFromName('main'));
}

async function roomCall(env, op, body) {
  const res = await room(env).fetch(`https://room/${op}`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function textContent(text) {
  return [{ type: 'text', text }];
}

// 文字合併成一段；保留最後一則消息中的完整畫面批次
async function describeEvents({ events, in_call }) {
  if (!events.length) {
    return textContent(in_call
      ? '（對方暫時沒說話。請再呼叫 call_wait_message 繼續等。）'
      : '（目前沒有進行中的通話。可以再呼叫 call_wait_message 等對方打來。）');
  }
  const lastImageEvent = latestVisualEvent(events);
  const lastImages = lastImageEvent?.images?.length
    ? lastImageEvent.images
    : lastImageEvent?.image ? [{ image: lastImageEvent.image, image_source: lastImageEvent.image_source }] : [];
  const lines = events.flatMap(e => {
    if (e.type === 'call_started') return [e.call_id && e.session_id ? `［通話開始；消息編號 ${e.trace_id}；call_id ${e.call_id}；session_id ${e.session_id}］` : '［通話開始］'];
    if (e.type === 'call_ended') return ['［通話結束］'];
    if (!e.text?.trim()) return [];
    const label = lastImages.length > 1 ? `${lastImages.length} 張畫面` : (e.image_source === 'screen' ? '共享屏幕截圖' : '攝像頭畫面');
    return [`［消息編號 ${e.trace_id}］對方說：${e.text}${e === lastImageEvent ? `（附上${label}）` : ''}`];
  });
  const content = lines.length ? textContent(lines.join('\n')) : [];
  if (lastImages.length > 1) {
    content.push({ type: 'text', text: '以下畫面按拍攝順序排列：' });
    lastImages.forEach((frame, index) => {
      const label = frame.image_source === 'screen' ? '共享屏幕截圖' : '攝像頭畫面';
      content.push({ type: 'text', text: `第 ${index + 1} 張${label}：` });
      content.push({ type: 'image', data: frame.image, mimeType: 'image/jpeg' });
    });
  } else if (lastImages.length === 1) {
    const label = lastImages[0].image_source === 'screen' ? '共享屏幕截圖' : '攝像頭畫面';
    if (lines.length) content.push({ type: 'text', text: `${label}：` });
    content.push({ type: 'image', data: lastImages[0].image, mimeType: 'image/jpeg' });
  }
  if (lastImageEvent) {
    const resultImageBlocks = content.filter(block => block.type === 'image');
    const resultFingerprints = await Promise.all(resultImageBlocks.map(async block => {
      try { return await imageFingerprint(block.data); } catch { return null; }
    }));
    const clientFingerprints = lastImageEvent.timing?.client_image_fingerprints || [];
    const fingerprintMatch = !clientFingerprints.length ? 'client_unavailable' :
      resultFingerprints.some(fingerprint => !fingerprint) ? 'result_unavailable' :
        clientFingerprints.length === resultFingerprints.length &&
        resultFingerprints.every((fingerprint, index) => fingerprint === clientFingerprints[index]);
    traceLog('mcp_result_images', lastImageEvent.trace_id, {
      call_id: lastImageEvent.call_id,
      image_blocks: resultImageBlocks.length,
      client_image_fingerprints: clientFingerprints.join(',') || 'none',
      mcp_result_image_fingerprints: resultFingerprints.map(fingerprint => fingerprint || 'unavailable').join(',') || 'none',
      client_mcp_result_fingerprint_match: fingerprintMatch,
    });
  }
  return content;
}

async function callTool(name, args, env) {
  if (name === 'call_wait_message') return describeEvents(await roomCall(env, 'ai/wait', args));
  if (name === 'call_reply') {
    const r = await roomCall(env, 'ai/reply', args);
    return textContent(r.in_call ? '已送出，對方會聽到。' : '已送出，但目前不在通話中，對方可能聽不到。');
  }
  if (name === 'call_reply_and_wait') {
    const { text, action, reply_to, speech_text } = args;
    const sent = await roomCall(env, 'ai/reply', { text, action, reply_to, speech_text });
    const next = await roomCall(env, 'ai/wait', { timeout_seconds: args.timeout_seconds });
    const status = sent.in_call ? '已送出，對方會聽到。' : '已送出，但目前不在通話中，對方可能聽不到。';
    return [...textContent(status), ...await describeEvents(next)];
  }
  if (name === 'call_remember_frame') {
    const r = await roomCall(env, 'ai/remember', args);
    return textContent(`記住了：${r.key}`);
  }
  if (name === 'call_status') return textContent(JSON.stringify(await roomCall(env, 'ai/status')));
  throw new Error(`未知工具: ${name}`);
}

async function handleRpc(msg, env) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        serverInfo: { name: 'ai-video-call-relay', version: '0.2.0' },
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        return ok({ content: await callTool(params?.name, params?.arguments || {}, env) });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `錯誤：${e.message}` }], isError: true });
      }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]).filter(m => m && m.method && 'id' in m);
  if (!requests.length) return new Response(null, { status: 202 });
  const results = await Promise.all(requests.map(m => handleRpc(m, env)));
  return Response.json(batch ? results : results[0]);
}

// ─── 入口 ───────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Relay-Secret, Platform',
  'Access-Control-Expose-Headers': 'X-Trace-Id',
};

function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default {
  async fetch(request, env) {
    const receivedAt = Date.now();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // 網頁版頁面（不含任何密碼，Key 都存在使用者自己的瀏覽器）
    if (request.method === 'GET') {
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      if (WEB[file]) {
        if (file.endsWith('.png')) {
          const bytes = Uint8Array.from(atob(WEB[file].slice('base64:'.length)), c => c.charCodeAt(0));
          return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
        }
        const type = file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.webmanifest')
            ? 'application/manifest+json; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8';
        return new Response(WEB[file], { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
      }
    }

    // 角色圖片公開網址（Vivix 抓圖不能帶密碼，所以不驗證；靠隨機代碼保護）
    if (request.method === 'GET' && parts[0] === 'portrait' && parts[1]) {
      const token = parts[1].replace(/\.jpg$/, '');
      return room(env).fetch(`https://room/portrait?token=${encodeURIComponent(token)}`);
    }

    // 網頁版用：Vivix 不允許網頁直接呼叫，由這裡轉送。Authorization 是 Vivix Key，所以橋接密碼放 X-Relay-Secret
    if (parts[0] === 'vivix') {
      const relaySecret = request.headers.get('X-Relay-Secret') || '';
      if (!env.RELAY_SECRET || !relaySecret || !(await safeEqual(relaySecret, env.RELAY_SECRET))) {
        return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }
      const rest = parts.slice(1).join('/');
      if (!rest.startsWith('v1/realtime-avatar/')) return withCors(Response.json({ error: 'not found' }, { status: 404 }));
      const res = await fetch(`https://api.vivix.ai/${rest}${url.search}`, {
        method: request.method,
        headers: {
          'Authorization': request.headers.get('Authorization') || '',
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
        },
        body: request.method === 'POST' ? request.body : undefined,
      });
      return withCors(res);
    }

    // 網頁版用：MOSS 語音合成也不允許網頁直接呼叫，同樣由這裡轉送
    if (parts[0] === 'moss' || parts[0] === 'moss-audio') {
      const relaySecret = request.headers.get('X-Relay-Secret') || '';
      if (!env.RELAY_SECRET || !relaySecret || !(await safeEqual(relaySecret, env.RELAY_SECRET))) {
        return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }
      if (parts[0] === 'moss') {
        if (parts.slice(1).join('/') !== 'v1/audio/speech' || request.method !== 'POST') {
          return withCors(Response.json({ error: 'not found' }, { status: 404 }));
        }
        const res = await fetch('https://api.mosi.cn/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': request.headers.get('Authorization') || '',
            'Content-Type': 'application/json',
            'Platform': 'moss-platform',
          },
          body: request.body,
        });
        return withCors(res);
      }
      // 下載 MOSS 產生的音檔（只接受 https 網址）
      const target = url.searchParams.get('u') || '';
      if (!/^https:\/\//.test(target)) return withCors(Response.json({ error: 'bad url' }, { status: 400 }));
      const res = await fetch(target);
      return withCors(new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg' } }));
    }

    // claude.ai 自訂連接器無法帶 header，所以也接受 /mcp/<secret>
    let secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (parts[0] === 'mcp' && parts[1]) secret = parts[1];

    if (!env.RELAY_SECRET || !secret || !(await safeEqual(secret, env.RELAY_SECRET))) {
      return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    }

    if (parts[0] === 'mcp') return handleMcp(request, env);

    if (parts[0] === 'app' && parts[1]) {
      const res = await room(env).fetch(`https://room/app/${parts[1]}${url.search}`, {
        method: request.method,
        headers: { 'X-Call-Received-At': String(receivedAt) },
        body: request.method === 'POST' ? request.body : undefined,
      });
      if (parts[1] === 'portrait' && res.ok) {
        const { token } = await res.json();
        return withCors(Response.json({ ok: true, url: `${url.origin}/portrait/${token}.jpg` }));
      }
      return withCors(res);
    }

    return withCors(Response.json({ error: 'not found' }, { status: 404 }));
  },
};
