// video.js — AI 通話前端管線
// 流程：使用者語音 → STT → LLM 或 MCP 橋接；可選 Vivix 角色影像或本機語音播放

const VIVIX_BASE = 'https://api.vivix.ai/v1';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
// MOSS（OpenMOSS 的語音合成）：中國大陸可直連，海外版帳號也用同一個網址
const MOSS_BASE = 'https://api.mosi.cn/v1';
const DEFAULT_MOSS_MODEL = 'moss-tts-1.5-flash';
// MiniMax 語音合成：中國大陸版和國際版是兩個帳號體系，Key 不通用，網址也不同
const MINIMAX_BASE = { cn: 'https://api.minimaxi.com/v1', intl: 'https://api.minimax.io/v1' };
const DEFAULT_MINIMAX_MODEL = 'speech-2.8-turbo';
const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_ELEVEN_STT_MODEL = 'scribe_v2_realtime';
const STT_VOCABULARY = ['琳琳', '臭面包', 'Lumeet', 'MCP', 'Harness', 'LangGraph', 'ElevenLabs', 'Claude', 'Codex'];
const MAX_VISUAL_IMAGE_CHARS = 4_000_000;
// 只填 Key 沒填網址時用 Groq（輸入框的灰字範例很容易被當成已經填了）
const DEFAULT_STT_BASE = 'https://api.groq.com/openai/v1';
// multilingual_v2 會自己猜語言，中文常被念歪（你→奶）；v2.5 可以用 language_code 鎖定中文
const DEFAULT_TTS_MODEL = 'eleven_turbo_v2_5';
// Vivix 內建聲音（Qwen Audio），中國大陸也能用
const DEFAULT_VIVIX_VOICE = 'longanhuan_v3.6';

// 語音合成：設定頁選哪家就用哪家；舊設定沒有這個欄位時，看填了哪家的 Key
function ttsProvider(s = cfg) {
  if (s.ttsProvider) return s.ttsProvider;
  if (s.mossKey) return 'moss';
  if (s.minimaxKey) return 'minimax';
  if (s.elKey) return 'elevenlabs';
  return 'vivix';
}
function useMoss() {
  return ttsProvider() === 'moss' && !!cfg.mossKey;
}
function useMinimax() {
  return ttsProvider() === 'minimax' && !!cfg.minimaxKey;
}
function minimaxRegion(s = cfg) {
  return s.minimaxRegion === 'intl' ? 'intl' : 'cn';
}
function useElevenLabs() {
  return ttsProvider() === 'elevenlabs' && !!cfg.elKey;
}
const TTS_LANG_LOCKABLE = ['eleven_turbo_v2_5', 'eleven_flash_v2_5'];
const DEFAULT_TTS_FIX = ''; // 純淨版不預設；念歪的字由使用者自己在設定加

// 「你=尼」一行一組，只改送去念的文字
function applyTtsFix(text) {
  for (const line of (cfg.elFix || '').split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from) text = text.split(from).join(to);
  }
  return text;
}
const SHORT_REPLY_HINT = '現在是通話，請用自然口語回覆，1 到 3 句短句，不要列點、表情符號或括號動作。';

// ─── HTTP（App 內走原生請求，避開 CORS） ─────────────────

const cap = window.Capacitor;
const isNativeApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.nativePromise);
const isAndroidApp = !!(isNativeApp && cap.getPlatform && cap.getPlatform() === 'android');
// 網頁版（iPhone 用）：按住說話、精簡按鈕
const compactUi = !isNativeApp;

// Vivix 不允許網頁直接呼叫（沒有 CORS），網頁版改由橋接器轉送
function vivixBase() {
  return !isNativeApp && relayBase() ? relayUrl('/vivix/v1') : VIVIX_BASE;
}

function vivixHeaders() {
  const h = { 'Authorization': `Bearer ${cfg.vivixKey}`, 'Content-Type': 'application/json' };
  if (!isNativeApp && relayBase()) h['X-Relay-Secret'] = cfg.relaySecret;
  return h;
}

function parseMaybeJson(data) {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return data; }
}

function errText(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return (s || '').slice(0, 300);
}

// 常見錯誤翻成看得懂的中文：沒錢就說沒錢，Key 錯就說 Key 錯；看不出原因就回傳空字串
const VIVIX_CODE = {
  10001: 'key', 10003: 'key', 10004: 'money', 10005: 'money', 10008: 'busy', 10009: 'perm',
  20016: 'image', 30006: 'concurrency', 30008: 'server',
};

function errCode(data) {
  const c = data?.code ?? data?.error?.code;
  return Number.isFinite(Number(c)) ? Number(c) : null;
}

function errKind(status, data) {
  const s = errText(data).toLowerCase();
  // 橋接（mcp-relay）自己擋下來的：密碼不對，不是 Vivix／MOSS／MiniMax 的 Key 問題
  if (status === 401 && data?.error === 'Unauthorized') return 'relay';
  const vivix = VIVIX_CODE[errCode(data)];
  if (vivix) return vivix;
  if (status === 402 || /insufficient.?(balance|fund|credit|quota)|not enough (credit|balance)|balance|quota_exceeded|exceeded your (current )?quota|余额|餘額|欠费|欠費|arrear|payment required|credits?/.test(s)) return 'money';
  if (/unusual activity|detected_unusual/.test(s)) return 'vpn';
  if (/missing_permission/.test(s)) return 'perm';
  if (status === 401 || /invalid.{0,10}(api.?key|token)|incorrect api key|auth(entication)? failed|unauthorized|invalid_api_key/.test(s)) return 'key';
  if (status === 403) return 'perm';
  if (status === 429) return 'busy';
  if (status >= 500) return 'server';
  return '';
}

function friendlyHint(service, status, data) {
  const raw = errText(data).slice(0, 120);
  const tail = raw ? `（原始訊息：${raw}）` : '';
  switch (errKind(status, data)) {
    case 'money': return `💸 ${service} 沒錢了：餘額或額度用完，到 ${service} 後台儲值`;
    case 'vpn': return `🌐 ${service} 擋下了這次連線：免費方案透過 VPN／代理使用會被拒絕，要付費方案或換別家`;
    case 'perm': return `🚫 ${service} 這把 Key 權限不夠：到後台把${service === 'ElevenLabs' ? '「文字轉語音」和「音色」' : /ElevenLabs Scribe|語音辨識/.test(service) ? '「語音轉文字」' : '需要的'}權限打開${tail}`;
    case 'relay': return `🔐 橋接密碼不對：被你的 MCP 橋接擋下來了，不是 ${service} 的 Key 問題。檢查設定裡的「橋接網址」和「橋接密碼」是不是你自己部署印出來的那組`;
    case 'key': return `🔑 ${service} 的 Key 不對：重新複製貼上，前後不要有空格${tail}`;
    case 'busy': return `⏳ ${service} 請求太頻繁：等一下再試`;
    case 'image': return `🖼 ${service} 讀不到角色圖片：確認圖片網址用瀏覽器打得開`;
    case 'concurrency': return `👥 ${service} 同時開了太多通話：先把其他通話掛掉`;
    case 'server': return `🔧 ${service} 那邊的伺服器出問題，不是你的錯：稍後再試${tail}`;
    default: return '';
  }
}

// 網路層錯誤（根本沒收到回應）
function netHint(service, e) {
  const m = String(e?.message || e || '');
  if (/timeout|timed out/i.test(m)) return `🌐 連 ${service} 逾時：網路太慢或被擋，檢查網路或翻牆`;
  return `🌐 連不上 ${service}：網路或翻牆的問題（${m.slice(0, 80)}）`;
}

// 給呼叫失敗用：有對應的白話就用白話，否則附上狀態碼和原始訊息
function apiError(service, status, data) {
  const hint = friendlyHint(service, status, data);
  const err = new Error(hint || `${service} 出錯 (${status})：${errText(data).slice(0, 200)}`);
  err.hint = hint;
  err.status = status;
  return err;
}

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (isNativeApp) {
    const r = await cap.nativePromise('CapacitorHttp', 'request', {
      url, method, headers, data: payload, dataType: 'json',
      connectTimeout: 15000, readTimeout: timeoutMs,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: parseMaybeJson(r.data), traceId: traceIdOf(r.headers) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    return { ok: res.ok, status: res.status, data: parseMaybeJson(await res.text()), traceId: res.headers.get('x-trace-id') || '' };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('連線逾時：檢查網路或 VPN 後重試');
      timeoutError.hint = timeoutError.message;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Vivix 客服查問題要 X-Trace-Id，出錯時記進日誌
function traceIdOf(headers) {
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'x-trace-id') return String(v);
  }
  return '';
}

async function httpBase64(url, { method = 'POST', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (isNativeApp) {
    const r = await cap.nativePromise('CapacitorHttp', 'request', {
      url, method, headers, data: payload, dataType: 'json', responseType: 'arraybuffer',
      connectTimeout: 15000, readTimeout: 60000,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, data: await res.text() };
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { ok: true, status: res.status, data: btoa(bin) };
  } finally { clearTimeout(timeout); }
}

// ─── 設定管理 ───────────────────────────────────────────

const SETTINGS_KEY = 'ai-video-call-settings';
const CONSENT_KEY = 'ai-video-call-consent';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch { return {}; }
}

function showTtsProvider(p) {
  for (const k of ['vivix', 'elevenlabs', 'moss', 'minimax']) el(`tts-${k}`).classList.toggle('is-hidden', k !== p);
}

function showSttProvider(p) {
  const elevenLabs = p === 'elevenlabs';
  el('stt-openai').classList.toggle('is-hidden', p !== 'openai');
  el('stt-openai-presets').classList.toggle('is-hidden', elevenLabs);
  el('stt-elevenlabs-hint').classList.toggle('is-hidden', !elevenLabs);
  el('cfg-stt-key-label').textContent = elevenLabs
    ? 'API Key（留空可共用上方 ElevenLabs Key）'
    : 'API Key';
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function readFormSettings() {
  return {
    vivixKey:    el('cfg-vivix-key').value.trim(),
    elKey:       el('cfg-el-key').value.trim(),
    elVoice:     el('cfg-el-voice').value.trim(),
    elModel:     el('cfg-el-model').value,
    mossKey:     el('cfg-moss-key').value.trim(),
    mossVoice:   el('cfg-moss-voice').value.trim(),
    mossModel:   el('cfg-moss-model').value,
    minimaxKey:    el('cfg-minimax-key').value.trim(),
    minimaxVoice:  el('cfg-minimax-voice').value.trim(),
    minimaxModel:  el('cfg-minimax-model').value,
    minimaxRegion: el('cfg-minimax-region').value,
    ttsProvider: el('cfg-tts-provider').value,
    vivixVoice:  el('cfg-vivix-voice-custom').value.trim() || el('cfg-vivix-voice').value,
    vivixVoicePick: el('cfg-vivix-voice').value,
    vivixVoiceCustom: el('cfg-vivix-voice-custom').value.trim(),
    elFix:       el('cfg-el-fix').value,
    aiMode:      document.querySelector('input[name="ai-mode"]:checked')?.value || 'api',
    llmBase:     el('cfg-llm-base').value.trim(),
    llmKey:      el('cfg-llm-key').value.trim(),
    llmModel:    el('cfg-llm-model').value.trim(),
    relayUrl:    el('cfg-relay-url').value.trim(),
    relaySecret: el('cfg-relay-secret').value.trim(),
    sttBase:     el('cfg-stt-base').value.trim(),
    sttKey:      el('cfg-stt-key').value.trim(),
    sttModel:    el('cfg-stt-model').value.trim(),
    sttProvider: el('cfg-stt-provider').value,
    charName:    el('cfg-char-name').value.trim(),
    charPrompt:  el('cfg-char-prompt').value.trim(),
    charImg:     el('cfg-char-img').value.trim(),
    description: el('description').value.trim(),
  };
}

function fillForm(s) {
  el('cfg-vivix-key').value  = s.vivixKey  || '';
  el('cfg-el-key').value     = s.elKey     || '';
  el('cfg-el-voice').value   = s.elVoice   || '';
  el('cfg-el-model').value   = s.elModel   || DEFAULT_TTS_MODEL;
  el('cfg-moss-key').value   = s.mossKey   || '';
  el('cfg-moss-voice').value = s.mossVoice || '';
  el('cfg-moss-model').value = s.mossModel || DEFAULT_MOSS_MODEL;
  el('cfg-minimax-key').value    = s.minimaxKey   || '';
  el('cfg-minimax-voice').value  = s.minimaxVoice || '';
  el('cfg-minimax-model').value  = s.minimaxModel || DEFAULT_MINIMAX_MODEL;
  el('cfg-minimax-region').value = minimaxRegion(s);
  el('cfg-tts-provider').value = ttsProvider(s);
  showTtsProvider(ttsProvider(s));
  el('cfg-vivix-voice').value = s.vivixVoicePick || DEFAULT_VIVIX_VOICE;
  el('cfg-vivix-voice-custom').value = s.vivixVoiceCustom || '';
  el('cfg-el-fix').value     = s.elFix ?? DEFAULT_TTS_FIX;
  el('cfg-llm-base').value   = s.llmBase   || '';
  el('cfg-llm-key').value    = s.llmKey    || '';
  el('cfg-llm-model').value  = s.llmModel  || '';
  el('cfg-relay-url').value    = s.relayUrl    || '';
  el('cfg-relay-secret').value = s.relaySecret || '';
  el('cfg-stt-base').value     = s.sttBase     || '';
  el('cfg-stt-key').value      = s.sttKey      || '';
  el('cfg-stt-model').value    = s.sttModel    || '';
  el('cfg-stt-provider').value = s.sttProvider || 'openai';
  showSttProvider(el('cfg-stt-provider').value);
  const mode = s.aiMode === 'mcp' ? 'mcp' : 'api';
  document.querySelector(`input[name="ai-mode"][value="${mode}"]`).checked = true;
  showModeFields(mode);
  el('cfg-char-name').value  = s.charName  || '';
  el('cfg-char-prompt').value = s.charPrompt || '';
  el('cfg-char-img').value   = s.charImg   || '';
  el('description').value    = s.description || '';
}

function showModeFields(mode) {
  el('mode-api').classList.toggle('is-hidden', mode !== 'api');
  el('mode-mcp').classList.toggle('is-hidden', mode !== 'mcp');
}

function setPortrait(url) {
  if (url) el('portrait-preview').src = url;
}

// ─── DOM 工具 ────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function log(msg) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el('log').prepend(li);
}

let nativeCallStatus = null;
const CALL_STATUS_CODES = {
  '正在建立連線⋯': 'connecting', '等待中': 'waiting', '聆聽中': 'listening', '辨識中⋯': 'transcribing',
  '語音辨識重連中⋯': 'asr_reconnecting', '傳送中⋯': 'sending', '消息已排队，等待 MCP 接收': 'waiting_connector',
  '消息已送达桥接，等待 AI 接收⋯': 'waiting_pickup', 'AI 已收到消息，等待回覆⋯': 'waiting_reply',
  '思考中⋯': 'thinking', '語音合成中⋯': 'synthesizing', '說話中': 'playing', '已打斷': 'interrupted',
  '按住麥克風說話': 'ptt_ready', '說話中⋯放開送出': 'ptt_recording',
};
function setStatus(text) {
  const status = el('call-status');
  if (status.textContent !== text && (isInCall || callStarting || callEnding)) {
    const code = Object.hasOwn(CALL_STATUS_CODES, text) ? CALL_STATUS_CODES[text] : text ? 'other' : 'cleared';
    latencyLog('call_status_changed', `status=${code} mic=${!!vad} realtime_asr=${!!realtimeStt}`);
  }
  status.textContent = text;
  if (isAndroidApp && nativeScreenSharing && nativeCallStatus !== text) {
    nativeCallStatus = text;
    cap.nativePromise('ScreenCapture', 'setCallStatus', { status: text }).catch(() => {});
  }
}
function latencyLog(event, detail = '', trace) {
  const id = trace?.id;
  const request = diagnosticId(id) === 'na' ? '' : ` trace=${id} request=${id}`;
  const line = `CallLatency ${event} session=${trace?.sessionId || sessionTraceId} call=${trace?.callId || callTraceId} at_ms=${Date.now()} mono_ms=${Math.round(performance.now())}${request}${detail ? ` ${detail}` : ''}`;
  log(line);
  console.info(line);
  try { window.LumeetAudioDiagnostic?.appendLatency?.(line); } catch {}
}
function diagnosticId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : 'na';
}
async function imageFingerprint(image) {
  if (!globalThis.crypto?.subtle || typeof image !== 'string') return null;
  try {
    const bytes = new TextEncoder().encode(image);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
function fingerprintList(fingerprints) {
  return fingerprints?.length ? fingerprints.map(value => value || 'unavailable').join(',') : 'none';
}
function transcriptShape(text) {
  const value = (text || '').trim();
  if (!value) return 'empty';
  if (/^[.。]+$/.test(value)) return 'period_only';
  return /^[\p{P}\s]+$/u.test(value) ? 'punctuation_only' : 'text';
}

let subtitleDiagnosticKey = '';
function setSubtitle(text, source = text ? 'other' : 'clear', trace) {
  const sub = el('subtitle');
  const shape = transcriptShape(text);
  const key = text ? `${source}/${trace?.id || ''}/${shape}` : '';
  if (key !== subtitleDiagnosticKey) {
    subtitleDiagnosticKey = key;
    latencyLog('subtitle_changed', `source=${source} shape=${shape} chars=${text?.length || 0}`, trace);
  }
  if (!text) { sub.classList.add('hidden'); return; }
  sub.textContent = text;
  sub.classList.remove('hidden');
}

// ─── 狀態 ────────────────────────────────────────────────

let cfg = {};
let rtc = null;
let vivixWs = null;
let vivixSessionId = null;
let trtcInfo = null;
let selfStream = null;
let selfFacing = 'user';
let screenStream = null;
let nativeScreenSharing = false;
let nativeScreenStartedAt = 0;
let screenPreviewTimer = null;
let screenPreviewBusy = false;
let screenCaptureStarting = false;
let visualRound = null;
let visualRoundTimer = null;
let visualPreviewTimer = null;
const VISUAL_SILENCE_MS = 5000;
const VISUAL_PREVIEW_MS = 5000;
const MAX_VISUAL_IMAGES = 10;
const VISUAL_DEFAULT_QUESTION = '请看一下我发送的画面。';
let isMuted = false;
let camPaused = false;
let isInCall = false;
let timerInterval = null;
let callStartTime = 0;
let chatHistory = [];
let isProcessing = false;
let queuedVoiceInputs = [];
let realtimeFallbackQueue = [];
let realtimeFallbackGeneration = 0;
let aiSpeaking = false;
let aiSpeakingTimer = null;
let speakQueue = Promise.resolve();
let localAudio = null;
let dialoguePreconnection = null;
let activeDialogueConnection = null;
let activeMp3Player = null;
let callTraceId = crypto.randomUUID();
let sessionTraceId = crypto.randomUUID();
let callStarting = false;
let callEnding = false;
let callEpoch = 0;
let activeInputTrace = null;
let localSpeechActive = false;
let voiceTurn = null;
let voiceTurnTimer = null;
const pendingVoiceTranscriptions = new Set();
const pendingMcpMessages = new Map();
let currentSpeechTrace = null;
let pttTrace = null;
let vad = null;
let lastLevel = -1;
let relayLastSeq = 0;
let relayPolling = false;

function inputTrace(source) {
  return { id: crypto.randomUUID(), source, callId: callTraceId, sessionId: sessionTraceId, startedAt: performance.now(), lastVoiceAt: 0 };
}

function isCurrentTrace(trace) {
  return isInCall && !!trace && trace.callId === callTraceId && !trace.cancelled;
}

function cancelPendingReplies() {
  if (activeInputTrace) activeInputTrace.cancelled = true;
  for (const trace of pendingMcpMessages.values()) trace.cancelled = true;
}

function loadCallSession() {
  // 這是本機長期會話標識；官方 ChatGPT 會話仍由現有 MCP 連接器決定。
  const scope = JSON.stringify([cfg.aiMode, relayBase(), cfg.charName, cfg.charImg]);
  try {
    const saved = JSON.parse(localStorage.getItem('lumeet-call-session'));
    sessionTraceId = saved?.scope === scope && /^[A-Za-z0-9_-]{1,80}$/.test(saved.id) ? saved.id : crypto.randomUUID();
    localStorage.setItem('lumeet-call-session', JSON.stringify({ scope, id: sessionTraceId }));
  } catch { sessionTraceId = crypto.randomUUID(); }
}

function speechOnset(trace) {
  return trace.speechStartedAt ?? trace.startedAt;
}

function scheduleVoiceTurn() {
  clearTimeout(voiceTurnTimer);
  voiceTurnTimer = null;
  if (!voiceTurn || localSpeechActive || pendingVoiceTranscriptions.size) return;
  // ponytail: 本地1.8秒端點之外只留300ms收齊ASR尾段；語義端點確有需要時再替換。
  voiceTurnTimer = setTimeout(() => {
    voiceTurnTimer = null;
    if (localSpeechActive || pendingVoiceTranscriptions.size || !voiceTurn) return;
    const turn = voiceTurn;
    voiceTurn = null;
    if (!isCurrentTrace(turn.trace) || isMuted) return;
    const text = turn.segments.sort((a, b) => speechOnset(a.trace) - speechOnset(b.trace)).map(s => s.text).join('\n');
    turn.trace.latestSpeechOnset = speechOnset(turn.segments.at(-1).trace);
    turn.trace.lastVoiceAt = Math.max(...turn.segments.map(s => s.trace.lastVoiceAt || 0));
    latencyLog('voice_turn_ready', `segments=${turn.segments.length} chars=${text.length} shape=${transcriptShape(text)}`, turn.trace);
    void handleUserInput(text, turn.trace);
  }, 300);
}

function queueVoiceTranscript(text, trace) {
  if (!isCurrentTrace(trace) || isMuted || !text) return;
  voiceTurn ||= { trace, segments: [] };
  if (!voiceTurn.segments.some(s => s.trace.id === trace.id && s.text === text)) {
    voiceTurn.segments.push({ text, trace });
    latencyLog('voice_segment_queued', `turn=${voiceTurn.trace.id} pending_asr=${pendingVoiceTranscriptions.size} speaking=${localSpeechActive}`, trace);
  }
  scheduleVoiceTurn();
}

function transcriptReady(trace, text, path = trace.source) {
  latencyLog('stt_final', `source=${trace.source} path=${path} chars=${text.length} shape=${transcriptShape(text)} since_voice_ms=${trace.lastVoiceAt ? Math.round(performance.now() - trace.lastVoiceAt) : 'na'}`, trace);
}

function renderVisualRound() {
  const panel = el('visual-round-panel');
  const round = visualRound;
  panel.classList.toggle('is-hidden', !round || round.captureInProgress);
  if (!round) return;
  el('visual-round-preview').classList.toggle('is-hidden', !round.preview || round.captureInProgress);
  const image = el('visual-round-thumbnail');
  if (round.preview) image.src = `data:image/jpeg;base64,${round.preview}`;
  else image.removeAttribute('src');
  el('visual-round-status').textContent = round.status;
  el('btn-retry-visual').classList.toggle('is-hidden', !round.status.includes('失败') && !round.status.includes('重试'));
  const captureButton = el('btn-send-frame');
  captureButton.disabled = !round.sent && (
    round.captureInProgress || round.sending || round.imageCount >= MAX_VISUAL_IMAGES
  );
  el('send-frame-label').textContent = !round.sent && round.imageCount > 0
    ? round.imageCount >= MAX_VISUAL_IMAGES
      ? `已达 ${MAX_VISUAL_IMAGES} 张上限`
      : `继续截图 ${round.imageCount}/${MAX_VISUAL_IMAGES}`
    : '拍一张给他看';
}

function clearVisualRound() {
  clearTimeout(visualRoundTimer);
  visualRoundTimer = null;
  clearTimeout(visualPreviewTimer);
  visualPreviewTimer = null;
  const old = visualRound;
  if (old) latencyLog('visual_round_cleared', `round=${old.roundId} count=${old.imageCount} sent=${old.sent} sending=${old.sending}`);
  visualRound = null;
  renderVisualRound();
  if (old?.roundId && old.source === 'screen' && isAndroidApp) {
    cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: old.roundId, success: true }).catch(() => {});
  }
}

function beginVisualRound(roundId, source) {
  if (!visualRound || visualRound.sent || visualRound.sending) {
    clearVisualRound();
    visualRound = {
      roundId: null, source: source || 'camera', frames: [], imageCount: 0, preview: '',
      status: '正在截图', startedAt: performance.now(), speechTrace: null,
      captureInProgress: false, sending: false, sent: false, text: '', trace: null,
    };
  }
  const round = visualRound;
  if (round.imageCount >= MAX_VISUAL_IMAGES || round.captureInProgress) {
    round.status = round.imageCount >= MAX_VISUAL_IMAGES
      ? `一轮最多发送 ${MAX_VISUAL_IMAGES} 张画面`
      : '正在截图，请稍候';
    if (round.imageCount >= MAX_VISUAL_IMAGES && roundId && source === 'screen' && isAndroidApp) {
      cap.nativePromise('ScreenCapture', 'setVisualImageCount', {
        roundId, imageCount: round.imageCount, maxImages: MAX_VISUAL_IMAGES,
      }).catch(() => {});
    }
    renderVisualRound();
    return round;
  }
  round.roundId = roundId || crypto.randomUUID();
  round.source = source || 'camera';
  round.captureInProgress = true;
  latencyLog('visual_capture_started', `round=${round.roundId} source=${round.source} prior_images=${round.imageCount}`);
  round.status = round.imageCount ? `正在截图，已累计 ${round.imageCount}/${MAX_VISUAL_IMAGES} 张` : '正在截图';
  clearTimeout(visualRoundTimer);
  visualRoundTimer = null;
  renderVisualRound();
  return round;
}

function stageVisualRound(frame) {
  if (!frame?.image) return;
  let round = visualRound;
  if (!round || round.sent || round.sending) {
    round = beginVisualRound(frame.roundId, frame.source);
  } else if (round.roundId !== frame.roundId) {
    if (round.captureInProgress) return;
    round = beginVisualRound(frame.roundId, frame.source);
  }
  if (round.imageCount >= MAX_VISUAL_IMAGES) {
    latencyLog('visual_capture_discarded', `round=${round.roundId} reason=image_limit`);
    round.captureInProgress = false;
    round.status = `一轮最多发送 ${MAX_VISUAL_IMAGES} 张画面`;
    renderVisualRound();
    if (round.roundId && round.source === 'screen' && isAndroidApp) {
      cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: round.roundId, success: false }).catch(() => {});
    }
    return;
  }
  if (frame.image.length > MAX_VISUAL_IMAGE_CHARS) {
    latencyLog('visual_capture_discarded', `round=${round.roundId} reason=image_size image_chars=${frame.image.length}`);
    round.captureInProgress = false;
    round.status = round.imageCount
      ? `新增截图过大，已有 ${round.imageCount} 张画面仍可发送`
      : '截图过大，换个画面后重试';
    renderVisualRound();
    if (round.roundId && round.source === 'screen' && isAndroidApp) {
      cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: round.roundId, success: false }).catch(() => {});
    }
    if (round.text) void sendVisualRound(round.text, round.trace);
    else if (!round.speechTrace) scheduleVisualIdleSend(round);
    return;
  }
  round.captureInProgress = false;
  round.source = frame.source === 'screen' ? 'screen' : 'camera';
  round.frames.push({
    image: frame.image,
    source: round.source,
    roundId: frame.roundId || round.roundId,
    width: frame.width || 0,
    height: frame.height || 0,
    sourceWidth: frame.sourceWidth ?? null,
    sourceHeight: frame.sourceHeight ?? null,
    cropX: frame.cropX ?? null,
    cropY: frame.cropY ?? null,
    cropWidth: frame.cropWidth ?? null,
    cropHeight: frame.cropHeight ?? null,
    mirrored: frame.mirrored ?? null,
  });
  round.imageCount++;
  round.preview = frame.image;
  scheduleVisualPreviewExpiry(round);
  latencyLog('visual_frame_ready', `round=${round.roundId} count=${round.imageCount} source=${round.source} width=${frame.width || 0} height=${frame.height || 0} source_width=${frame.sourceWidth ?? 'unknown'} source_height=${frame.sourceHeight ?? 'unknown'} crop=${frame.cropX ?? 'unknown'},${frame.cropY ?? 'unknown'},${frame.cropWidth ?? 'unknown'},${frame.cropHeight ?? 'unknown'} mirrored=${frame.mirrored ?? 'unknown'} image_chars=${frame.image.length}`);
  if (round.roundId && round.source === 'screen' && isAndroidApp) {
    cap.nativePromise('ScreenCapture', 'setVisualImageCount', {
      roundId: round.roundId, imageCount: round.imageCount, maxImages: MAX_VISUAL_IMAGES,
    }).catch(() => {});
  }
  round.status = round.speechTrace
    ? `已累计 ${round.imageCount}/${MAX_VISUAL_IMAGES} 张，等待语音最终分句`
    : `已收集 ${round.imageCount}/${MAX_VISUAL_IMAGES} 张；继续截图或说话，5 秒静默后发送`;
  renderVisualRound();
  if (round.text) {
    void sendVisualRound(round.text, round.trace);
  } else if (!round.speechTrace) scheduleVisualIdleSend(round);
}

function scheduleVisualIdleSend(round) {
  clearTimeout(visualRoundTimer);
  visualRoundTimer = null;
  if (visualRound !== round || round.sent || round.sending || round.captureInProgress ||
      round.speechTrace || round.text || round.imageCount === 0) return;
  round.status = `已收集 ${round.imageCount}/${MAX_VISUAL_IMAGES} 张；${VISUAL_SILENCE_MS / 1000} 秒静默后发送默认问题`;
  latencyLog('visual_idle_armed', `round=${round.roundId} count=${round.imageCount} wait_ms=${VISUAL_SILENCE_MS}`);
  renderVisualRound();
  visualRoundTimer = setTimeout(() => {
    if (visualRound === round && !round.sent && !round.sending &&
        !round.captureInProgress && !round.speechTrace && round.imageCount > 0) {
      latencyLog('visual_idle_fired', `round=${round.roundId} count=${round.imageCount}`);
      void sendVisualRound(VISUAL_DEFAULT_QUESTION, inputTrace('visual_silence'));
    }
  }, VISUAL_SILENCE_MS);
}

function scheduleVisualPreviewExpiry(round) {
  clearTimeout(visualPreviewTimer);
  visualPreviewTimer = setTimeout(() => {
    visualPreviewTimer = null;
    if (visualRound !== round) return;
    round.preview = '';
    renderVisualRound();
  }, VISUAL_PREVIEW_MS);
}

function markVisualSpeechStarted(trace, source = 'local_speech') {
  const round = visualRound;
  if (!round || round.sent || round.sending || (trace.latestSpeechOnset ?? speechOnset(trace)) < round.startedAt) return;
  if (round.speechTrace !== trace || visualRoundTimer !== null) {
    latencyLog('visual_waiting_for_speech', `round=${round.roundId} trigger=${source} local_speech=${localSpeechActive} idle_cancelled=${visualRoundTimer !== null}`, trace);
  }
  round.speechTrace = trace;
  round.status = `已检测到语音，等待最终分句（${round.imageCount}/${MAX_VISUAL_IMAGES} 张）`;
  clearTimeout(visualRoundTimer);
  visualRoundTimer = null;
  renderVisualRound();
  if (round.roundId && round.source === 'screen' && isAndroidApp) {
    cap.nativePromise('ScreenCapture', 'markVisualSpeechStarted', { roundId: round.roundId }).catch(() => {});
  }
}

function finishVisualRoundWithoutText(trace) {
  const round = visualRound;
  if (!round || round.speechTrace !== trace || round.sent || round.sending) return false;
  latencyLog('visual_speech_released', `round=${round.roundId} reason=no_transcript count=${round.imageCount}`, trace);
  round.speechTrace = null;
  round.text = '';
  round.trace = trace;
  round.status = round.imageCount
    ? `未识别到文字；${VISUAL_SILENCE_MS / 1000} 秒静默后发送默认问题`
    : '未识别到文字，等待画面采集完成';
  if (!round.captureInProgress && round.imageCount > 0) scheduleVisualIdleSend(round);
  else renderVisualRound();
  return true;
}

function drainQueuedVoiceInput() {
  if (!isInCall) { queuedVoiceInputs = []; return; }
  if (isProcessing) return;
  queuedVoiceInputs = queuedVoiceInputs.filter(item => item.callId === callTraceId);
  const inputs = queuedVoiceInputs.splice(0);
  if (inputs.length) {
    const { trace } = inputs[0];
    trace.latestSpeechOnset = Math.max(...inputs.map(item => item.trace.latestSpeechOnset ?? speechOnset(item.trace)));
    Promise.resolve().then(() => handleUserInput(inputs.map(item => item.text).join('\n'), trace));
  }
}

async function sendVisualRound(text = '', trace = inputTrace('visual')) {
  if (!isCurrentTrace(trace)) return;
  const round = visualRound;
  if (!round || round.sent || round.sending || round.captureInProgress) return;
  // A newer voice turn can cancel playback while this upload still owns its screenshot round.
  const ownsRound = () => isInCall && trace.callId === callTraceId && visualRound === round;
  const messageText = text.trim();
  if (!messageText && trace.source !== 'visual_silence') return;
  const images = round.frames;
  if (!messageText && images.length === 0) return;
  const outgoingText = messageText || VISUAL_DEFAULT_QUESTION;
  clearTimeout(visualRoundTimer);
  visualRoundTimer = null;
  round.sending = true;
  round.text = outgoingText;
  round.trace = trace;
  round.status = `正在发送 ${images.length} 张画面`;
  latencyLog('visual_send_started', `round=${round.roundId} count=${images.length} source=${round.source} wait_ms=${Math.round(performance.now() - round.startedAt)}`, trace);
  renderVisualRound();
  if (round.roundId && round.source === 'screen' && isAndroidApp) {
    cap.nativePromise('ScreenCapture', 'markVisualSending', { roundId: round.roundId }).catch(() => {});
  }
  try {
    const result = await relayEvent('message', outgoingText, images, trace);
    if (!ownsRound()) return;
    if (result.cancelled) {
      latencyLog('visual_send_cancelled', `round=${round.roundId} count=${images.length} reason=newer_request`, trace);
      round.status = '发送已取消，可重试';
      if (round.roundId && round.source === 'screen' && isAndroidApp) {
        cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: round.roundId, success: false }).catch(() => {});
      }
      return;
    }
    latencyLog('visual_send_accepted', `round=${round.roundId} count=${images.length} relay_images=${result.timing?.image_count ?? 'unknown'}`, trace);
    round.sent = true;
    round.frames = [];
    round.imageCount = 0;
    round.status = result.ai_online === false
      ? `已发送 ${images.length} 张画面，等待 MCP 接收`
      : `已发送 ${images.length} 张画面，等待 AI 接收`;
    if (isCurrentTrace(trace) && !trace.replyReceived) setStatus(result.ai_online === false ? '消息已排队，等待 MCP 接收' : '消息已送达桥接，等待 AI 接收⋯');
    if (round.roundId && round.source === 'screen' && isAndroidApp) {
      await cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: round.roundId, success: true }).catch(() => {});
      await cap.nativePromise('ScreenCapture', 'setVisualImageCount', {
        roundId: round.roundId, imageCount: 0, maxImages: MAX_VISUAL_IMAGES,
      }).catch(() => {});
    }
  } catch (error) {
    if (!ownsRound()) return;
    latencyLog('visual_send_failed', `round=${round.roundId} count=${images.length} http_status=${error.status || 'na'}`, trace);
    round.status = '发送失败，可重试';
    if (round.roundId && round.source === 'screen' && isAndroidApp) {
      cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: round.roundId, success: false }).catch(() => {});
    }
    log(`畫面發送失敗: ${error.message}`);
    if (isCurrentTrace(trace)) setStatus('畫面發送失敗');
  } finally {
    round.sending = false;
    if (visualRound === round) renderVisualRound();
    drainQueuedVoiceInput();
  }
}

// ─── 計時器 ──────────────────────────────────────────────

function startTimer() {
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    el('call-timer').textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  el('call-timer').textContent = '';
}

// ─── Vivix API ───────────────────────────────────────────

async function createVivixSession() {
  const body = {
    model: 'vivix-a1-stream',
    output: { aspect_ratio: '9:16', resolution: '720p' },
    max_duration_seconds: 300,
    avatars: [{
      avatar_id: 'custom-character',
      instructions: '角色只按照外部傳入的台詞說話，不自行回答。',
      visual: {
        source_images: [{
          source_image_id: 'portrait',
          url: cfg.charImg,
          media_type: 'image/jpeg',
        }],
      },
    }],
    pipeline_config: {
      tts_config: { tts_voice_id: cfg.vivixVoice || DEFAULT_VIVIX_VOICE },
    },
  };

  const res = await httpJson(`${vivixBase()}/realtime-avatar/sessions`, {
    method: 'POST',
    headers: vivixHeaders(),
    body,
  });

  if (!res.ok) {
    if (res.traceId) log(`Vivix X-Trace-Id：${res.traceId}`);
    throw apiError('Vivix', res.status, res.data);
  }

  return res.data.data || res.data;
}

async function closeVivixSession() {
  const sessionId = vivixSessionId;
  if (!sessionId) return;
  vivixSessionId = null;
  try {
    await httpJson(`${vivixBase()}/realtime-avatar/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: vivixHeaders(),
      body: {},
    });
  } catch (e) {
    log(`關閉 Vivix session 失敗: ${e.message}`);
  }
}

async function fallbackVivix(reason) {
  log(`Vivix 連線失敗，改用靜態角色圖和語音：${reason}`);
  if (vivixWs) vivixWs.close();
  vivixWs = null;
  void closeVivixSession();
  await leaveTrtcRoom();
  el('portrait-preview').classList.remove('is-hidden');
}

function connectVivixWs(controlUrl, clientSecret) {
  const url = new URL(controlUrl);
  url.searchParams.set('token', clientSecret);
  log(`Vivix WebSocket 連線中：${url.host}`);
  const socket = new WebSocket(url);
  vivixWs = socket;
  let connected = false;
  let settled = false;
  let connectionTimer;
  const ready = new Promise((resolve, reject) => {
    const fail = message => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      if (vivixWs === socket) vivixWs = null;
      socket.close();
      reject(new Error(message));
    };
    connectionTimer = setTimeout(() => fail('Vivix WebSocket 連線逾時'), 10000);
    socket.onopen = () => {
      if (settled) return;
      settled = true;
      connected = true;
      clearTimeout(connectionTimer);
      log('Vivix WebSocket 已連線');
      resolve();
    };
    socket.onclose = (e) => {
      const wasCurrent = vivixWs === socket;
      if (wasCurrent) vivixWs = null;
      log(`Vivix WebSocket 已斷線（code ${e.code}${e.reason ? `，${e.reason}` : ''}）`);
      if (!connected) fail(`WebSocket code ${e.code}`);
      else if (wasCurrent && isInCall) void fallbackVivix(`WebSocket code ${e.code}`);
    };
    socket.onerror = (e) => {
      const wasCurrent = vivixWs === socket;
      log(`Vivix WS 錯誤: ${e.message || '未知'}`);
      if (!connected) fail('Vivix WebSocket 連線錯誤');
      else if (wasCurrent && isInCall) void fallbackVivix('WebSocket 錯誤');
    };
  });

  socket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'error' || msg.type === 'session.closed') {
        const wasCurrent = vivixWs === socket;
        if (msg.type === 'session.closed' && wasCurrent) vivixWs = null;
        const detail = msg.error || msg;
        const hint = friendlyHint('Vivix', 0, detail);
        if (msg.type === 'error' || hint) log(`⚠ ${hint || `Vivix：${detail.message || detail.reason || msg.type}`}`);
        if (hint) setStatus(hint);
        if (wasCurrent) {
          if (isInCall) void fallbackVivix(hint || detail.message || msg.type);
          else {
            vivixWs = null;
            socket.close();
          }
        }
      }
      if (msg.type === 'response.done' && vivixWs === socket) {
        setAiSpeaking(false);
        setStatus(vad ? '聆聽中' : '等待中');
      }
    } catch {}
  };
  return ready;
}

// vocal：ElevenLabs 是 { type: 'audio', ... }，Vivix 內建聲音是 { type: 'speech', text }
function sendToVivix(vocal, actionPrompt) {
  if (!vivixWs || vivixWs.readyState !== WebSocket.OPEN) {
    log('Vivix WebSocket 未連線');
    return;
  }
  setAiSpeaking(true);
  vivixWs.send(JSON.stringify({
    type: 'response.create',
    response: {
      conversation: 'none',
      script: {
        vocal,
        visual: {
          prompt: actionPrompt || '自然地說話',
          duration_ms: 5000,
        },
      },
    },
  }));
}

let speechGeneration = 0;
let cancelLocalVocal = null;
let cancelVivixVocal = null;

function playLocalVocal(vocal, trace, replyReceivedAt = 0) {
  const generation = speechGeneration;
  const current = () => generation === speechGeneration && isCurrentTrace(trace);
  if (!current()) return Promise.resolve();
  cancelLocalVocal?.();
  window.speechSynthesis?.cancel();
  return new Promise((resolve, reject) => {
    let audio = null, utterance = null, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (audio) {
        audio.onended = audio.onerror = audio.onplaying = audio.onwaiting = null;
        audio.pause();
        audio.removeAttribute('src');
        if (localAudio === audio) localAudio = null;
      }
      if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
      if (cancelLocalVocal === cancel) cancelLocalVocal = null;
      if (current()) latencyLog('tts_playback_ended', '', trace);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish();
    cancelLocalVocal = cancel;
    const started = () => {
      if (!current()) { finish(); return; }
      latencyLog('tts_playback_started', `after_reply_ms=${replyReceivedAt ? Math.round(performance.now() - replyReceivedAt) : 'na'} since_voice_ms=${trace?.lastVoiceAt ? Math.round(performance.now() - trace.lastVoiceAt) : 'na'}`, trace);
    };
    setAiSpeaking(true);
    if (vocal.type === 'audio') {
      audio = new Audio(`data:${vocal.mime_type || 'audio/mpeg'};base64,${vocal.audio}`);
      localAudio = audio;
      audio.onended = () => finish();
      audio.onplaying = started;
      audio.onwaiting = () => { if (current()) latencyLog('tts_playback_buffering', '', trace); };
      audio.onerror = () => finish(new Error('語音播放失敗'));
      audio.play().catch(error => finish(error));
    } else if ('speechSynthesis' in window) {
      utterance = new SpeechSynthesisUtterance(vocal.text);
      utterance.lang = 'zh-CN';
      utterance.onstart = started;
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error('裝置語音播放失敗'));
      window.speechSynthesis.speak(utterance);
    } else finish(new Error('此裝置不支援語音播放'));
  });
}

function cancelVivixResponse(reason = 'unspecified') {
  const pending = [...pendingMcpMessages.values()].filter(trace => !trace.cancelled);
  if (aiSpeaking || pending.length || activeInputTrace) {
    latencyLog('response_cancelled', `reason=${reason} playing=${aiSpeaking} pending=${pending.length}`, activeInputTrace);
  }
  speechGeneration += 1;
  speakQueue = Promise.resolve();
  cancelPendingReplies();
  cancelLocalVocal?.();
  cancelVivixVocal?.();
  activeMp3Player?.close();
  activeMp3Player = null;
  activeDialogueConnection?.cancel?.();
  activeDialogueConnection?.socket.close();
  activeDialogueConnection = null;
  setAiSpeaking(false);
  if (localAudio) {
    localAudio.onended = null;
    localAudio.onerror = null;
    localAudio.pause();
    localAudio = null;
  }
  window.speechSynthesis?.cancel();
  if (vivixWs && vivixWs.readyState === WebSocket.OPEN) {
    vivixWs.send(JSON.stringify({ type: 'response.cancel' }));
  }
}

// 角色說話時不收音，避免把角色自己的聲音當成使用者說話；沒收到 response.done 時 20 秒後自動解除
function setAiSpeaking(on) {
  aiSpeaking = on;
  clearTimeout(aiSpeakingTimer);
  if (on) aiSpeakingTimer = setTimeout(() => {
    if (localAudio || activeMp3Player || cancelLocalVocal) return;
    aiSpeaking = false;
  }, 20000);
}

// ─── TRTC ────────────────────────────────────────────────

async function enterTrtcRoom(trtc) {
  trtcInfo = trtc;
  rtc = TRTC.create();

  rtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
    if (userId !== trtc.publisher_user_id) return;
    el('portrait-preview').classList.add('is-hidden');
    el('call-launcher').classList.add('is-hidden');
    rtc.startRemoteVideo({ userId, streamType, view: 'video-stage' });
    log('遠端視訊已接收');
  });

  rtc.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, ({ userId }) => {
    if (userId !== trtc.publisher_user_id) return;
    el('portrait-preview').classList.remove('is-hidden');
    log('遠端視訊中斷');
  });

  log('進入 TRTC 房間中⋯');
  await rtc.enterRoom({
    sdkAppId: Number(trtc.sdk_app_id),
    userId: trtc.user_id,
    userSig: trtc.user_sig,
    strRoomId: trtc.room_id,
    scene: TRTC.TYPE.SCENE_RTC,
    autoReceiveVideo: false,
  });

  log('已進入 TRTC 房間');
}

async function setCallScreenAwake(enabled) {
  if (!isAndroidApp) return;
  try {
    await cap.nativePromise('KeepScreenOn', 'setEnabled', { enabled });
    latencyLog('call_screen_awake', `enabled=${enabled}`);
  } catch (e) {
    latencyLog('call_screen_awake_failed', `enabled=${enabled} error_type=${e.name}`);
    log(`設定通話常亮失敗: ${e.message}`);
  }
}

async function setNativeCallAudioActive(active, trace) {
  if (!isAndroidApp) return;
  try {
    await cap.nativePromise('CallAudio', 'setActive', { active });
    latencyLog('call_audio_route_requested', `active=${active}`, trace);
  } catch (error) {
    latencyLog('call_audio_route_failed', `active=${active} error_type=${error.name}`, trace);
  }
}

async function leaveTrtcRoom() {
  if (!rtc) return;
  try {
    await rtc.exitRoom();
    rtc.destroy();
  } catch {}
  rtc = null;
  trtcInfo = null;
}

// ─── 自拍鏡頭 ───────────────────────────────────────────

async function startSelfCam(facing = 'user') {
  latencyLog('camera_requested', `facing=${facing === 'environment' ? 'rear' : 'front'}`);
  try {
    selfStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1920 } },
      audio: false,
    });
    const settings = selfStream.getVideoTracks()[0]?.getSettings();
    selfFacing = settings?.facingMode || facing;
    const video = el('self-video');
    video.style.transform = selfFacing === 'user' ? 'scaleX(-1)' : 'none';
    video.srcObject = selfStream;
    video.classList.remove('is-hidden');
    updateCameraControls();
    latencyLog('camera_ready', `facing=${selfFacing === 'environment' ? 'rear' : 'front'} width=${settings?.width || 'na'} height=${settings?.height || 'na'}`);
    log('自拍鏡頭已開啟');
    return true;
  } catch (e) {
    latencyLog('camera_failed', `error_type=${e.name}`);
    log(`自拍鏡頭失敗: ${e.message}`);
    return false;
  }
}

function stopSelfCam() {
  if (selfStream) {
    latencyLog('camera_stopped');
    selfStream.getTracks().forEach(t => t.stop());
    selfStream = null;
  }
  selfFacing = 'user';
  camPaused = false;
  el('self-video').classList.add('is-hidden');
  el('self-video').srcObject = null;
  updateCameraControls();
}

function updateCameraControls() {
  const active = !!selfStream;
  const openButton = el('btn-open-cam');
  openButton.textContent = active ? '關閉攝像頭' : '打開攝像頭';
  openButton.setAttribute('aria-label', active ? '關閉攝像頭' : '打開攝像頭');
  el('btn-switch-cam').disabled = !active;
  const pauseButton = el('btn-pause-cam');
  pauseButton.disabled = !active;
  pauseButton.textContent = camPaused ? '恢復鏡頭' : '暫停讓他看';
  updateScreenShareControls();
}

function isScreenShareActive() {
  return nativeScreenSharing || !!screenStream;
}

function updateScreenShareControls() {
  const active = isScreenShareActive();
  const button = el('btn-share-screen');
  button.disabled = screenCaptureStarting || (!isInCall && !active);
  button.textContent = active ? '停止共享' : '共享屏幕';
  button.setAttribute('aria-label', active ? '停止共享屏幕' : '共享屏幕');
  el('screen-share-controls').classList.toggle('is-hidden', !isInCall && !active);
  el('screen-share-preview').classList.toggle('is-hidden', !active);
  el('screen-video').classList.toggle('is-hidden', !screenStream);
  el('screen-image').classList.toggle('is-hidden', !nativeScreenSharing || !el('screen-image').src);
  el('send-frame-label').textContent = active ? '发送屏幕画面' : '拍一张给他看';
  el('btn-send-frame').setAttribute('aria-label', active ? '发送屏幕画面' : '拍一张给他看');
}

async function refreshNativeScreenPreview() {
  if (!nativeScreenSharing || screenPreviewBusy) return;
  screenPreviewBusy = true;
  try {
    const frame = await cap.nativePromise('ScreenCapture', 'captureFrame', {});
    if (!nativeScreenSharing) return;
    if (!frame.active) {
      if (Date.now() - nativeScreenStartedAt < 5000) return;
      await stopScreenShare({ nativeAlreadyStopped: true });
      return;
    }
    if (frame.image) el('screen-image').src = `data:image/jpeg;base64,${frame.image}`;
  } catch (e) {
    log(`屏幕共享預覽失敗: ${e.message}`);
    await stopScreenShare({ nativeAlreadyStopped: true });
  } finally {
    screenPreviewBusy = false;
  }
}

async function startScreenShare() {
  if (!isInCall || screenCaptureStarting) return;
  screenCaptureStarting = true;
  latencyLog('screen_share_requested', `native=${isAndroidApp}`);
  updateScreenShareControls();
  try {
    if (isAndroidApp) {
      const result = await cap.nativePromise('ScreenCapture', 'start', {});
      if (!result.active) throw new Error('屏幕共享未能啟動');
      if (!isInCall) {
        await cap.nativePromise('ScreenCapture', 'stop', {});
        return;
      }
      nativeScreenSharing = true;
      nativeCallStatus = el('call-status').textContent;
      cap.nativePromise('ScreenCapture', 'setCallStatus', { status: nativeCallStatus }).catch(() => {});
      nativeScreenStartedAt = Date.now();
      el('screen-image').removeAttribute('src');
      void refreshNativeScreenPreview();
      screenPreviewTimer = setInterval(refreshNativeScreenPreview, 1000);
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('此瀏覽器不支援屏幕共享');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
      if (!isInCall) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      screenStream = stream;
      el('screen-video').srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopScreenShare());
      el('screen-video').play().catch(() => {});
    }
    el('screen-share-status').textContent = '共享中';
    latencyLog('screen_share_ready', `native=${nativeScreenSharing}`);
    log('屏幕共享已開啟；只會在按下發送畫面時提交截圖');
  } catch (e) {
    latencyLog('screen_share_failed', `error_type=${e.name}`);
    log(`屏幕共享失敗: ${e.message}`);
    setStatus(e.message || '屏幕共享失敗');
  } finally {
    screenCaptureStarting = false;
    updateScreenShareControls();
  }
}

async function stopScreenShare({ nativeAlreadyStopped = false } = {}) {
  const wasNative = nativeScreenSharing;
  if (wasNative || screenStream) latencyLog('screen_share_stopped', `native=${wasNative} native_already_stopped=${nativeAlreadyStopped}`);
  nativeScreenSharing = false;
  nativeCallStatus = null;
  if (screenPreviewTimer) clearInterval(screenPreviewTimer);
  screenPreviewTimer = null;
  if (screenStream) screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;
  el('screen-video').srcObject = null;
  el('screen-image').removeAttribute('src');
  if (wasNative && !nativeAlreadyStopped && isAndroidApp) {
    try { await cap.nativePromise('ScreenCapture', 'stop', {}); }
    catch (e) { log(`停止屏幕共享失敗: ${e.message}`); }
  }
  updateScreenShareControls();
}

// ─── 語音輸入（自動判斷說話 → STT） ─────────────────────

// Whisper 在沒人說話或只收到半句時會亂補：片尾字幕、單獨一句謝謝、把提示詞念回來
const STT_JUNK = /^(謝謝(大家)?(收看|觀看|觀賞)|字幕由|請不吝點贊|明鏡與點點|以下是繁體中文)/;
const STT_JUNK_EXACT = /^(謝謝|謝謝你|谢谢|嗯|啊|Bye|bye)[。.!！~～]*$/;
const SCRIBE_ERRORS = new Set([
  'error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error', 'invalid_request',
  'commit_throttled', 'unaccepted_terms', 'rate_limited', 'queue_overflow', 'resource_exhausted',
  'session_time_limit_exceeded', 'chunk_size_exceeded', 'insufficient_audio_activity',
]);

function cleanScribeTranscript(value) {
  const text = (value || '').trim();
  return transcriptShape(text) === 'text' ? text.replace(/^(?:。\s*|\.+\s+)+/u, '') : text;
}

function isUnusableTranscript(text) {
  return transcriptShape(text) !== 'text';
}

function hasStt() {
  return sttProvider() === 'elevenlabs' ? !!(cfg.sttKey || cfg.elKey) : !!cfg.sttKey;
}

function sttProvider(s = cfg) {
  return s.sttProvider || 'openai';
}

function pcm16Base64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

let audioDiagnostic = null;
const AUDIO_DIAGNOSTIC_MS = 300_000;

async function startAudioDiagnostic(generation) {
  if (!isAndroidApp) return;
  const owner = { callId: callTraceId, sessionId: sessionTraceId };
  try {
    const enabled = window.LumeetAudioDiagnostic?.begin(owner.callId) === true;
    if (!enabled || generation !== realtimeSttGeneration || !isInCall || isMuted) return;
    const capture = { owner, tracks: new Map(), sequence: 0 };
    audioDiagnostic = capture;
    capture.timer = setTimeout(stopAudioDiagnostic, AUDIO_DIAGNOSTIC_MS);
    latencyLog('audio_diagnostic_started', `max_ms=${AUDIO_DIAGNOSTIC_MS} format=pcm_s16le_mono`, owner);
  } catch {
    latencyLog('audio_diagnostic_failed', 'stage=begin', owner);
  }
}

function flushAudioDiagnosticTrack(capture, key) {
  const track = capture.tracks.get(key);
  if (!track) return;
  capture.tracks.delete(key);
  const name = `${key}-${track.at}-${++capture.sequence}.pcm`;
  void Promise.resolve().then(() => {
    const samples = new Int16Array(track.length);
    let offset = 0;
    for (const frame of track.frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    if (window.LumeetAudioDiagnostic?.savePcm(capture.owner.callId, name, pcm16Base64(samples)) !== true) {
      throw new Error('Audio diagnostic sample was not saved');
    }
  }).then(
    () => latencyLog('audio_diagnostic_saved', `file=${name} samples=${track.length}`, capture.owner),
    () => latencyLog('audio_diagnostic_failed', `stage=save file=${name}`, capture.owner),
  );
}

function stopAudioDiagnostic() {
  const capture = audioDiagnostic;
  if (!capture) return;
  audioDiagnostic = null;
  clearTimeout(capture.timer);
  for (const key of capture.tracks.keys()) flushAudioDiagnosticTrack(capture, key);
  latencyLog('audio_diagnostic_stopped', `chunks=${capture.sequence}`, capture.owner);
}

function sampleAudioDiagnostic(source, rate, samples, callId, flush = false) {
  const capture = audioDiagnostic;
  if (!capture || capture.owner.callId !== callId || !samples.length) return;
  const key = `${source}-${rate}`;
  let track = capture.tracks.get(key);
  if (!track) {
    track = { at: Date.now(), frames: [], length: 0 };
    capture.tracks.set(key, track);
  }
  track.frames.push(source === 'mic'
    ? Int16Array.from(samples, sample => Math.round(Math.max(-1, Math.min(1, sample)) * 32767))
    : samples);
  track.length += samples.length;
  if (flush || track.length >= rate) flushAudioDiagnosticTrack(capture, key);
}

function scribeAbortError(signal) {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function openElevenLabsStt(onEvent, commitStrategy = 'vad', trace, signal) {
  if (signal?.aborted) throw scribeAbortError(signal);
  const connectionStartedAt = performance.now();
  const call = { callId: callTraceId, sessionId: sessionTraceId };
  const owner = trace || call;
  const mode = trace?.source === 'push_to_talk' ? 'ptt' : trace ? 'fallback' : 'live';
  const connection = crypto.randomUUID();
  const context = `mode=${mode} connection=${connection}`;
  latencyLog('stt_connection_started', context, owner);
  const key = cfg.sttKey || cfg.elKey;
  const tokenRes = await httpJson(`${ELEVENLABS_BASE}/single-use-token/realtime_scribe`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    timeoutMs: 15000,
  });
  if (signal?.aborted) throw scribeAbortError(signal);
  if (!tokenRes.ok) {
    throw apiError('語音辨識', tokenRes.status, tokenRes.data);
  }
  if (!tokenRes.data?.token) throw new Error('ElevenLabs 沒有返回語音辨識連線令牌');

  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  for (const [name, value] of Object.entries({
    model_id: DEFAULT_ELEVEN_STT_MODEL,
    token: tokenRes.data.token,
    audio_format: 'pcm_16000',
    sample_rate: '16000',
    language_code: 'zh',
    commit_strategy: commitStrategy,
    vad_silence_threshold_secs: '1.5',
    keepalive_interval_ms: '1000',
  })) url.searchParams.set(name, value);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let ready = false, settled = false;
    let firstChunk = true;
    const timeout = setTimeout(() => fail(new Error('ElevenLabs 語音辨識連線逾時')), 20000);
    const abort = () => fail(scribeAbortError(signal));
    const fail = error => {
      if (!ready) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        socket.close();
        reject(error);
      } else onEvent({ message_type: 'client_error', error: error.message });
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.onmessage = e => {
      if (!ready && settled) return;
      let message;
      try { message = JSON.parse(e.data); } catch { return; }
      if (!ready && message.message_type === 'session_started') {
        latencyLog('stt_connection_ready', `${context} ms=${Math.round(performance.now() - connectionStartedAt)}`, owner);
        ready = settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        resolve({
          connection,
          sendPcm(samples, commit = false) {
            if (socket.readyState !== WebSocket.OPEN) return false;
            const frame = {
              message_type: 'input_audio_chunk',
              audio_base_64: pcm16Base64(samples),
              sample_rate: 16000,
              ...(firstChunk ? { previous_text: STT_VOCABULARY.join(' ') } : {}),
            };
            if (commit) frame.commit = true;
            try {
              socket.send(JSON.stringify(frame));
            } catch {
              return false;
            }
            firstChunk = false;
            if (mode !== 'ptt') sampleAudioDiagnostic(mode === 'live' ? `live-${connection}` : `fallback-${trace.id}`, 16000, samples, owner.callId, commit);
            return true;
          },
          close() { if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'stop'); },
        });
        return;
      }
      if (!ready && (message.error || SCRIBE_ERRORS.has(message.message_type))) {
        if (SCRIBE_ERRORS.has(message.message_type)) latencyLog('stt_provider_error', `${context} type=${message.message_type}`, owner);
        fail(new Error(message.error?.message || message.error || message.message || message.message_type));
      } else if (ready) onEvent(message);
    };
    socket.onerror = () => fail(new Error('ElevenLabs 語音辨識 WebSocket 連線失敗'));
    socket.onclose = event => {
      latencyLog('stt_connection_closed', `${context} ready=${ready} code=${event.code} clean=${event.wasClean} reason=${event.reason === 'stop' ? 'local_close' : event.reason ? 'peer_reason' : 'none'} in_call=${isInCall && call.callId === callTraceId}`, owner);
      if (!ready) fail(new Error('ElevenLabs 語音辨識連線已關閉'));
      else onEvent({ message_type: 'client_closed' });
    };
  });
}

async function transcribeElevenLabsBlob(blob, trace, signal) {
  if (signal?.aborted) throw scribeAbortError(signal);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  let pcm;
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const channel = audio.getChannelData(ch);
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.numberOfChannels;
    }
    const length = Math.floor(mono.length * 16000 / audio.sampleRate);
    pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const at = i * audio.sampleRate / 16000;
      const left = Math.floor(at), fraction = at - left;
      const value = mono[left] * (1 - fraction) + mono[Math.min(left + 1, mono.length - 1)] * fraction;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    }
  } finally {
    await context.close().catch(() => {});
  }

  let resolveTranscript, rejectTranscript;
  const transcriptPromise = new Promise((resolve, reject) => {
    resolveTranscript = resolve;
    rejectTranscript = reject;
  });
  const session = await openElevenLabsStt(message => {
    if (message.message_type === 'committed_transcript') resolveTranscript(message.text || '');
    if (SCRIBE_ERRORS.has(message.message_type) || message.message_type === 'client_error') {
      latencyLog('stt_provider_error', `type=${message.message_type} mode=${trace?.source === 'push_to_talk' ? 'ptt' : 'fallback'}`, trace);
      rejectTranscript(new Error(message.error?.message || message.error || message.message || message.message_type));
    }
    if (message.message_type === 'client_closed') rejectTranscript(new Error('ElevenLabs 語音辨識連線已關閉'));
  }, 'manual', trace, signal);
  let timeout;
  const abort = () => rejectTranscript(scribeAbortError(signal));
  try {
    if (signal?.aborted) throw scribeAbortError(signal);
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => rejectTranscript(new Error('ElevenLabs 語音辨識逾時')), 30000);
    if (!pcm.length) session.sendPcm(new Int16Array(), true);
    for (let i = 0; i < pcm.length; i += 1600) {
      const end = Math.min(i + 1600, pcm.length);
      if (!session.sendPcm(pcm.subarray(i, end), end === pcm.length)) throw new Error('ElevenLabs 語音辨識連線已關閉');
    }
    const text = cleanScribeTranscript(await transcriptPromise);
    const junk = !!text && isUnusableTranscript(text);
    if (trace) latencyLog('stt_fallback_result', `connection=${session.connection} pcm_samples=${pcm.length} chars=${text.length} shape=${transcriptShape(text)} junk=${junk}`, trace);
    return junk ? '' : text;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    session.close();
  }
}

async function transcribe(blob, trace) {
  if (sttProvider() === 'elevenlabs') return transcribeElevenLabsBlob(blob, trace);
  const base = (cfg.sttBase || DEFAULT_STT_BASE).replace(/\/+$/, '');
  const fd = new FormData();
  fd.append('file', blob, blob.type.includes('wav') ? 'speech.wav' : blob.type.includes('mp4') ? 'speech.m4a' : 'speech.webm');
  fd.append('model', cfg.sttModel || DEFAULT_STT_MODEL);
  fd.append('prompt', `以下是繁體中文的日常對話。專有名詞：${STT_VOCABULARY.join('、')}。`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.sttKey}` },
      body: fd, signal: controller.signal,
    });
    if (!res.ok) throw apiError('語音辨識', res.status, parseMaybeJson(await res.text()));
    const text = ((await res.json()).text || '').trim();
    const junk = !!text && (isUnusableTranscript(text) || STT_JUNK.test(text) || STT_JUNK_EXACT.test(text));
    if (trace) latencyLog('stt_recording_result', `chars=${text.length} shape=${transcriptShape(text)} junk=${junk}`, trace);
    return junk ? '' : text;
  } finally { clearTimeout(timeout); }
}

let realtimeStt = null;
let sttPcmPending = [];
let sttResamplePos = 0;
let realtimeSpeechActive = false;
let realtimePendingUtterance = null;
let realtimeCommitTimer = null;
let realtimeDeferredTranscript = null;
let realtimeSttGeneration = 0;
let listeningSttAbort = null;
let realtimeSttConnectingGeneration = 0;
let realtimeSttReconnectTimer = null;
let realtimeSttRetryMs = 1000;
let realtimeSttWatchdogTimer = null;
let realtimeSttStableTimer = null;
let realtimeSttLastPcmAt = 0;
let realtimeSttLastMessageAt = 0;
const REALTIME_SILENCE_HEARTBEAT = new Int16Array(16000);

function startRealtimeSttWatchdog(generation) {
  clearInterval(realtimeSttWatchdogTimer);
  realtimeSttLastPcmAt = performance.now();
  realtimeSttLastMessageAt = performance.now();
  realtimeSttWatchdogTimer = setInterval(() => {
    if (generation !== realtimeSttGeneration || !vad || !isInCall || isMuted) return;
    const session = realtimeStt;
    if (!session) return;
    const now = performance.now();
    if (now - realtimeSttLastPcmAt >= 750 && !sendRealtimePcm(session, REALTIME_SILENCE_HEARTBEAT)) return;
    if (now - realtimeSttLastMessageAt > 8000) disconnectRealtimeStt(session, 'response_timeout');
  }, 1000);
}

function scheduleRealtimeSttReconnect(generation) {
  if (generation !== realtimeSttGeneration || !vad || !isInCall || isMuted || realtimeSttReconnectTimer) return;
  const delay = realtimeSttRetryMs;
  realtimeSttRetryMs = Math.min(realtimeSttRetryMs * 2, 30000);
  const status = el('call-status').textContent;
  if (status === '聆聽中' || status.startsWith('語音辨識')) setStatus('語音辨識重連中⋯');
  latencyLog('stt_reconnect_scheduled', `delay_ms=${delay}`);
  realtimeSttReconnectTimer = setTimeout(() => {
    realtimeSttReconnectTimer = null;
    connectRealtimeStt(generation);
  }, delay);
}

function takeRealtimePendingUtterance() {
  const pending = realtimePendingUtterance;
  realtimePendingUtterance = null;
  clearTimeout(realtimeCommitTimer);
  realtimeCommitTimer = null;
  return pending;
}

function markRealtimeSttUnavailable(reason) {
  setSubtitle('');
  const pending = takeRealtimePendingUtterance();
  if (pending) queueRealtimeFallback(pending, reason);
  if (realtimeSpeechActive) {
    if (realtimeDeferredTranscript?.trace === currentSpeechTrace) realtimeDeferredTranscript = null;
    if (currentSpeechTrace && !currentSpeechTrace.needsFallback) {
      currentSpeechTrace.needsFallback = true;
      currentSpeechTrace.fallbackReason = reason;
    }
  }
}

function disconnectRealtimeStt(session, reason) {
  if (!session || realtimeStt !== session) return;
  realtimeStt = null;
  clearTimeout(realtimeSttStableTimer);
  realtimeSttStableTimer = null;
  sttPcmPending = [];
  markRealtimeSttUnavailable(reason);
  session.close();
  latencyLog('stt_connection_lost', `mode=live connection=${session.connection} reason=${reason}`);
  scheduleRealtimeSttReconnect(realtimeSttGeneration);
}

function sendRealtimePcm(session, samples) {
  if (!session.sendPcm(samples)) {
    disconnectRealtimeStt(session, 'send_failed');
    return false;
  }
  realtimeSttLastPcmAt = performance.now();
  return true;
}

function sendRealtimeSttFrame(frame, sampleRate) {
  const session = realtimeStt;
  if (!session) return;
  const silent = aiSpeaking || isMuted || currentSpeechTrace?.needsFallback;
  const step = sampleRate / 16000;
  let pos = sttResamplePos;
  while (pos < frame.length) {
    const sample = silent ? 0 : frame[Math.floor(pos)];
    sttPcmPending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
    pos += step;
  }
  sttResamplePos = pos - frame.length;
  while (sttPcmPending.length >= 1600) {
    const chunk = Int16Array.from(sttPcmPending.splice(0, 1600));
    if (!sendRealtimePcm(session, chunk)) return;
    if (localSpeechActive && currentSpeechTrace && !silent) currentSpeechTrace.liveSamples += chunk.length;
  }
}

function queueRealtimeFallback(pending, reason) {
  pending.trace.needsFallback = true;
  latencyLog('stt_fallback_queued', `reason=${reason} bytes=${pending.blob.size} queued=${realtimeFallbackQueue.length} running=${realtimeFallbackGeneration === pending.generation}`, pending.trace);
  pendingVoiceTranscriptions.add(pending.trace);
  realtimeFallbackQueue.push(pending);
  void drainRealtimeFallbacks(pending.generation);
}

async function drainRealtimeFallbacks(generation) {
  if (realtimeFallbackGeneration === generation) return;
  realtimeFallbackGeneration = generation;
  const signal = listeningSttAbort?.signal;
  try {
    while (generation === realtimeSttGeneration && isInCall && !isMuted && realtimeFallbackQueue.length) {
      const { blob, trace } = realtimeFallbackQueue.shift();
      try {
        if (el('call-status').textContent === '聆聽中') setStatus('辨識中⋯');
        latencyLog('stt_fallback_request_started', `bytes=${blob.size}`, trace);
        const text = await transcribeElevenLabsBlob(blob, trace, signal);
        if (generation !== realtimeSttGeneration || !isInCall || isMuted) continue;
        transcriptReady(trace, text, 'fallback');
        if (!text || aiSpeaking) finishVisualRoundWithoutText(trace);
        else {
          log(`你（語音）：${text}`);
          queueVoiceTranscript(text, trace);
        }
      } catch (error) {
        if (generation !== realtimeSttGeneration || !isInCall || isMuted) continue;
        latencyLog('stt_fallback_failed', `error_type=${error.name} http_status=${error.status || 'na'}`, trace);
        log(`語音辨識補送失敗：${error.message}`);
        finishVisualRoundWithoutText(trace);
      } finally {
        pendingVoiceTranscriptions.delete(trace);
        if (generation === realtimeSttGeneration) scheduleVoiceTurn();
      }
    }
  } finally {
    if (realtimeFallbackGeneration === generation) realtimeFallbackGeneration = 0;
    if (generation === realtimeSttGeneration && isInCall && !isMuted && el('call-status').textContent === '辨識中⋯') setStatus('聆聽中');
  }
}

let lastDiscardedPartial = '';
function handleRealtimeSttMessage(message) {
  if (message.message_type === 'partial_transcript') {
    const text = cleanScribeTranscript(message.text);
    if (!text || aiSpeaking || isMuted) return;
    const trace = localSpeechActive ? currentSpeechTrace : realtimePendingUtterance?.trace;
    const reason = isUnusableTranscript(text) ? 'unusable_text' : !trace ? 'no_local_utterance' : trace.needsFallback ? 'fallback_owned' : '';
    if (reason) {
      const shape = transcriptShape(text);
      const key = `${realtimeStt?.connection}/${trace?.id}/${reason}/${shape}`;
      if (key !== lastDiscardedPartial) {
        lastDiscardedPartial = key;
        latencyLog('stt_partial_discarded', `reason=${reason} shape=${shape} chars=${text.length} local_speech=${localSpeechActive} connection=${realtimeStt?.connection || 'na'}`, trace);
      }
      return;
    }
    if (!trace.partialAt) {
      trace.partialAt = performance.now();
      latencyLog('stt_first_partial', `since_start_ms=${Math.round(trace.partialAt - trace.startedAt)} chars=${text.length} shape=${transcriptShape(text)} local_speech=${localSpeechActive} connection=${realtimeStt?.connection || 'na'}`, trace);
    }
    setSubtitle(text, 'stt_partial', trace);
  } else if (message.message_type === 'committed_transcript') {
    const text = cleanScribeTranscript(message.text);
    const pending = realtimePendingUtterance;
    const trace = pending?.trace || currentSpeechTrace;
    const junk = !!text && isUnusableTranscript(text);
    latencyLog('stt_live_commit_received', `connection=${realtimeStt?.connection || 'na'} chars=${text.length} shape=${transcriptShape(text)} junk=${junk} pending=${!!pending} local_speech=${localSpeechActive} muted=${isMuted}`, trace);
    if (!trace || !isCurrentTrace(trace) || isMuted || trace.needsFallback) return;
    if (realtimeSpeechActive && trace === currentSpeechTrace) {
      if (text && !junk) {
        const previous = realtimeDeferredTranscript?.trace === trace ? realtimeDeferredTranscript.text : '';
        realtimeDeferredTranscript = { trace, text: previous ? `${previous}\n${text}` : text };
        setSubtitle(realtimeDeferredTranscript.text, 'stt_deferred', trace);
        latencyLog('stt_final_deferred_until_speech_end', `chars=${realtimeDeferredTranscript.text.length}`, trace);
      }
      return;
    }
    if (pending && trace === pending.trace) {
      takeRealtimePendingUtterance();
      if (!text || junk) {
        setSubtitle('');
        queueRealtimeFallback(pending, 'empty_or_junk_commit');
        return;
      }
    }
    pendingVoiceTranscriptions.delete(trace);
    deliverRealtimeTranscript(trace, pending?.prefix ? `${pending.prefix}\n${text}` : text);
    scheduleVoiceTurn();
  } else if (SCRIBE_ERRORS.has(message.message_type)) {
    latencyLog('stt_provider_error', `mode=live type=${message.message_type} connection=${realtimeStt?.connection || 'na'}`, currentSpeechTrace);
    const error = message.error?.message || message.error || message.message || message.message_type;
    log(`ElevenLabs 語音辨識：${error}`);
    setStatus(`語音辨識失敗：${error}`);
  }
}

function deliverRealtimeTranscript(trace, text) {
  if (!isCurrentTrace(trace) || isMuted) return;
  if (currentSpeechTrace === trace) currentSpeechTrace = null;
  transcriptReady(trace, text, 'live');
  setSubtitle('');
  if (isUnusableTranscript(text) || aiSpeaking) {
    latencyLog('stt_discarded', `ai_speaking=${aiSpeaking} processing=${isProcessing} empty=${!text}`, trace);
    finishVisualRoundWithoutText(trace);
    return;
  }
  log(`你（語音）：${text}`);
  queueVoiceTranscript(text, trace);
}

async function connectRealtimeStt(generation) {
  if (generation !== realtimeSttGeneration || !vad || !isInCall || isMuted || realtimeSttConnectingGeneration === generation) return;
  realtimeSttConnectingGeneration = generation;
  let session = null;
  let closedBeforeReady = false;
  try {
    sttPcmPending = [];
    sttResamplePos = 0;
    const opened = await openElevenLabsStt(message => {
      if (generation !== realtimeSttGeneration) return;
      if (message.message_type === 'client_closed') {
        if (!session) { closedBeforeReady = true; return; }
        disconnectRealtimeStt(session, 'socket_closed');
        return;
      }
      if (!session || realtimeStt !== session) return;
      realtimeSttLastMessageAt = performance.now();
      if (message.message_type === 'client_error') {
        const error = message.error?.message || message.error || message.message || 'WebSocket error';
        log(`ElevenLabs 語音辨識連線：${error}`);
        disconnectRealtimeStt(session, 'socket_error');
        return;
      }
      handleRealtimeSttMessage(message);
    }, 'manual', undefined, listeningSttAbort?.signal);
    session = opened;
    if (closedBeforeReady || generation !== realtimeSttGeneration || !vad || !isInCall || isMuted) {
      opened.close();
      if (closedBeforeReady) scheduleRealtimeSttReconnect(generation);
      return;
    }
    realtimeStt = opened;
    realtimeSttLastPcmAt = performance.now();
    realtimeSttLastMessageAt = performance.now();
    clearTimeout(realtimeSttStableTimer);
    realtimeSttStableTimer = setTimeout(() => {
      realtimeSttStableTimer = null;
      if (generation === realtimeSttGeneration && realtimeStt === opened) realtimeSttRetryMs = 1000;
    }, 30000);
    if (el('call-status').textContent === '語音辨識重連中⋯') setStatus('聆聽中');
  } catch (error) {
    if (generation === realtimeSttGeneration && vad && isInCall && !isMuted) {
      latencyLog('stt_connection_failed', `mode=live error_type=${error.name} http_status=${error.status || 'na'}`);
      log(`ElevenLabs 語音辨識連線失敗：${error.message}`);
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        setStatus(error.hint || error.message);
      } else scheduleRealtimeSttReconnect(generation);
    }
  } finally {
    if (realtimeSttConnectingGeneration === generation) realtimeSttConnectingGeneration = 0;
  }
}

async function startListening() {
  if (vad || !hasStt() || isMuted || !isInCall) return;
  const generation = ++realtimeSttGeneration;
  const provider = sttProvider();
  const micStartedAt = performance.now();
  latencyLog('mic_start_requested', `provider=${provider} generation=${generation}`);
  realtimeSttRetryMs = 1000;
  clearTimeout(realtimeSttReconnectTimer);
  realtimeSttReconnectTimer = null;
  if (provider === 'elevenlabs') {
    listeningSttAbort?.abort();
    listeningSttAbort = new AbortController();
    void startAudioDiagnostic(generation);
  }
  try {
    const startedVad = await window.createVAD({
      silenceMs: 1800,
      onAudioFrame: provider === 'elevenlabs' ? (frame, rate) => {
        if (generation !== realtimeSttGeneration || !isInCall || isMuted) return;
        sampleAudioDiagnostic('mic', rate, frame, callTraceId);
        sendRealtimeSttFrame(frame, rate);
      } : undefined,
      onSpeechStart: ({ level = 0, threshold = 0, noise = 0 } = {}) => {
        if (generation !== realtimeSttGeneration || !isInCall) return;
        const levels = `rms=${level.toFixed(5)} threshold=${threshold.toFixed(5)} noise=${noise.toFixed(5)}`;
        if (aiSpeaking || isMuted) {
          latencyLog('speech_onset_ignored', `${levels} ai_speaking=${aiSpeaking} muted=${isMuted}`);
          return;
        }
        cancelVivixResponse('vad_onset');
        localSpeechActive = true;
        clearTimeout(voiceTurnTimer);
        if (provider === 'elevenlabs' && realtimePendingUtterance) {
          const pending = takeRealtimePendingUtterance();
          if (realtimeStt) disconnectRealtimeStt(realtimeStt, 'next_speech_before_commit');
          queueRealtimeFallback(pending, 'next_speech_before_commit');
        }
        currentSpeechTrace ||= inputTrace(provider === 'elevenlabs' ? 'elevenlabs_realtime' : 'recording');
        currentSpeechTrace.speechStartedAt = performance.now();
        currentSpeechTrace.liveSamples = 0;
        if (provider === 'elevenlabs') {
          realtimeSpeechActive = true;
          currentSpeechTrace.needsFallback = !realtimeStt;
          if (currentSpeechTrace.needsFallback) currentSpeechTrace.fallbackReason = 'live_not_ready';
        }
        markVisualSpeechStarted(currentSpeechTrace);
        latencyLog('speech_detected', `${levels} trace_age_ms=${Math.round(performance.now() - currentSpeechTrace.startedAt)} path=${currentSpeechTrace.needsFallback ? currentSpeechTrace.fallbackReason : provider} connection=${realtimeStt?.connection || 'na'}`, currentSpeechTrace);
        if (provider === 'elevenlabs') latencyLog('stt_request_started', 'mode=realtime', currentSpeechTrace);
      },
      onVoiceActivity: at => {
        if (generation === realtimeSttGeneration && currentSpeechTrace && !aiSpeaking && !isMuted) currentSpeechTrace.lastVoiceAt = at;
      },
      onLevel: pct => {
        if (Math.abs(pct - lastLevel) < 3) return;
        lastLevel = pct;
        el('tag-voice').textContent = `收音 ${pct}%`;
      },
      onAudioHealth: ({ intervalMs, samples, peak, threshold, noise, context }) => {
        if (generation !== realtimeSttGeneration || !isInCall) return;
        latencyLog('mic_health', `interval_ms=${Math.round(intervalMs)} samples=${samples} peak_rms=${peak.toFixed(5)} threshold=${threshold.toFixed(5)} noise=${noise.toFixed(5)} context=${context} local_speech=${localSpeechActive} ai_speaking=${aiSpeaking} realtime_asr=${!!realtimeStt}`);
      },
      onSpeechEnd: async (blob, { reason = 'unknown', peak = 0, durationMs = 0 } = {}) => {
        if (generation !== realtimeSttGeneration || !isInCall || isMuted) return;
        localSpeechActive = false;
        const stats = `reason=${reason} peak_rms=${peak.toFixed(5)} duration_ms=${Math.round(durationMs)} bytes=${blob.size} live_samples=${currentSpeechTrace?.liveSamples || 0}`;
        if (!blob.size) {
          latencyLog('speech_segment_dropped', `${stats} reason_detail=empty_recording`, currentSpeechTrace);
          realtimeSpeechActive = false;
          if (currentSpeechTrace) finishVisualRoundWithoutText(currentSpeechTrace);
          currentSpeechTrace = null;
          realtimeDeferredTranscript = null;
          scheduleVoiceTurn();
          return;
        }
        latencyLog('speech_local_end', `${stats} silence_ms=${currentSpeechTrace?.lastVoiceAt ? Math.round(performance.now() - currentSpeechTrace.lastVoiceAt) : 'na'} ai_speaking=${aiSpeaking}`, currentSpeechTrace);
        if (provider === 'elevenlabs') {
          const trace = currentSpeechTrace;
          currentSpeechTrace = null;
          realtimeSpeechActive = false;
          const prefix = realtimeDeferredTranscript?.trace === trace ? realtimeDeferredTranscript.text : '';
          realtimeDeferredTranscript = null;
          if (trace && (trace.needsFallback || !realtimeStt)) queueRealtimeFallback({ blob, trace, generation }, trace.fallbackReason || 'live_not_ready');
          else if (trace) {
            const pending = { blob, trace, generation, prefix };
            realtimePendingUtterance = pending;
            pendingVoiceTranscriptions.add(trace);
            const tail = Int16Array.from(sttPcmPending.splice(0));
            if (!realtimeStt.sendPcm(tail.length ? tail : new Int16Array(1600), true)) disconnectRealtimeStt(realtimeStt, 'commit_failed');
            else {
              latencyLog('stt_live_commit_sent', `connection=${realtimeStt.connection} tail_samples=${tail.length} live_samples=${trace.liveSamples || 0} prefix_chars=${prefix.length}`, trace);
              clearTimeout(realtimeCommitTimer);
              realtimeCommitTimer = setTimeout(() => {
                if (realtimePendingUtterance === pending && realtimeStt) disconnectRealtimeStt(realtimeStt, 'commit_timeout');
              }, 5000);
            }
          } else latencyLog('stt_segment_without_trace', stats);
          scheduleVoiceTurn();
          return;
        }
        const trace = currentSpeechTrace || inputTrace('recording');
        currentSpeechTrace = null;
        if (aiSpeaking) {
          log('角色說話中，略過這段收音');
          return;
        }
        pendingVoiceTranscriptions.add(trace);
        try {
          setStatus('辨識中⋯');
          latencyLog('stt_request_started', `bytes=${blob.size}`, trace);
          const text = await transcribe(blob, trace);
          if (generation !== realtimeSttGeneration || !isCurrentTrace(trace) || isMuted) return;
          transcriptReady(trace, text);
          if (!text) {
            finishVisualRoundWithoutText(trace);
            setStatus('聆聽中');
            return;
          }
          log(`你（語音）：${text}`);
          queueVoiceTranscript(text, trace);
        } catch (e) {
          if (generation !== realtimeSttGeneration || !isCurrentTrace(trace) || isMuted) return;
          latencyLog('stt_recording_failed', `error_type=${e.name} http_status=${e.status || 'na'}`, trace);
          log(e.message);
          setSubtitle(e.message);
          setStatus('聆聽中');
        } finally {
          pendingVoiceTranscriptions.delete(trace);
          scheduleVoiceTurn();
        }
      },
    });
    if (generation !== realtimeSttGeneration || isMuted || !isInCall) {
      startedVad.stop();
      return;
    }
    vad = startedVad;
    const settings = vad.trackSettings || {};
    latencyLog('mic_ready', `ms=${Math.round(performance.now() - micStartedAt)} context=${vad.audioContextState || 'na'} sample_rate=${vad.sampleRate || 'na'} channels=${settings.channelCount || 'na'} aec=${settings.echoCancellation ?? 'na'} ns=${settings.noiseSuppression ?? 'na'} agc=${settings.autoGainControl ?? 'na'} noise=${vad.noiseFloor?.toFixed(5) || 'na'} silence_ms=1800`);
    setStatus('聆聽中');
    log('開始收音');
    if (provider === 'elevenlabs') {
      startRealtimeSttWatchdog(generation);
      connectRealtimeStt(generation);
    }
  } catch (e) {
    if (generation !== realtimeSttGeneration) return;
    latencyLog('mic_start_failed', `error_type=${e.name} ms=${Math.round(performance.now() - micStartedAt)}`);
    log(`語音輸入啟動失敗: ${e.message}`);
    setStatus(`語音輸入啟動失敗: ${e.message}`);
  }
}

// ─── 按住說話（網頁版） ─────────────────────────────────

let pttStream = null;
let pttRecorder = null;
let pttStartAt = 0;
let pttPressed = false;
let pttStopTimer = null;

function setupCompactUi() {
  document.body.classList.add('compact-ui');
  ['btn-interrupt', 'action-chips'].forEach(id => el(id)?.classList.add('is-hidden'));
  const btn = el('btn-mute');
  btn.setAttribute('aria-label', '按住說話');
  btn.querySelector('span').textContent = '按住說話';
  btn.addEventListener('pointerdown', e => { e.preventDefault(); startPtt(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => btn.addEventListener(t, stopPtt));
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

async function startPtt() {
  if (!isInCall || pttRecorder || pttPressed) return;
  if (!hasStt()) { setStatus('請先設定語音辨識'); return; }
  pttPressed = true;
  const trace = inputTrace('push_to_talk');
  const generation = realtimeSttGeneration;
  // 按下去就打斷角色，取代原本的打斷按鈕
  cancelVivixResponse('ptt');
  setSubtitle('');
  try {
    if (!pttStream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!pttPressed || !isCurrentTrace(trace) || generation !== realtimeSttGeneration) { stream.getTracks().forEach(t => t.stop()); return; }
      pttStream = stream;
    }
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const mime = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    const rec = new MediaRecorder(pttStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const startedAt = performance.now();
    rec.onstop = () => onPttDone(new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' }), trace, startedAt, generation);
    rec.start();
    pttRecorder = rec;
    pttStopTimer = setTimeout(stopPtt, 30000);
    pttStartAt = performance.now();
    pttTrace = trace;
    pttTrace.speechStartedAt = pttStartAt;
    localSpeechActive = true;
    clearTimeout(voiceTurnTimer);
    markVisualSpeechStarted(pttTrace);
    latencyLog('speech_detected', '', pttTrace);
    el('btn-mute').classList.add('is-talking');
    setStatus('說話中⋯放開送出');
  } catch (e) {
    pttPressed = false;
    if (!isCurrentTrace(trace)) return;
    log(`麥克風失敗: ${e.message}`);
    setStatus(`麥克風失敗: ${e.message}`);
  }
}

function stopPtt() {
  clearTimeout(pttStopTimer);
  pttStopTimer = null;
  pttPressed = false;
  localSpeechActive = false;
  el('btn-mute').classList.remove('is-talking');
  const rec = pttRecorder;
  pttRecorder = null;
  if (rec && rec.state !== 'inactive') {
    if (pttTrace) { pttTrace.lastVoiceAt = performance.now(); latencyLog('speech_local_end', '', pttTrace); }
    rec.stop();
  }
  scheduleVoiceTurn();
}

async function onPttDone(blob, trace = pttTrace, startedAt = pttStartAt, generation = realtimeSttGeneration) {
  if (!isCurrentTrace(trace) || generation !== realtimeSttGeneration) return;
  if (pttTrace === trace) pttTrace = null;
  if (performance.now() - startedAt < 400 || !blob.size) {
    setStatus('按住麥克風說話');
    return;
  }
  pendingVoiceTranscriptions.add(trace);
  try {
    setStatus('辨識中⋯');
    latencyLog('stt_request_started', `bytes=${blob.size}`, trace);
    const text = await transcribe(blob, trace);
    if (!isCurrentTrace(trace) || generation !== realtimeSttGeneration) return;
    transcriptReady(trace, text);
    if (!text) {
      finishVisualRoundWithoutText(trace);
      setStatus('沒聽清楚，再按住說一次');
      return;
    }
    log(`你（語音）：${text}`);
    queueVoiceTranscript(text, trace);
  } catch (e) {
    if (!isCurrentTrace(trace) || generation !== realtimeSttGeneration) return;
    log(e.message);
    setSubtitle(e.message);
    setStatus('按住麥克風說話');
  } finally {
    pendingVoiceTranscriptions.delete(trace);
    scheduleVoiceTurn();
  }
}

function releasePtt() {
  stopPtt();
  if (pttStream) {
    pttStream.getTracks().forEach(t => t.stop());
    pttStream = null;
  }
}

function stopListening() {
  stopAudioDiagnostic();
  lastDiscardedPartial = '';
  if (vad || realtimeSttConnectingGeneration) latencyLog('mic_stopped', `muted=${isMuted} in_call=${isInCall} pending_asr=${pendingVoiceTranscriptions.size}`);
  takeRealtimePendingUtterance();
  clearTimeout(voiceTurnTimer);
  voiceTurnTimer = null;
  voiceTurn = null;
  localSpeechActive = false;
  pendingVoiceTranscriptions.clear();
  realtimeSttGeneration += 1;
  listeningSttAbort?.abort();
  listeningSttAbort = null;
  realtimeSttConnectingGeneration = 0;
  clearTimeout(realtimeSttReconnectTimer);
  realtimeSttReconnectTimer = null;
  clearInterval(realtimeSttWatchdogTimer);
  realtimeSttWatchdogTimer = null;
  clearTimeout(realtimeSttStableTimer);
  realtimeSttStableTimer = null;
  realtimeSpeechActive = false;
  realtimeDeferredTranscript = null;
  realtimeFallbackQueue = [];
  queuedVoiceInputs = [];
  currentSpeechTrace = null;
  setSubtitle('');
  if (vad) {
    vad.stop();
    vad = null;
  }
  if (realtimeStt) {
    const session = realtimeStt;
    realtimeStt = null;
    session.close();
  }
  sttPcmPending = [];
  sttResamplePos = 0;
  lastLevel = -1;
  el('tag-voice').textContent = '';
}

function recoverListeningAfterResume() {
  if (!isInCall || isMuted) return;
  vad?.resume?.().catch(() => {});
  if (sttProvider() !== 'elevenlabs') return;
  if (realtimeStt && performance.now() - realtimeSttLastMessageAt > 8000) {
    disconnectRealtimeStt(realtimeStt, 'resume_after_idle');
  } else if (!realtimeStt && !realtimeSttReconnectTimer) {
    connectRealtimeStt(realtimeSttGeneration);
  }
}

document.addEventListener('visibilitychange', () => {
  if (isInCall) latencyLog('call_visibility_changed', `visible=${document.visibilityState === 'visible'} mic=${!!vad} realtime_asr=${!!realtimeStt}`);
  if (document.visibilityState === 'visible') recoverListeningAfterResume();
});
window.addEventListener('online', recoverListeningAfterResume);
window.addEventListener('error', event => {
  if (isInCall || callStarting) latencyLog('call_uncaught_error', `line=${event.lineno || 0}`);
});
window.addEventListener('unhandledrejection', () => {
  if (isInCall || callStarting) latencyLog('call_unhandled_rejection');
});

// ─── LLM 對話（直接 API 模式） ──────────────────────────

async function chatWithLLM(userMessage, trace) {
  const baseUrl = cfg.llmBase.replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  // 不是叫模型扮演誰：設定是「他自己寫的」，讀進來就是他自己
  const self = cfg.charPrompt ? `以下是你自己寫下的自我設定。這不是劇本，這就是你：\n\n${cfg.charPrompt}` : '';
  const system = [self, SHORT_REPLY_HINT].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, ...chatHistory, { role: 'user', content: userMessage }];

  latencyLog('llm_request_submitted', '', trace);
  const res = await httpJson(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.llmKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: cfg.llmModel,
      messages,
      max_tokens: 300,
    },
  });

  if (!res.ok) {
    throw apiError('模型 API', res.status, res.data);
  }

  const reply = (res.data.choices?.[0]?.message?.content || '').trim();
  if (!isCurrentTrace(trace)) return '';
  latencyLog('llm_reply_received', '', trace);

  chatHistory.push({ role: 'user', content: userMessage });
  chatHistory.push({ role: 'assistant', content: reply });
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

  return reply;
}

// ─── ElevenLabs TTS ─────────────────────────────────────

function audioChunksBase64(chunks) {
  const arrays = chunks.map(chunk => Uint8Array.from(atob(chunk), c => c.charCodeAt(0)));
  const bytes = new Uint8Array(arrays.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of arrays) { bytes.set(part, offset); offset += part.length; }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function openDialogueConnection(model) {
  const url = new URL('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input');
  url.searchParams.set('model_id', model);
  url.searchParams.set('output_format', 'mp3_44100_128');
  const socket = new WebSocket(url);
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const session = { socket, ready, onMessage: null, active: false, final: false, keepAlive: null };
  const timeout = setTimeout(() => {
    rejectReady(new Error('ElevenLabs 語音合成連線逾時'));
    socket.close();
  }, 10000);
  socket.onopen = () => {
    try {
      socket.send(JSON.stringify({ voices: [cfg.elVoice], xi_api_key: cfg.elKey }));
      clearTimeout(timeout);
      resolveReady();
      if (!session.active) session.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ keep_alive: true })); } catch { socket.close(); }
        }
      }, 15000);
    } catch (error) { rejectReady(error); socket.close(); }
  };
  socket.onmessage = event => session.onMessage?.(event);
  socket.onerror = () => {
    const error = new Error('ElevenLabs 語音合成 WebSocket 連線失敗');
    rejectReady(error);
    if (session.active) session.onMessage?.({ data: JSON.stringify({ socket_error: true }) });
  };
  socket.onclose = () => {
    clearTimeout(timeout);
    clearInterval(session.keepAlive);
    rejectReady(new Error('ElevenLabs 語音合成連線已關閉'));
    if (session.active) session.onMessage?.({ data: JSON.stringify({ socket_closed: true }) });
  };
  return session;
}

function prepareDialogueConnection() {
  const model = cfg.elModel || DEFAULT_TTS_MODEL;
  if (!isInCall || cfg.aiMode !== 'mcp' || vivixWs || !useElevenLabs() || !['eleven_v4', 'eleven_v4_turbo'].includes(model)) return;
  if (dialoguePreconnection) return;
  const startedAt = performance.now();
  const session = openDialogueConnection(model);
  dialoguePreconnection = session;
  latencyLog('dialogue_preconnect_started');
  session.ready.then(() => {
    if (dialoguePreconnection === session) latencyLog('dialogue_preconnect_ready', `ms=${Math.round(performance.now() - startedAt)}`);
  }).catch(() => {
    if (dialoguePreconnection === session) dialoguePreconnection = null;
    latencyLog('dialogue_preconnect_failed');
  });
}

function takeDialogueConnection(model, trace) {
  const session = dialoguePreconnection;
  dialoguePreconnection = null;
  const reused = !!session && session.socket.readyState === WebSocket.OPEN && session.socket.url.includes(`model_id=${encodeURIComponent(model)}`);
  if (!reused) session?.socket.close();
  const connection = reused ? session : openDialogueConnection(model);
  clearInterval(connection.keepAlive);
  connection.active = true;
  latencyLog('dialogue_connection', `reused=${reused}`, trace);
  return connection;
}

async function textToDialogueSpeech(text, model, onAudio, trace) {
  const generation = speechGeneration;
  const connection = takeDialogueConnection(model, trace);
  activeDialogueConnection = connection;
  const { socket } = connection;
  const chunks = [];
  let settled = false;
  let firstAudio = true;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // 連線 ready 之前也可能被取消，先接住 done 的拒絕。
  done.catch(() => {});
  const startedAt = performance.now();
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectDone(error); else resolveDone();
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  };
  const timeout = setTimeout(() => finish(new Error('ElevenLabs 語音合成逾時')), 60000);
  connection.cancel = () => finish(new Error('語音合成已取消'));
  connection.onMessage = event => {
    if (generation !== speechGeneration || !isCurrentTrace(trace)) { connection.cancel(); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.error || message.message_type === 'error') {
      finish(new Error(message.error?.message || message.error || message.message || 'ElevenLabs 語音合成失敗'));
    } else if (message.socket_closed || message.socket_error) {
      if (!connection.final) finish(new Error('ElevenLabs 語音合成連線已關閉'));
    } else {
      if (message.audio) {
        if (firstAudio) {
          firstAudio = false;
          latencyLog('tts_first_audio', `ms=${Math.round(performance.now() - startedAt)}`, trace);
        }
        if (onAudio) onAudio(message.audio);
        else chunks.push(message.audio);
      }
      if (message.is_final) {
        connection.final = true;
        latencyLog('tts_generation_done', `ms=${Math.round(performance.now() - startedAt)}`, trace);
        if (firstAudio) finish(new Error('ElevenLabs 沒有返回語音'));
        else finish();
      }
    }
  };
  try {
    await Promise.race([connection.ready, done]);
    if (generation !== speechGeneration || !isCurrentTrace(trace)) throw new Error('語音合成已取消');
    latencyLog('tts_socket_ready', `ms=${Math.round(performance.now() - startedAt)}`, trace);
    socket.send(JSON.stringify({ inputs: [{ text: applyTtsFix(text), voice_id: cfg.elVoice, new_turn: false }] }));
    socket.send(JSON.stringify({ close_socket: true }));
    await done;
    return onAudio ? '' : audioChunksBase64(chunks);
  } catch (error) {
    finish(error);
    throw error;
  } finally {
    connection.onMessage = null;
    connection.cancel = null;
    if (activeDialogueConnection === connection) activeDialogueConnection = null;
  }
}

function createMp3StreamPlayer(trace) {
  if (!window.MediaSource?.isTypeSupported('audio/mpeg')) return null;
  const audio = new Audio();
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;
  let sourceBuffer, queue = [], ended = false, failed = false, started = false;
  let resolveReady, rejectReady, resolveStarted, rejectStarted, resolveEnded, rejectEnded;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const playbackStarted = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const playbackEnded = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
  ready.catch(() => {}); playbackStarted.catch(() => {}); playbackEnded.catch(() => {});
  const fail = error => {
    if (failed) return;
    failed = true;
    queue = [];
    rejectReady(error); rejectStarted(error); rejectEnded(error);
    audio.pause(); URL.revokeObjectURL(objectUrl);
  };
  const start = force => {
    if (started || failed || !sourceBuffer || !sourceBuffer.buffered.length) return;
    const bufferedMs = (sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) - audio.currentTime) * 1000;
    if (!force && bufferedMs < 250) return;
    started = true;
    audio.play().then(() => resolveStarted()).catch(fail);
  };
  const pump = () => {
    if (failed || !sourceBuffer || sourceBuffer.updating) return;
    try {
      if (queue.length) sourceBuffer.appendBuffer(queue.shift());
      else if (ended && mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch (error) { fail(error); }
  };
  mediaSource.addEventListener('sourceopen', () => {
    if (failed) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
      sourceBuffer.addEventListener('updateend', () => { start(ended && !queue.length); pump(); });
      sourceBuffer.addEventListener('error', () => fail(new Error('MP3 串流解碼失敗')));
      resolveReady(); pump();
    } catch (error) { fail(error); }
  }, { once: true });
  audio.onended = () => { URL.revokeObjectURL(objectUrl); resolveEnded(); };
  audio.onerror = () => fail(new Error('串流音訊播放失敗'));
  audio.onwaiting = () => latencyLog('tts_playback_buffering', '', trace);
  audio.onstalled = () => latencyLog('tts_playback_stalled', '', trace);
  return {
    ready, playbackStarted, playbackEnded,
    append(base64) {
      if (failed) return;
      const binary = atob(base64), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      queue.push(bytes); pump();
    },
    finish() { ended = true; pump(); start(true); },
    close() { fail(new Error('語音播放已取消')); },
  };
}

async function textToSpeech(text, trace) {
  const model = cfg.elModel || DEFAULT_TTS_MODEL;
  if (model === 'eleven_v4' || model === 'eleven_v4_turbo') return textToDialogueSpeech(text, model, undefined, trace);
  const res = await httpBase64(`${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(cfg.elVoice)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.elKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: {
      text: applyTtsFix(text),
      model_id: model,
      ...(TTS_LANG_LOCKABLE.includes(model) ? { language_code: 'zh' } : {}),
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
  });

  if (!res.ok) {
    throw apiError('ElevenLabs', res.status, res.data);
  }
  return res.data;
}

// ─── MOSS TTS ───────────────────────────────────────────

// 網頁版：MOSS 不允許網頁直接呼叫，跟 Vivix 一樣交給自己的橋接器轉送
function mossViaRelay() {
  return !isNativeApp && !!relayBase();
}

function mossRequest(input) {
  const viaRelay = mossViaRelay();
  return httpJson(`${viaRelay ? relayUrl('/moss/v1') : MOSS_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.mossKey}`,
      'Content-Type': 'application/json',
      'Platform': 'moss-platform', // 官方範例有帶，照抄
      ...(viaRelay ? { 'X-Relay-Secret': cfg.relaySecret } : {}),
    },
    body: {
      model: cfg.mossModel || DEFAULT_MOSS_MODEL,
      input,
      voice_id: cfg.mossVoice,
      response_format: 'mp3',
      delivery_method: 'url',
    },
  });
}

// 回應格式文件沒寫清楚：先找音檔網址，找不到再找 base64 音檔
function findMossAudio(data) {
  let url = '', b64 = '';
  const walk = (v, key = '') => {
    if (url) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//.test(v) && /url|audio|file|link/i.test(key)) url = v;
      else if (!b64 && v.length > 200 && /audio|data|base64/i.test(key)) b64 = v.replace(/^data:[^,]*,/, '');
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(data);
  return { url, b64 };
}

async function mossSpeech(text) {
  const res = await mossRequest(applyTtsFix(text));
  if (!res.ok) {
    if (res.traceId) log(`MOSS trace_id：${res.traceId}`);
    throw apiError('MOSS', res.status, res.data);
  }
  const { url, b64 } = findMossAudio(res.data);
  if (b64) return b64;
  if (!url) throw new Error(`MOSS 回應裡找不到音檔：${errText(res.data)}`);
  const audio = mossViaRelay()
    ? await httpBase64(relayUrl(`/moss-audio?u=${encodeURIComponent(url)}`), { method: 'GET', headers: { 'X-Relay-Secret': cfg.relaySecret } })
    : await httpBase64(url, { method: 'GET' });
  if (!audio.ok) throw new Error(`MOSS 音檔下載失敗 (${audio.status})`);
  return audio.data;
}

// ─── MiniMax TTS ────────────────────────────────────────

// MiniMax 允許網頁直接呼叫（有 CORS），網頁版和 App 都直連，不用經過橋接器
function minimaxRequest(text) {
  return httpJson(`${MINIMAX_BASE[minimaxRegion()]}/t2a_v2`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.minimaxKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: cfg.minimaxModel || DEFAULT_MINIMAX_MODEL,
      text,
      stream: false,
      language_boost: 'auto',
      output_format: 'hex',
      voice_setting: { voice_id: cfg.minimaxVoice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    },
  });
}

// MiniMax 出錯時 HTTP 常常還是 200，真正的錯誤碼在 base_resp.status_code
const MINIMAX_CODE = { 1002: 429, 1004: 401, 1008: 402, 2049: 401 };

function minimaxError(res) {
  const code = Number(res.data?.base_resp?.status_code);
  if (!res.ok || (code && code !== 0)) {
    const status = MINIMAX_CODE[code] || (res.ok ? 400 : res.status);
    return { status, data: res.data };
  }
  return null;
}

function hexToBase64(hex) {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

async function minimaxSpeech(text) {
  const res = await minimaxRequest(applyTtsFix(text));
  const err = minimaxError(res);
  if (err) {
    if (res.data?.trace_id) log(`MiniMax trace_id：${res.data.trace_id}`);
    throw apiError('MiniMax', err.status, err.data);
  }
  const hex = res.data?.data?.audio;
  if (!hex || typeof hex !== 'string') throw new Error(`MiniMax 回應裡找不到音檔：${errText(res.data)}`);
  return hexToBase64(hex);
}

// ─── 讓角色說話（依序排隊，不互相蓋掉） ─────────────────

function speechSegments(text) {
  if (typeof Intl.Segmenter !== 'function') return [text];
  return [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text)]
    .map(part => part.segment.trim()).filter(Boolean);
}

function playVivixVocal(vocal, action, trace) {
  const socket = vivixWs;
  const generation = speechGeneration;
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', finish);
      if (cancelVivixVocal === finish) cancelVivixVocal = null;
      resolve();
    };
    const onMessage = event => {
      if (socket !== vivixWs || generation !== speechGeneration || !isCurrentTrace(trace)) { finish(); return; }
      try {
        const message = JSON.parse(event.data);
        if (['response.done', 'error', 'session.closed'].includes(message.type)) finish();
      } catch {}
    };
    const timeout = setTimeout(finish, 20000);
    cancelVivixVocal = finish;
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', finish);
    sendToVivix(vocal, action || '自然地說話，帶有微笑');
  });
}

function speak(text, action, replyReceivedAt = 0, trace = inputTrace('assistant'), speechText) {
  const queuedAt = performance.now();
  const generation = speechGeneration;
  const current = () => generation === speechGeneration && isCurrentTrace(trace);
  speakQueue = speakQueue.then(async () => {
    if (!current() || !text) {
      latencyLog('tts_queue_discarded', `reason=${!text ? 'empty' : generation !== speechGeneration ? 'cancelled_generation' : 'inactive_request'}`, trace);
      return;
    }
    latencyLog('tts_queue_started', `queue_ms=${Math.round(performance.now() - queuedAt)}`, trace);
    const model = cfg.elModel || DEFAULT_TTS_MODEL;
    const dialogue = useElevenLabs() && ['eleven_v4', 'eleven_v4_turbo'].includes(model);
    const spokenText = useElevenLabs() && speechText?.trim() ? speechText : text;
    try {
      setSubtitle(text, 'assistant', trace);
      el('tag-action').textContent = action || '';
      setStatus('語音合成中⋯');
      if (dialogue && !vivixWs) {
        const player = createMp3StreamPlayer(trace);
        if (player) {
          activeMp3Player = player;
          const synthesisStartedAt = performance.now();
          latencyLog('tts_request_started', `provider=elevenlabs chars=${spokenText.length}`, trace);
          player.playbackStarted.then(() => {
            if (!current()) return;
            setAiSpeaking(true);
            setStatus('說話中');
            latencyLog('tts_playback_started', `after_reply_ms=${replyReceivedAt ? Math.round(performance.now() - replyReceivedAt) : 'na'} since_voice_ms=${trace.lastVoiceAt ? Math.round(performance.now() - trace.lastVoiceAt) : 'na'}`, trace);
          }).catch(() => {});
          try {
            await player.ready;
            if (!current()) return;
            const synthesis = textToDialogueSpeech(spokenText, model, chunk => {
              if (current()) player.append(chunk);
            }, trace).then(() => { if (current()) player.finish(); });
            await Promise.all([synthesis, player.playbackEnded]);
            if (current()) latencyLog('tts_playback_ended', `ms=${Math.round(performance.now() - synthesisStartedAt)}`, trace);
          } finally {
            player.close();
            if (activeMp3Player === player) activeMp3Player = null;
            if (current()) prepareDialogueConnection();
          }
          return;
        }
      }
      const parts = !vivixWs && !dialogue && (useMoss() || useMinimax() || useElevenLabs())
        ? speechSegments(spokenText) : [spokenText];
      const prepare = async index => {
        if (!current()) return {};
        const part = parts[index], startedAt = performance.now();
        latencyLog('tts_request_started', `provider=${ttsProvider()} part=${index + 1}/${parts.length} chars=${part.length}`, trace);
        try {
          let vocal;
          if (useMoss()) vocal = { type: 'audio', audio: await mossSpeech(part), mime_type: 'audio/mpeg' };
          else if (useMinimax()) vocal = { type: 'audio', audio: await minimaxSpeech(part), mime_type: 'audio/mpeg' };
          else if (useElevenLabs()) vocal = { type: 'audio', audio: await textToSpeech(part, trace), mime_type: 'audio/mpeg' };
          else vocal = { type: 'speech', text: applyTtsFix(part) };
          if (current()) latencyLog(index === 0 ? 'tts_first_audio' : 'tts_vocal_ready', `part=${index + 1}/${parts.length} ms=${Math.round(performance.now() - startedAt)}`, trace);
          return { vocal };
        } catch (error) { return { error }; }
      };
      // 只預取接下來兩段；生成完成順序不決定播放順序。
      const prepared = [prepare(0)];
      if (parts.length > 1) prepared.push(prepare(1));
      for (let index = 0; index < parts.length; index++) {
        const { vocal, error } = await prepared[index];
        if (!current()) return;
        if (error) throw error;
        if (index + 2 < parts.length) prepared[index + 2] = prepare(index + 2);
        setStatus('說話中');
        if (vivixWs?.readyState === WebSocket.OPEN) await playVivixVocal(vocal, action, trace);
        else await playLocalVocal(vocal, trace, replyReceivedAt);
        if (!current()) return;
      }
    } catch (error) {
      if (!current()) return;
      activeDialogueConnection?.cancel?.();
      latencyLog('tts_failed', `error_type=${error.name}`, trace);
      log(`說話失敗: ${error.message}`);
      setSubtitle(`發生錯誤: ${error.message}`);
    } finally {
      if (current()) {
        setAiSpeaking(false);
        setStatus(vad ? '聆聽中' : '等待中');
      }
    }
  });
  return speakQueue;
}

// ─── MCP 橋接模式 ───────────────────────────────────────

// 網頁版放在橋接器上，橋接網址沒填就用目前網址
function relayBase() {
  if (cfg.relayUrl) return cfg.relayUrl.replace(/\/+$/, '');
  return !isNativeApp && location.protocol === 'https:' ? location.origin : '';
}

function relayUrl(path) {
  return `${relayBase()}${path}`;
}

async function relayRequest(path, { method = 'GET', body, timeoutMs } = {}) {
  const res = await httpJson(relayUrl(path), {
    method,
    headers: { 'Authorization': `Bearer ${cfg.relaySecret}`, 'Content-Type': 'application/json' },
    body,
    timeoutMs,
  });
  if (!res.ok) {
    const error = new Error(`橋接錯誤 (${res.status}): ${errText(res.data)}`);
    error.status = res.status;
    throw error;
  }
  return res.data;
}

async function relayEvent(type, text, image, trace, imageSource) {
  trace ||= inputTrace(type === 'message' ? 'quick_action' : type);
  if (type !== 'message') {
    trace.sentAt = performance.now();
    if (type === 'call_started') pendingMcpMessages.set(trace.id, trace);
    latencyLog('mcp_call_event_started', `type=${type}`, trace);
    try {
      const result = await relayRequest('/app/event', { method: 'POST', body: { type, text, session_id: trace.sessionId, call_id: trace.callId, request_id: trace.id, trace_id: trace.id } });
      latencyLog('mcp_call_event_accepted', `type=${type} request_ms=${Math.round(performance.now() - trace.sentAt)} ai_online=${result.ai_online ?? 'unknown'}`, trace);
      return result;
    } catch (error) {
      latencyLog('mcp_call_event_failed', `type=${type} http_status=${error.status || 'na'} error_type=${error.name}`, trace);
      throw error;
    }
  }
  if (!isCurrentTrace(trace)) return { cancelled: true };
  const images = typeof image === 'string'
    ? [{ image, source: imageSource || 'camera' }]
    : Array.isArray(image) ? image : [];
  // Reserve the request before hashing so a newer turn can cancel this pending send.
  for (const pending of pendingMcpMessages.values()) if (pending.id !== trace.id) pending.cancelled = true;
  pendingMcpMessages.set(trace.id, trace);
  if (pendingMcpMessages.size > 100) pendingMcpMessages.delete(pendingMcpMessages.keys().next().value);
  const fingerprintStartedAt = performance.now();
  const imageFingerprints = images.length ? await Promise.all(images.map(frame => imageFingerprint(frame.image))) : [];
  if (!isCurrentTrace(trace) || pendingMcpMessages.get(trace.id) !== trace) {
    if (pendingMcpMessages.get(trace.id) === trace) pendingMcpMessages.delete(trace.id);
    return { cancelled: true };
  }
  trace.imageFingerprints = imageFingerprints;
  const fingerprintMs = Math.round(performance.now() - fingerprintStartedAt);
  trace.sentAt = performance.now();
  images.forEach((frame, index) => {
    latencyLog('visual_image_fingerprint', `index=${index + 1}/${images.length} round=${diagnosticId(frame.roundId)} source=${frame.source || 'camera'} sha256=${imageFingerprints[index] || 'unavailable'} size=${frame.width || 0}x${frame.height || 0} source_size=${frame.sourceWidth ?? 'unknown'}x${frame.sourceHeight ?? 'unknown'} crop=${frame.cropX ?? 'unknown'},${frame.cropY ?? 'unknown'},${frame.cropWidth ?? 'unknown'},${frame.cropHeight ?? 'unknown'} mirrored=${frame.mirrored ?? 'unknown'}`, trace);
  });
  // 新的完整 turn 取代尚未回來的舊回答，連續補充不逐條排成三次播放。
  const payload = { type, text, trace_id: trace.id, request_id: trace.id, call_id: trace.callId, session_id: trace.sessionId };
  if (images.length) {
    payload.image_fingerprints = imageFingerprints;
    payload.images = images.map(frame => ({
      image: frame.image,
      image_source: frame.source === 'screen' ? 'screen' : 'camera',
    }));
    // Older deployed relays only read the single-image fields.
    const legacyImage = payload.images[payload.images.length - 1];
    payload.image = legacyImage.image;
    payload.image_source = legacyImage.image_source;
  }
  latencyLog('mcp_request_started', `source=${trace.source} image_count=${images.length} text_chars=${text?.length || 0} text_shape=${transcriptShape(text)} image_chars=${images.reduce((sum, frame) => sum + frame.image.length, 0)} image_fingerprint_ms=${fingerprintMs} client_image_fingerprints=${fingerprintList(imageFingerprints)}`, trace);
  try {
    const result = await relayRequest('/app/event', { method: 'POST', body: payload });
    const relayFingerprints = result.timing?.client_image_fingerprints || [];
    latencyLog('mcp_message_accepted', `request_ms=${Math.round(performance.now() - trace.sentAt)} diagnostics=${!!result.timing} relay_images=${result.timing?.image_count ?? 'unknown'} client_image_fingerprints=${fingerprintList(imageFingerprints)} relay_echo_fingerprints=${fingerprintList(relayFingerprints)} ai_online=${result.ai_online ?? 'unknown'}`, trace);
    return result;
  } catch (error) {
    pendingMcpMessages.delete(trace.id);
    latencyLog('mcp_request_failed', `request_ms=${Math.round(performance.now() - trace.sentAt)} error_type=${error.name} http_status=${error.status || 'na'}`, trace);
    throw error;
  }
}

// 縮到最長邊 max、轉成 JPEG，給 Vivix 用
function fileToJpegBase64(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
    };
    img.onerror = () => reject(new Error('讀不到這張圖片'));
    img.src = URL.createObjectURL(file);
  });
}

function captureVideoFrame(video, maxChars = MAX_VISUAL_IMAGE_CHARS, maxEdge = 2560, mirrorHorizontally = false, matchPreview = false) {
  if (!video.videoWidth || !video.videoHeight) return undefined;
  const viewportWidth = video.clientWidth || video.videoWidth;
  const viewportHeight = video.clientHeight || video.videoHeight;
  const viewportAspect = matchPreview ? viewportWidth / viewportHeight : video.videoWidth / video.videoHeight;
  const videoAspect = video.videoWidth / video.videoHeight;
  let sourceX = 0, sourceY = 0;
  let sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
  if (videoAspect > viewportAspect) {
    sourceWidth = video.videoHeight * viewportAspect;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else if (videoAspect < viewportAspect) {
    sourceHeight = video.videoWidth / viewportAspect;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }
  for (const edge of [maxEdge, Math.min(maxEdge, 1920), Math.min(maxEdge, 1440)]) {
    const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sourceWidth * scale);
    canvas.height = Math.round(sourceHeight * scale);
    const context = canvas.getContext('2d');
    if (mirrorHorizontally) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.85]) {
      const image = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (image.length <= maxChars) return {
        image, width: canvas.width, height: canvas.height,
        sourceWidth: video.videoWidth, sourceHeight: video.videoHeight,
        cropX: Math.round(sourceX), cropY: Math.round(sourceY),
        cropWidth: Math.round(sourceWidth), cropHeight: Math.round(sourceHeight),
        mirrored: mirrorHorizontally,
      };
    }
  }
  return undefined;
}

// 画面只在用户点发送时采集；共享屏幕时发屏幕帧，否则发摄像头帧。
async function captureVisualFrame() {
  if (nativeScreenSharing) {
    const frame = await cap.nativePromise('ScreenCapture', 'captureFrame', {});
    return frame.active && frame.image && frame.image.length <= MAX_VISUAL_IMAGE_CHARS
      ? { ...frame, source: 'screen' }
      : undefined;
  } else if (screenStream) {
    const frame = captureVideoFrame(el('screen-video'), MAX_VISUAL_IMAGE_CHARS);
    return frame ? { ...frame, source: 'screen' } : undefined;
  }
  const frame = selfStream && !camPaused ? captureSelfFrame() : undefined;
  return frame ? { ...frame, source: 'camera' } : undefined;
}

// 拍攝目前的自拍畫面，僅由「拍一張給他看」按鈕呼叫
function captureSelfFrame() {
  const video = el('self-video');
  if (!selfStream || camPaused) return undefined;
  return captureVideoFrame(video, MAX_VISUAL_IMAGE_CHARS, 2560, selfFacing === 'user', true);
}

async function pollRelay() {
  const pollCallId = callTraceId;
  if (relayPolling === pollCallId) return;
  relayPolling = pollCallId;
  let poll = 0;
  while (isInCall && pollCallId === callTraceId && cfg.aiMode === 'mcp') {
    const pollStartedAt = performance.now();
    poll += 1;
    latencyLog('relay_poll_started', `poll=${poll} after=${relayLastSeq}`);
    try {
      const data = await relayRequest(`/app/replies?after=${relayLastSeq}&wait=25&call_id=${encodeURIComponent(pollCallId)}`, { timeoutMs: 40000 });
      if (!isInCall || pollCallId !== callTraceId) break;
      if (data.diagnostics_version >= 2 && (data.call_id !== callTraceId || data.session_id !== sessionTraceId)) {
        latencyLog('relay_poll_discarded', `poll=${poll} call_match=${data.call_id === callTraceId} session_match=${data.session_id === sessionTraceId}`);
        break;
      }
      latencyLog('relay_poll_completed', `poll=${poll} ms=${Math.round(performance.now() - pollStartedAt)} replies=${data.replies?.length || 0} diagnostics_version=${data.diagnostics_version || 0}`);
      const pending = data.pending_traces || [];
      if (pending.some(item => !item.timing.ai_delivered_at)) {
        setStatus(data.ai_online === false ? '消息已排队，等待 MCP 接收' : '消息已送达桥接，等待 AI 接收⋯');
      } else if (pending.length) setStatus('AI 已收到消息，等待回覆⋯');
      for (const item of data.pending_traces || []) {
        const trace = pendingMcpMessages.get(item.trace_id);
        latencyLog('relay_message_pending', `stage=${item.timing.ai_delivered_at ? 'awaiting_ai_reply' : 'awaiting_ai_pickup'} relay_images=${item.timing.image_count ?? 'unknown'} mcp_images_selected=${item.timing.mcp_images_selected ?? 'unknown'}`, trace || { id: item.trace_id });
        if ((item.timing.image_count || 0) > 0 || (item.timing.mcp_images_selected || 0) > 0) {
          const clientFingerprints = trace?.imageFingerprints || [];
          const relayFingerprints = item.timing.client_image_fingerprints || [];
          const selectedFingerprints = item.timing.mcp_image_fingerprints || [];
          const same = (left, right) => !left.length || !right.length ? 'pending' :
            left.length === right.length && left.every((value, index) => value && value === right[index]);
          latencyLog('mcp_image_delivery_check', `client=${fingerprintList(clientFingerprints)} relay_echo=${fingerprintList(relayFingerprints)} mcp_selected=${fingerprintList(selectedFingerprints)} client_mcp_selected_match=${same(clientFingerprints, selectedFingerprints)} selected=${item.timing.mcp_images_selected ?? 'unknown'}`, trace || { id: item.trace_id });
        }
      }
      relayLastSeq = data.last_seq ?? relayLastSeq;
      for (const r of data.replies || []) {
        relayLastSeq = Math.max(relayLastSeq, r.seq);
        const replyReceivedAt = performance.now();
        const trace = pendingMcpMessages.get(r.trace_id);
        const match = ['explicit_batch', 'single_pending_batch', 'unmatched'].includes(r.trace_match) ? r.trace_match : 'legacy';
        for (const item of r.traces || []) {
          const pending = pendingMcpMessages.get(item.trace_id);
          const t = item.timing;
          if (!t) continue;
          // 只相減同一端的時鐘；手機與 Worker 的絕對時間不能直接相減。
          const serverMs = t.app_dispatched_at - t.edge_received_at;
          latencyLog('relay_stages', `edge_to_room_ms=${t.relay_received_at - t.edge_received_at} enqueue_ms=${t.enqueued_at - t.relay_received_at} ai_pickup_ms=${t.ai_delivered_at - t.enqueued_at} ai_roundtrip_ms=${t.reply_received_at - t.ai_delivered_at} reply_queue_ms=${t.app_dispatched_at - t.reply_received_at} outside_relay_ms=${pending ? Math.round(replyReceivedAt - pending.sentAt - serverMs) : 'na'} already_waiting=${t.ai_wait_started_at <= t.enqueued_at} relay_images=${t.image_count ?? 'unknown'} mcp_images_selected=${t.mcp_images_selected ?? 'unknown'}`, pending || { id: item.trace_id });
        }
        if (!isCurrentTrace(trace) || trace.replyReceived ||
            (r.call_id && r.call_id !== callTraceId) || (r.session_id && r.session_id !== sessionTraceId)) {
          let reason = 'unknown_request';
          if (r.call_id && r.call_id !== callTraceId) reason = 'call_mismatch';
          else if (r.session_id && r.session_id !== sessionTraceId) reason = 'session_mismatch';
          else if (!r.trace_id) reason = 'missing_request_id';
          else if (trace?.replyReceived) reason = 'already_received';
          else if (trace?.cancelled) reason = 'request_cancelled';
          else if (trace) reason = 'inactive_request';
          latencyLog('mcp_reply_discarded', `seq=${r.seq} reason=${reason} match=${match}`, trace || { id: r.trace_id });
          continue;
        }
        trace.replyReceived = true;
        latencyLog('mcp_reply_received', `seq=${r.seq} match=${match} request_ms=${Math.round(replyReceivedAt - trace.sentAt)}`, trace);
        for (const item of r.traces || []) pendingMcpMessages.delete(item.trace_id);
        if (trace) pendingMcpMessages.delete(trace.id);
        log(`角色回覆：${r.text.slice(0, 40)}`);
        speak(r.text, r.action, replyReceivedAt, trace, r.speech_text);
      }
    } catch (e) {
      latencyLog('relay_poll_failed', `poll=${poll} ms=${Math.round(performance.now() - pollStartedAt)} error_type=${e.name} retry_ms=3000`);
      if (!isInCall || pollCallId !== callTraceId) break;
      log(e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (relayPolling === pollCallId) relayPolling = false;
}

// ─── 完整對話管線 ────────────────────────────────────────

async function handleUserInput(text, trace = inputTrace('quick_action')) {
  if (!isCurrentTrace(trace)) return;
  const isVoiceInput = ['elevenlabs_realtime', 'recording', 'push_to_talk'].includes(trace.source);
  if (isProcessing) {
    if (isVoiceInput && text) queuedVoiceInputs.push({ text, trace, callId: callTraceId });
    latencyLog(isVoiceInput && text ? 'input_queued' : 'input_discarded', `processing=true empty=${!text} pending=${queuedVoiceInputs.length}`, trace);
    return;
  }
  const round = visualRound;
  if (round && !round.sent && !round.sending && isVoiceInput) {
    const offset = (trace.latestSpeechOnset ?? speechOnset(trace)) - round.startedAt;
    if (round.imageCount || round.captureInProgress) {
      latencyLog('visual_join_decision', `round=${round.roundId} decision=${offset < 0 ? 'speech_before_capture' : round.imageCount ? 'attach' : 'wait_for_frame'} offset_ms=${Math.round(offset)} count=${round.imageCount}`, trace);
      if (offset >= 0) {
        markVisualSpeechStarted(trace, 'final_voice');
        round.text = text;
        round.trace = trace;
        if (round.imageCount > 0) await sendVisualRound(text, trace);
        return;
      }
    } else if (offset >= 0) clearVisualRound();
  }
  if (!text) { latencyLog('input_discarded', 'processing=false empty=true', trace); return; }
  isProcessing = true;
  activeInputTrace = trace;

  try {
    setSubtitle('');
    el('tag-action').textContent = '';

    if (cfg.aiMode === 'mcp') {
      setStatus('傳送中⋯');
      const result = await relayEvent('message', text, undefined, trace);
      if (!isCurrentTrace(trace)) return;
      setStatus(result.ai_online === false ? '消息已排队，等待 MCP 接收' : '消息已送达桥接，等待 AI 接收⋯');
      return;
    }

    setStatus('思考中⋯');
    const reply = await chatWithLLM(text, trace);
    if (!isCurrentTrace(trace)) return;
    log(`角色回覆：${reply.slice(0, 40)}`);
    await speak(reply, undefined, performance.now(), trace);
  } catch (e) {
    if (!isCurrentTrace(trace)) return;
    log(`管線錯誤: ${e.message}`);
    setStatus(e.hint || '錯誤');
    setSubtitle(`發生錯誤: ${e.message}`);
  } finally {
    if (activeInputTrace === trace) {
      activeInputTrace = null;
      isProcessing = false;
      drainQueuedVoiceInput();
    }
  }
}

async function sendSelfFrame() {
  if (!isInCall) { latencyLog('visual_capture_blocked', 'reason=no_call'); setStatus('請先開始通話'); return; }
  if (cfg.aiMode !== 'mcp') { latencyLog('visual_capture_blocked', 'reason=not_mcp'); setStatus('請切換到 MCP 橋接後發送圖片'); return; }
  if (!selfStream && !isScreenShareActive()) { latencyLog('visual_capture_blocked', 'reason=no_video_source'); setStatus('請先打開攝像頭或共享屏幕'); return; }
  if ((!selfStream || camPaused) && !isScreenShareActive()) { latencyLog('visual_capture_blocked', 'reason=camera_paused'); setStatus('鏡頭暫停中，請先恢復鏡頭'); return; }

  const source = isScreenShareActive() ? 'screen' : 'camera';
  const round = beginVisualRound(crypto.randomUUID(), source);
  let frame;
  try {
    if (source === 'screen' && document.visibilityState !== 'hidden') {
      // ponytail: bound a paused WebView RAF to 250ms; use a native render-complete signal if this still races.
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 250)),
      ]);
    }
    frame = isAndroidApp && nativeScreenSharing
      ? await cap.nativePromise('ScreenCapture', 'captureSnapshot', { roundId: round.roundId })
      : await captureVisualFrame();
  } catch (e) {
    if (visualRound !== round) return;
    latencyLog('visual_capture_failed', `round=${round.roundId} source=${source} reason=capture_exception error_type=${e.name}`);
    round.captureInProgress = false;
    log(`畫面擷取失敗: ${e.message}`);
    round.status = '截图失败，请重试';
    renderVisualRound();
    setStatus('畫面擷取失敗');
    if (round.text) void sendVisualRound(round.text, round.trace || inputTrace('visual_capture_failed'));
    else if (!round.speechTrace) scheduleVisualIdleSend(round);
    return;
  }
  if (visualRound !== round) return;
  if (source === 'screen' && Number.isFinite(frame?.generation)) {
    if (Number.isFinite(round.nativeGeneration) && round.nativeGeneration > frame.generation) return;
    round.nativeGeneration = frame.generation;
  }
  if (!frame?.image) {
    latencyLog('visual_capture_failed', `round=${round.roundId} source=${source} reason=empty_frame`);
    round.captureInProgress = false;
    round.status = '画面还没准备好，请重试';
    renderVisualRound();
    setStatus('畫面還在準備，請稍後再試');
    if (round.text) void sendVisualRound(round.text, round.trace || inputTrace('visual_capture_failed'));
    else if (!round.speechTrace) scheduleVisualIdleSend(round);
    return;
  }
  stageVisualRound({ ...frame, roundId: frame.roundId || round.roundId, source: frame.source || source });
}

function setupNativeVisualCapture() {
  if (!isAndroidApp || !cap.addListener) return;
  cap.addListener('ScreenCapture', 'visualCaptureStarted', event => {
    if (!isInCall) return;
    beginVisualRound(event.roundId, 'screen');
    if (visualRound?.roundId === event.roundId) visualRound.nativeGeneration = event.generation;
  });
  cap.addListener('ScreenCapture', 'visualCaptureReady', event => {
    if (!isInCall) {
      if (event.roundId) cap.nativePromise('ScreenCapture', 'finishVisualRound', { roundId: event.roundId, success: true }).catch(() => {});
      return;
    }
    if (visualRound?.roundId !== event.roundId || visualRound.nativeGeneration !== event.generation) {
      latencyLog('visual_capture_discarded', `source=screen reason=native_round_or_generation_mismatch round=${diagnosticId(event.roundId)} generation=${Number.isSafeInteger(event.generation) ? event.generation : 'na'} active_round=${diagnosticId(visualRound?.roundId)} active_generation=${visualRound?.nativeGeneration ?? 'na'}`);
      return;
    }
    stageVisualRound({ ...event, source: 'screen' });
  });
  cap.addListener('ScreenCapture', 'visualCaptureFailed', event => {
    const round = visualRound;
    if (!isInCall || !round || round.roundId !== event.roundId || round.nativeGeneration !== event.generation) return;
    latencyLog('visual_capture_failed', `round=${round.roundId} source=screen reason=native_failed generation=${round.nativeGeneration}`);
    round.captureInProgress = false;
    round.status = `截图失败：${event.error || '请重试'}`;
    renderVisualRound();
    if (round.text) void sendVisualRound(round.text, round.trace);
    else if (!round.speechTrace) scheduleVisualIdleSend(round);
  });
}

// ─── 開始通話 ────────────────────────────────────────────

async function startCall() {
  if (isInCall || callStarting || callEnding) return;
  cfg = readFormSettings();
  saveSettings(cfg);

  const missing = [];
  if (ttsProvider() === 'elevenlabs') {
    if (!cfg.elKey) missing.push('ElevenLabs API Key');
    if (!cfg.elVoice) missing.push('ElevenLabs Voice ID');
  }
  if (ttsProvider() === 'moss') {
    if (!cfg.mossKey) missing.push('MOSS API Key');
    if (!cfg.mossVoice) missing.push('MOSS 音色 ID');
  }
  if (ttsProvider() === 'minimax') {
    if (!cfg.minimaxKey) missing.push('MiniMax API Key');
    if (!cfg.minimaxVoice) missing.push('MiniMax 音色 ID');
  }
  if (cfg.aiMode === 'mcp') {
    if (!relayBase()) missing.push('橋接網址');
    if (!cfg.relaySecret) missing.push('橋接密碼');
  } else {
    if (!cfg.llmBase) missing.push('模型 Base URL');
    if (!cfg.llmKey) missing.push('模型 API Key');
    if (!cfg.llmModel) missing.push('模型名稱');
  }
  if (!cfg.charImg) missing.push('角色圖片 URL');

  if (missing.length) {
    latencyLog('call_start_blocked', `missing_settings=${missing.length}`);
    log(`還沒填：${missing.join('、')}`);
    setStatus(`還沒填：${missing.join('、')}`);
    el('settings-sheet').classList.remove('is-hidden');
    return;
  }

  callStarting = true;
  const epoch = ++callEpoch;
  const checkStarting = () => { if (epoch !== callEpoch) throw new Error('通話啟動已取消'); };
  clearVisualRound();
  callTraceId = crypto.randomUUID();
  loadCallSession();
  pendingMcpMessages.clear();
  currentSpeechTrace = null;
  isProcessing = false;
  activeInputTrace = null;
  const startTrace = inputTrace('call_started');
  latencyLog('call_started', `diagnostics_version=3 app_log_version=6 mode=${cfg.aiMode === 'mcp' ? 'mcp' : 'direct'} stt=${hasStt() ? sttProvider() : 'off'} compact=${compactUi} vivix=${!!cfg.vivixKey}`, startTrace);

  try {
    setStatus('正在建立連線⋯');
    el('connection-status').textContent = '連線中';
    await setCallScreenAwake(true);
    checkStarting();
    el('character-name').textContent = cfg.charName || '角色';
    if (cfg.vivixKey) {
      latencyLog('call_vivix_started', '', startTrace);
      log('建立 Vivix session⋯');
      try {
        const session = await createVivixSession();
        vivixSessionId = session.session_id;
        checkStarting();
        log(`Vivix session: ${vivixSessionId}`);
        await connectVivixWs(session.control.url, session.control.client_secret);
        checkStarting();
        await enterTrtcRoom(session.delivery.media.trtc);
        checkStarting();
        await startSelfCam();
        checkStarting();
        if (!vivixWs || vivixWs.readyState !== WebSocket.OPEN) throw new Error('Vivix 連線已中斷');
        latencyLog('call_vivix_ready', '', startTrace);
      } catch (e) {
        checkStarting();
        latencyLog('call_vivix_fallback', `error_type=${e.name}`, startTrace);
        await fallbackVivix(e.message);
        checkStarting();
      }
    } else {
      log('未配置 Vivix，使用靜態角色圖通話');
    }
    startTimer();

    isInCall = true;
    await setNativeCallAudioActive(true, startTrace);
    checkStarting();
    latencyLog('call_ui_connected', '', startTrace);
    chatHistory = [];
    updateScreenShareControls();
    el('connection-status').textContent = '已連線';
    setStatus('等待中');
    el('portrait-preview').classList.remove('is-hidden');
    el('call-launcher').classList.add('is-hidden');
    log('通話開始');

    if (cfg.aiMode === 'mcp') {
      prepareDialogueConnection();
      const r = await relayEvent('call_started', undefined, undefined, startTrace);
      if (epoch !== callEpoch) {
        await relayEvent('call_ended', undefined, undefined, { ...startTrace, id: crypto.randomUUID() }).catch(() => {});
      }
      checkStarting();
      relayLastSeq = r.last_seq || 0;
      pollRelay();
    }

    if (hasStt() && compactUi) {
      setStatus('按住麥克風說話');
    } else if (hasStt()) {
      await startListening();
    } else {
      log('沒有設定語音辨識；可使用 MCP 拍照按鈕單獨發送照片');
      setStatus(cfg.aiMode === 'mcp' ? '請設定語音辨識，或拍照發送' : '請設定語音辨識');
    }
  } catch (e) {
    latencyLog('call_start_failed', `error_type=${e.name} http_status=${e.status || 'na'} cancelled=${epoch !== callEpoch}`, startTrace);
    if (e.hint) log(`⚠ ${e.hint}`);
    log(`開始通話失敗: ${e.message}`);
    setStatus(e.hint || '連線失敗');
    el('connection-status').textContent = '失敗';
    await endCall();
  } finally {
    // 啟動中的平台請求不能中止；待其返回後再次收尾，才允許重撥。
    if (epoch !== callEpoch) {
      await closeVivixSession();
      await leaveTrtcRoom();
      stopSelfCam();
    }
    callStarting = false;
  }
}

// ─── 結束通話 ────────────────────────────────────────────

async function endCall() {
  if (callEnding) return;
  callEnding = true;
  try {
    callEpoch += 1;
    const endTrace = inputTrace('call_ended');
    latencyLog('call_ended', `pending_messages=${pendingMcpMessages.size} pending_asr=${pendingVoiceTranscriptions.size}`);
    const wasInCall = isInCall;
    isInCall = false;
    isProcessing = false;
    activeInputTrace = null;
    clearVisualRound();
    stopTimer();
    stopListening();
    releasePtt();
    cancelVivixResponse('hangup');
    dialoguePreconnection?.socket.close();
    dialoguePreconnection = null;
    activeDialogueConnection?.socket.close();
    activeDialogueConnection = null;
    activeMp3Player?.close();
    activeMp3Player = null;
    if (wasInCall && cfg.aiMode === 'mcp') {
      void relayEvent('call_ended', undefined, undefined, endTrace).catch(e => latencyLog('call_end_notification_failed', `error_type=${e.name}`, endTrace));
    }
    await setCallScreenAwake(false);

    if (vivixWs) {
      vivixWs.close();
      vivixWs = null;
    }

    await closeVivixSession();
    await leaveTrtcRoom();
    await setNativeCallAudioActive(false, endTrace);
    stopSelfCam();
    await stopScreenShare();
    updateScreenShareControls();

    setStatus('');
    setSubtitle('');
    el('connection-status').textContent = '';
    el('character-name').textContent = '';
    el('portrait-preview').classList.remove('is-hidden');
    el('call-launcher').classList.remove('is-hidden');
    log('通話結束');
  } finally { callEnding = false; }
}

// ─── 測試連線 ────────────────────────────────────────────

async function probeOne(name, enabled, fn, balanceFn) {
  if (!enabled) {
    log(`⏭ ${name}：沒填，跳過`);
    return `${name}: 未填`;
  }
  try {
    const res = await fn();
    if (res.ok) {
      let bal = '';
      if (balanceFn) { try { bal = await balanceFn(); } catch {} }
      log(`✓ ${name}：連線正常${bal ? `，${bal}` : ''}`);
      return `${name}: OK${bal ? `（${bal}）` : ''}`;
    }
    const hint = res.data?.notRelay || friendlyHint(name, res.status, res.data) || `出錯 (HTTP ${res.status})：${errText(res.data).slice(0, 120)}`;
    log(`❌ ${name}：${hint}`);
    return `${name}: ${hint}`;
  } catch (e) {
    log(`❌ ${name}：${netHint(name, e)}`);
    return `${name}: 連不上`;
  }
}

function modelsUrl(base) {
  const b = base.replace(/\/+$/, '').replace(/\/(chat\/completions|audio\/transcriptions)$/, '');
  return b.endsWith('/models') ? b : `${b}/models`;
}

// Key 本身有問題：就算回 400 也不能算測試通過
const KEY_PROBLEMS = ['money', 'key', 'perm', 'vpn', 'relay'];

// ─── 查餘額（有提供查詢 API 的才查；查不到就不顯示） ───

const money = (n, unit) => `剩 ${unit}${Number(n).toFixed(2)}`;

async function elevenLabsBalance() {
  const r = await httpJson(`${ELEVENLABS_BASE}/user/subscription`, { headers: { 'xi-api-key': cfg.elKey } });
  const d = r.data || {};
  if (!r.ok || d.character_limit == null) return '';
  return `本月剩 ${Math.max(0, d.character_limit - (d.character_count || 0)).toLocaleString()} 字`;
}

async function balanceFor(base, key) {
  let host = '';
  try { host = new URL(base).host; } catch { return ''; }
  const auth = { headers: { 'Authorization': `Bearer ${key}` } };
  if (/deepseek\.com$/.test(host)) {
    const r = await httpJson('https://api.deepseek.com/user/balance', auth);
    const b = r.data?.balance_infos?.[0];
    return r.ok && b ? money(b.total_balance, b.currency === 'USD' ? '$' : '¥') : '';
  }
  if (/siliconflow\.(cn|com)$/.test(host)) {
    const r = await httpJson(`https://${host}/v1/user/info`, auth);
    const d = r.data?.data;
    return r.ok && d?.totalBalance != null ? money(d.totalBalance, '¥') : '';
  }
  if (/moonshot\.(cn|ai)$/.test(host)) {
    const r = await httpJson(`https://${host}/v1/users/me/balance`, auth);
    const d = r.data?.data;
    return r.ok && d?.available_balance != null ? money(d.available_balance, host.endsWith('.cn') ? '¥' : '$') : '';
  }
  if (/openrouter\.ai$/.test(host)) {
    const r = await httpJson('https://openrouter.ai/api/v1/credits', auth);
    const d = r.data?.data;
    return r.ok && d ? money((d.total_credits || 0) - (d.total_usage || 0), '$') : '';
  }
  return '';
}

async function probeConnections() {
  cfg = readFormSettings();
  log('── 開始連線測試 ──');

  const results = [];
  // Vivix 沒有輕量的驗證端點；送空請求，400 代表 Key 有效只是內容不完整
  results.push(await probeOne('Vivix', !!cfg.vivixKey, async () => {
    const r = await httpJson(`${vivixBase()}/realtime-avatar/sessions`, {
      method: 'POST',
      headers: vivixHeaders(),
      body: { model: 'vivix-a1-stream', dry_run: true },
    });
    const ok = (r.ok || r.status === 400 || r.status === 422) && !KEY_PROBLEMS.includes(errKind(r.status, r.data));
    if (r.traceId && !ok) log(`Vivix X-Trace-Id：${r.traceId}`);
    return { ok, status: r.status, data: r.data };
  }));

  // MOSS 沒有輕量的驗證端點；送空字串，400 代表 Key 有效只是內容不完整（不會扣點）
  if (ttsProvider() === 'moss') results.push(await probeOne('MOSS', !!cfg.mossKey, async () => {
    const r = await mossRequest('');
    return { ...r, ok: (r.ok || r.status === 400 || r.status === 422) && !KEY_PROBLEMS.includes(errKind(r.status, r.data)) };
  }));

  // MiniMax 沒有輕量的驗證端點；送空字串，只看是不是 Key 或餘額的問題（不會念出聲音）
  if (ttsProvider() === 'minimax') results.push(await probeOne('MiniMax', !!cfg.minimaxKey, async () => {
    const r = await minimaxRequest('');
    const err = minimaxError(r);
    if (!err) return { ...r, ok: true };
    return { ok: !KEY_PROBLEMS.includes(errKind(err.status, err.data)) && err.status < 500, status: err.status, data: err.data };
  }));

  if (ttsProvider() === 'elevenlabs') results.push(await probeOne('ElevenLabs', !!cfg.elKey, () =>
    httpJson(cfg.elVoice ? `${ELEVENLABS_BASE}/voices/${encodeURIComponent(cfg.elVoice)}` : `${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': cfg.elKey },
    }), elevenLabsBalance));

  if (cfg.aiMode === 'mcp') {
    // 只看 2xx 不夠：填錯成別的 Worker（例如記憶庫）也會回 200，要確認回應長得像橋接器
    results.push(await probeOne('MCP 橋接', !!(cfg.relayUrl && cfg.relaySecret), async () => {
      const r = await httpJson(relayUrl('/app/replies?after=0&wait=0'), {
        headers: { 'Authorization': `Bearer ${cfg.relaySecret}` },
      });
      if (r.ok && !Array.isArray(r.data?.replies)) {
        return { ok: false, status: r.status, data: { notRelay: '這個網址不是 MCP 橋接器（要填 mcp-relay 部署出來的網址）' } };
      }
      return r;
    }));
  } else {
    results.push(await probeOne('模型 API', !!(cfg.llmBase && cfg.llmKey), () =>
      httpJson(modelsUrl(cfg.llmBase), { headers: { 'Authorization': `Bearer ${cfg.llmKey}` } }),
      () => balanceFor(cfg.llmBase, cfg.llmKey)));
  }

  if (sttProvider() === 'elevenlabs') {
    results.push(await probeOne('ElevenLabs Scribe', hasStt(), () =>
      httpJson(`${ELEVENLABS_BASE}/single-use-token/realtime_scribe`, {
        method: 'POST',
        headers: { 'xi-api-key': cfg.sttKey || cfg.elKey },
      })));
  } else {
    results.push(await probeOne('語音辨識', hasStt(), () =>
      httpJson(modelsUrl(cfg.sttBase), { headers: { 'Authorization': `Bearer ${cfg.sttKey}` } }),
      () => balanceFor(cfg.sttBase, cfg.sttKey)));
  }

  el('metrics').textContent = results.join(' ｜ ');
  log('── 連線測試完畢 ──');
}

// ─── 按鈕事件綁定 ────────────────────────────────────────

function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
}

function showConsent() {
  const agreed = hasConsent();
  el('consent-check').checked = agreed;
  el('consent-accept').disabled = !agreed;
  el('consent-accept').textContent = agreed ? '關閉' : '同意並開始使用';
  el('consent').classList.remove('is-hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  latencyLog('call_diagnostics_ready', `app_log_version=6 native_audio_route=android_logcat native=${isAndroidApp} persistent_log=${typeof window.LumeetAudioDiagnostic?.appendLatency === 'function'}`);
  cfg = loadSettings();
  fillForm(cfg);
  setPortrait(cfg.charImg);

  const portrait = el('portrait-preview');
  portrait.addEventListener('error', () => { portrait.style.visibility = 'hidden'; });
  portrait.addEventListener('load', () => { portrait.style.visibility = ''; });

  // 初次使用聲明
  el('consent-check').addEventListener('change', e => {
    el('consent-accept').disabled = !e.target.checked;
  });
  el('consent-accept').addEventListener('click', () => {
    if (!el('consent-check').checked) return;
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch {}
    el('consent').classList.add('is-hidden');
  });
  el('btn-consent').addEventListener('click', showConsent);
  if (!hasConsent()) showConsent();

  // AI 接入方式切換
  document.querySelectorAll('input[name="ai-mode"]').forEach(r => {
    r.addEventListener('change', () => showModeFields(r.value));
  });

  // iOS Safari 防止底部面板展開時頁面捲動（靈魂出竅修正）
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#settings-sheet, #consent')) return;
    e.preventDefault();
  }, { passive: false });

  document.querySelectorAll('input, textarea').forEach(inp => {
    inp.addEventListener('focus', () => {
      setTimeout(() => window.scrollTo(0, 0), 100);
    });
  });

  if (cfg.charName) {
    el('character-name').textContent = cfg.charName;
  }

  // 開始視訊
  el('btn-start').addEventListener('click', startCall);

  // 結束通話
  el('btn-end').addEventListener('click', endCall);

  // 設定面板
  // 語音辨識一鍵帶入：只填網址和模型，Key 還是要自己填
  const STT_PRESETS = {
    groq: { base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    siliconflow: { base: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
  };
  document.querySelectorAll('[data-stt-preset]').forEach(btn => btn.addEventListener('click', () => {
    const p = STT_PRESETS[btn.dataset.sttPreset];
    el('cfg-stt-base').value = p.base;
    el('cfg-stt-model').value = p.model;
    log(`已帶入 ${btn.textContent} 的網址和模型，再填 API Key 後按儲存`);
  }));

  el('cfg-tts-provider').addEventListener('change', e => showTtsProvider(e.target.value));
  el('cfg-stt-provider').addEventListener('change', e => showSttProvider(e.target.value));

  el('btn-copy-mcp').addEventListener('click', async () => {
    const base = el('cfg-relay-url').value.trim().replace(/\/+$/, '') || relayBase();
    const secret = el('cfg-relay-secret').value.trim();
    if (!base || !secret) {
      log('先填橋接網址和橋接密碼，再按複製');
      return;
    }
    const mcpUrl = `${base}/mcp/${secret}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copied = true;
    } catch {
      const t = document.createElement('textarea');
      t.value = mcpUrl;
      document.body.appendChild(t);
      t.select();
      try { copied = document.execCommand('copy'); } catch {}
      t.remove();
    }
    log(copied ? 'MCP 網址已複製，貼到你的 AI 的 MCP 設定' : '複製失敗，請手動組：橋接網址/mcp/橋接密碼');
    if (copied) {
      const btn = el('btn-copy-mcp');
      btn.textContent = '已複製 ✓';
      setTimeout(() => { btn.textContent = '複製 MCP 網址'; }, 2000);
    }
  });

  el('btn-menu').addEventListener('click', () => {
    el('settings-sheet').classList.remove('is-hidden');
  });
  el('btn-close-settings').addEventListener('click', () => {
    el('settings-sheet').classList.add('is-hidden');
  });
  el('settings-sheet').addEventListener('click', (e) => {
    if (e.target === el('settings-sheet')) {
      el('settings-sheet').classList.add('is-hidden');
    }
  });

  // 儲存設定
  el('btn-save-settings').addEventListener('click', () => {
    cfg = readFormSettings();
    saveSettings(cfg);
    setPortrait(cfg.charImg);
    log('設定已儲存');
    el('settings-sheet').classList.add('is-hidden');
  });

  // 測試連線
  el('btn-probe').addEventListener('click', probeConnections);

  // 靜音
  el('btn-mute').addEventListener('click', () => {
    if (compactUi) return;
    isMuted = !isMuted;
    const label = el('btn-mute').querySelector('span');
    label.textContent = isMuted ? '取消靜音' : '靜音';
    latencyLog('call_mute_changed', `muted=${isMuted}`);
    if (isMuted) {
      stopListening();
    } else {
      startListening();
    }
    log(isMuted ? '已靜音' : '已取消靜音');
  });

  // 切換鏡頭
  el('btn-switch-cam').addEventListener('click', async () => {
    if (!selfStream) return;
    const currentFacing = selfStream.getVideoTracks()[0]?.getSettings().facingMode || 'user';
    const newFacing = currentFacing === 'user' ? 'environment' : 'user';
    stopSelfCam();
    if (await startSelfCam(newFacing)) log(`鏡頭切換：${newFacing === 'user' ? '前置' : '後置'}`);
    else await startSelfCam(currentFacing);
  });

  // 攝像頭開關
  el('btn-open-cam').addEventListener('click', async () => {
    if (!isInCall) { setStatus('請先開始通話'); return; }
    if (selfStream) stopSelfCam();
    else await startSelfCam();
  });

  el('btn-share-screen').addEventListener('click', () => {
    if (isScreenShareActive()) void stopScreenShare();
    else void startScreenShare();
  });

  // 拍一張畫面單獨發給 MCP
  el('btn-send-frame').addEventListener('click', sendSelfFrame);
  el('btn-retry-visual').addEventListener('click', () => {
    const round = visualRound;
    if (!round) return;
    if (round.frames.length) void sendVisualRound(round.text, isCurrentTrace(round.trace) ? round.trace : inputTrace('visual_retry'));
    else void sendSelfFrame();
  });
  setupNativeVisualCapture();

  if (compactUi) setupCompactUi();

  // 打斷
  el('btn-interrupt').addEventListener('click', () => {
    latencyLog('call_interrupt_requested');
    cancelVivixResponse('manual_interrupt');
    setStatus('已打斷');
    setSubtitle('');
    log('已打斷角色說話');
  });

  // 暫停鏡頭
  el('btn-pause-cam').addEventListener('click', () => {
    if (!selfStream) return;
    camPaused = !camPaused;
    selfStream.getVideoTracks().forEach(t => { t.enabled = !camPaused; });
    updateCameraControls();
    log(camPaused ? '鏡頭已暫停' : '鏡頭已恢復');
  });

  // 快捷指令
  el('quick-closer')?.addEventListener('click', () => {
    if (isInCall) handleUserInput('靠近一點');
  });
  el('quick-hug')?.addEventListener('click', () => {
    if (isInCall) handleUserInput('抱抱');
  });
  el('quick-kiss')?.addEventListener('click', () => {
    if (isInCall) handleUserInput('親一下');
  });

  // 返回按鈕
  el('btn-back').addEventListener('click', async () => {
    if (isInCall) {
      await endCall();
    }
  });

  // 聲音解鎖（iOS autoplay 限制）
  const soundBtn = el('sound');
  const unlock = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => ctx.close());
    soundBtn.classList.add('is-hidden');
    document.removeEventListener('click', unlock);
  };

  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    soundBtn.classList.remove('is-hidden');
    soundBtn.addEventListener('click', unlock);
  }

  // 角色圖片從裝置上傳：Vivix 只吃公開網址，所以交給 MCP 橋接器保管並產生網址
  el('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    cfg = readFormSettings();
    try {
      const jpeg = await fileToJpegBase64(file, 1024);
      el('portrait-preview').src = `data:image/jpeg;base64,${jpeg}`;
      if (cfg.aiMode !== 'mcp' || !relayBase() || !cfg.relaySecret) {
        log('從裝置上傳需要 MCP 橋接（網址和密碼）；直接 API 模式請填公開圖片網址');
        setStatus('從裝置上傳需要 MCP 橋接');
        return;
      }
      setStatus('上傳角色圖片中⋯');
      const r = await relayRequest('/app/portrait', { method: 'POST', body: { image: jpeg }, timeoutMs: 60000 });
      el('cfg-char-img').value = r.url;
      log('角色圖片已上傳，網址已自動填好，記得按儲存');
      setStatus('角色圖片已上傳，記得按儲存');
    } catch (err) {
      log(`上傳角色圖片失敗: ${err.message}`);
      setStatus('上傳角色圖片失敗');
    }
  });
});
