// 收音判定：開場量底噪、自動設門檻，手機/桌機通用
// 用法：
//   const vad = await createVAD({
//     onLevel: pct => {},          // 0–100 即時音量，可畫音量條
//     onAudioFrame: (samples, sampleRate) => {}, // 可選的單聲道原始音訊
//     onSpeechStart: () => {},
//     onSpeechEnd: blob => {},     // 一句話的錄音，送 STT
//   });
//   vad.stop();
// 必須在使用者點擊後呼叫（iOS 限制）

(function () {
  const MIN_RMS = 0.006;
  const NOISE_MULT = 2.5;
  const START_MS = 120;
  const MIN_UTTER_MS = 300;

  function wavBlob(frames) {
    const length = frames.reduce((n, frame) => n + frame.length, 0);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const label = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    label(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); label(8, 'WAVE');
    label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, length * 2, true);
    let at = 44;
    for (const frame of frames) for (const sample of frame) { view.setInt16(at, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true); at += 2; }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  window.createVAD = async function ({
    onLevel = () => {},
    onAudioFrame,
    onSpeechStart = () => {},
    onSpeechEnd = () => {},
    onVoiceActivity = () => {},
    onAudioHealth,
    silenceMs = 450,
    calibrateMs = 1000,
    preRollMs = 300,
    maxSpeechMs = 30000,
  } = {}) {
    // autoGainControl 對手機收音影響最大，不開的話手機音量常低到被當底噪
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const resume = () => ctx.resume().catch(() => {});
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (ctx.state !== 'running') {
      // 瀏覽器不讓非點擊觸發的音訊啟動時，等使用者下一次碰螢幕再啟動
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('touchend', resume, { once: true });
    }
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let speaking = false, stopped = false, chunks = [], preRoll = [], preRollLength = 0, resamplePos = 0;
    let healthStartedAt = performance.now(), healthPeak = 0, healthSamples = 0;
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = e => {
      if (stopped) return;
      const frame = e.inputBuffer.getChannelData(0);
      if (onAudioHealth) healthSamples += frame.length;
      onAudioFrame?.(frame, ctx.sampleRate);
      const samples = [];
      let pos = resamplePos;
      for (; pos < frame.length; pos += ctx.sampleRate / 16000) samples.push(frame[Math.floor(pos)]);
      resamplePos = pos - frame.length;
      const pcm = Float32Array.from(samples);
      if (speaking) chunks.push(pcm);
      else {
        preRoll.push(pcm); preRollLength += pcm.length;
        while (preRoll.length && preRollLength - preRoll[0].length >= preRollMs * 16) preRollLength -= preRoll.shift().length;
      }
    };
    src.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);

    const rms = () => {
      analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.sqrt(s / buf.length);
    };

    const calStart = performance.now();
    const samples = [];
    while (performance.now() - calStart < calibrateMs) {
      samples.push(rms());
      await new Promise(r => setTimeout(r, 30));
    }
    samples.sort((a, b) => a - b);
    let noise = samples[Math.floor(samples.length / 2)] || 0;

    let aboveSince = 0, belowSince = 0, speechStartAt = 0, peak = 0, timer = null;

    function startRec() {
      chunks = preRoll;
      preRoll = []; preRollLength = 0;
    }

    function stopRec(keep, stats) {
      const frames = chunks;
      chunks = [];
      if (!stopped) onSpeechEnd(keep && frames.length ? wavBlob(frames) : new Blob([], { type: 'audio/wav' }), stats);
    }

    function tick() {
      const now = performance.now();
      const level = rms();
      const threshold = Math.max(noise * NOISE_MULT, MIN_RMS);
      onLevel(Math.min(100, Math.round((level / (threshold * 3)) * 100)));
      if (onAudioHealth) {
        healthPeak = Math.max(healthPeak, level);
        if (now - healthStartedAt >= 4000) {
          onAudioHealth({ intervalMs: now - healthStartedAt, samples: healthSamples, peak: healthPeak, threshold, noise, context: ctx.state });
          healthStartedAt = now;
          healthPeak = healthSamples = 0;
        }
      }

      if (!speaking) {
        if (level < threshold) noise = noise * 0.98 + level * 0.02;
        if (level > threshold) {
          if (!aboveSince) aboveSince = now;
          if (now - aboveSince >= START_MS) {
            speaking = true;
            speechStartAt = now;
            peak = level;
            belowSince = 0;
            startRec();
            onSpeechStart({ level, threshold, noise });
          }
        } else {
          aboveSince = 0;
        }
      } else if (level < threshold * 0.7) {
        if (!belowSince) belowSince = now;
        if (now - belowSince >= silenceMs) {
          speaking = false;
          aboveSince = 0;
          stopRec(now - speechStartAt - silenceMs >= MIN_UTTER_MS, { reason: 'silence', peak, durationMs: now - speechStartAt });
        }
      } else {
        belowSince = 0;
      }
      if (speaking && now - speechStartAt >= maxSpeechMs) {
        speaking = false; aboveSince = 0; belowSince = 0;
        stopRec(true, { reason: 'max_duration', peak: Math.max(peak, level), durationMs: now - speechStartAt });
      }
      if (speaking) peak = Math.max(peak, level);
      if (speaking && level >= threshold * 0.7) onVoiceActivity(now);
      if (!stopped) timer = setTimeout(tick, 30);
    }
    tick();

    return {
      resume() {
        return ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
        stopRec(false);
        preRoll = [];
        document.removeEventListener('click', resume);
        document.removeEventListener('touchend', resume);
        if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
        if (silentGain) silentGain.disconnect();
        src.disconnect();
        analyser.disconnect();
        stream.getTracks().forEach(t => t.stop());
        ctx.close().catch(() => {});
      },
      get noiseFloor() { return noise; },
      get audioContextState() { return ctx.state; },
      get sampleRate() { return ctx.sampleRate; },
      get trackSettings() { return stream.getAudioTracks?.()[0]?.getSettings?.(); },
    };
  };
})();
