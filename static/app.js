const MB = 1024 * 1024;
const MAX_SIZE_MB = 2000;
const GAUGE_CIRCUMFERENCE = 754;

const COLORS = { download: "#4facfe", upload: "#00f2fe" };

const els = {
  startBtn: document.getElementById("startBtn"),
  btnText: document.getElementById("btnText"),
  btnIconPlay: document.getElementById("btnIconPlay"),
  btnIconStop: document.getElementById("btnIconStop"),
  gaugeSpeed: document.getElementById("gaugeSpeed"),
  gaugePhase: document.getElementById("gaugePhase"),
  gaugeFill: document.getElementById("gaugeFill"),
  gaugePointer: document.getElementById("gaugePointer"),
  downValue: document.getElementById("downValue"),
  upValue: document.getElementById("upValue"),
  pingValue: document.getElementById("pingValue"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  progressInfo: document.getElementById("progressInfo"),
  chartDown: document.getElementById("chartDown"),
  chartUp: document.getElementById("chartUp"),
  downSize: document.getElementById("downSize"),
  upSize: document.getElementById("upSize"),
  modeBtns: Array.from(document.querySelectorAll(".seg-btn")),
};

const CIRC = GAUGE_CIRCUMFERENCE;
let running = false;
let startedOnce = false;
let maxSpeed = 100;
let downSamples = [];
let upSamples = [];
let phaseStart = 0;
let currentMode = "all";
let abortController = null;
let currentXhr = null;
let abortFlag = false;

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function parseSize(input) {
  let v = parseInt(input.value, 10);
  if (isNaN(v) || v < 1) v = 150;
  return Math.max(1, Math.min(MAX_SIZE_MB, v));
}
const getDownMB = () => parseSize(els.downSize);
const getUpMB = () => parseSize(els.upSize);

function setGauge(fraction) {
  const offset = CIRC - Math.max(0, Math.min(1, fraction)) * CIRC;
  els.gaugeFill.style.strokeDashoffset = offset;
  els.gaugePointer.style.strokeDashoffset = offset;
}

function setSpeed(speedMbps, { phase = null } = {}) {
  if (speedMbps > maxSpeed) maxSpeed = speedMbps * 1.15;
  els.gaugeSpeed.textContent = speedMbps.toFixed(1);
  setGauge(speedMbps / maxSpeed);
  if (phase) els.gaugePhase.textContent = phase;
}

function setPhase(text) {
  els.gaugePhase.textContent = text;
}

function setProgress(fraction, label, info) {
  els.progressBar.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
  if (label) els.progressLabel.textContent = label;
  if (info) els.progressInfo.textContent = info;
}

function fmtPct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function phaseSamples(phase) {
  return phase === "download" ? downSamples : upSamples;
}

function pushSample(phase, mbps) {
  phaseSamples(phase).push({ t: (performance.now() - phaseStart) / 1000, mbps });
  drawChart(phase === "download" ? els.chartDown : els.chartUp, phaseSamples(phase), COLORS[phase]);
}

function avgOfPhase(phase) {
  const ph = phaseSamples(phase);
  if (!ph.length) return null;
  return ph.reduce((a, s) => a + s.mbps, 0) / ph.length;
}

/* ---------------- 测试单元 ---------------- */

async function measurePing(signal) {
  const samplesPing = [];
  for (let i = 0; i < 3; i++) {
    if (signal && signal.aborted) throw abortError();
    const t0 = performance.now();
    await fetch("/ping", { cache: "no-store", signal });
    samplesPing.push(performance.now() - t0);
  }
  samplesPing.sort((a, b) => a - b);
  return samplesPing[Math.floor(samplesPing.length / 2)];
}

async function testDownload(sizeMB, onSpeed, signal) {
  const res = await fetch(`/download?size=${sizeMB}`, { cache: "no-store", signal });
  if (!res.ok || !res.body) throw new Error("下载请求失败");
  const reader = res.body.getReader();
  let received = 0;
  const t0 = performance.now();
  let lastUpdate = t0;
  let lastBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    const now = performance.now();
    const dt = (now - lastUpdate) / 1000;
    if (dt >= 0.25) {
      const mbps = ((received - lastBytes) * 8) / (dt * 1e6);
      onSpeed(mbps);
      lastUpdate = now;
      lastBytes = received;
    }
  }
  const elapsed = (performance.now() - t0) / 1000;
  return { received, elapsed, avg: (received * 8) / (elapsed * 1e6) };
}

function generateRandomData(sizeBytes, onProgress, signal) {
  return new Promise((resolve) => {
    const chunkSize = 2 * 1024 * 1024;
    const parts = [];
    let remaining = sizeBytes;
    function next() {
      if (signal && signal.aborted) {
        resolve(null);
        return;
      }
      if (remaining <= 0) {
        resolve(new Blob(parts, { type: "application/octet-stream" }));
        return;
      }
      const len = Math.min(chunkSize, remaining);
      const u8 = new Uint8Array(len);
      for (let i = 0; i < len; i++) u8[i] = (Math.random() * 256) | 0;
      parts.push(u8);
      remaining -= len;
      onProgress(sizeBytes - remaining, sizeBytes);
      setTimeout(next, 0);
    }
    next();
  });
}

function testUpload(blob, onSpeed, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentXhr = xhr;
    xhr.open("POST", "/upload");
    xhr.responseType = "json";
    const t0 = performance.now();
    let lastUpdate = t0;
    let lastBytes = 0;

    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now = performance.now();
      const dt = (now - lastUpdate) / 1000;
      if (dt >= 0.25) {
        const mbps = ((e.loaded - lastBytes) * 8) / (dt * 1e6);
        onSpeed(mbps);
        lastUpdate = now;
        lastBytes = e.loaded;
      }
    };

    xhr.onload = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      currentXhr = null;
      const server = xhr.response || {};
      const elapsed = (performance.now() - t0) / 1000;
      const effective = (server.elapsed_ms || elapsed * 1000) / 1000;
      resolve({ elapsed: effective, avg: (blob.size * 8) / (effective * 1e6) });
    };
    xhr.onabort = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      currentXhr = null;
      reject(abortError());
    };
    xhr.onerror = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      currentXhr = null;
      reject(new Error("上传请求失败"));
    };
    xhr.send(blob);
  });
}

/* ---------------- 图表 ---------------- */

function drawChart(canvas, samples, color) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(rect.width, 10);
  const H = Math.max(rect.height, 10);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 46, padR = 10, padT = 12, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let maxY = 10;
  samples.forEach((s) => { if (s.mbps > maxY) maxY = s.mbps; });
  maxY = maxY * 1.15;
  let maxT = samples.length ? samples[samples.length - 1].t : 1;
  maxT = Math.max(maxT, 1);

  const xOf = (t) => padL + (t / maxT) * plotW;
  const yOf = (v) => padT + plotH - (v / maxY) * plotH;

  ctx.font = "10px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.fillStyle = "rgba(139,150,176,0.9)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 4) * i;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v >= 100 ? v.toFixed(0) : v.toFixed(1), padL - 6, y + 3);
  }
  ctx.textAlign = "center";
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = (maxT / steps) * i;
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(t.toFixed(1) + "s", x, H - 5);
  }

  if (samples.length > 1) {
    ctx.beginPath();
    ctx.moveTo(xOf(samples[0].t), yOf(samples[0].mbps));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(xOf(samples[i].t), yOf(samples[i].mbps));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(xOf(samples[0].t), padT + plotH);
    ctx.lineTo(xOf(samples[0].t), yOf(samples[0].mbps));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(xOf(samples[i].t), yOf(samples[i].mbps));
    ctx.lineTo(xOf(samples[samples.length - 1].t), padT + plotH);
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

window.addEventListener("resize", () => {
  drawChart(els.chartDown, downSamples, COLORS.download);
  drawChart(els.chartUp, upSamples, COLORS.upload);
});

window.drawSpeedChart = drawChart;

function drawRttChart(canvas, packets, color) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(rect.width, 10);
  const H = Math.max(rect.height, 10);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 46, padR = 10, padT = 12, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let maxY = 10;
  packets.forEach((p) => { if (p.rtt != null && p.rtt > maxY) maxY = p.rtt; });
  maxY = maxY * 1.15;
  const count = Math.max(packets.length, 1);
  const xOf = (i) => padL + (i / Math.max(count - 1, 1)) * plotW;
  const yOf = (v) => padT + plotH - (v / maxY) * plotH;

  ctx.font = "10px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.fillStyle = "rgba(139,150,176,0.9)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 4) * i;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(1), padL - 6, y + 3);
  }
  ctx.textAlign = "center";
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const idx = Math.round((count - 1) * (i / steps));
    const x = xOf(idx);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(idx + "", x, H - 5);
  }

  let pen = false;
  ctx.beginPath();
  packets.forEach((p, i) => {
    if (p.rtt == null) { pen = false; return; }
    const x = xOf(i);
    const y = yOf(p.rtt);
    if (!pen) { ctx.moveTo(x, y); pen = true; }
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}
window.drawRttChart = drawRttChart;

async function consumeSSE(url, handlers, signal) {
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok || !res.body) throw new Error("连接失败 (HTTP " + res.status + ")");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      let payload = {};
      try { payload = data ? JSON.parse(data) : {}; } catch (e) {}
      if (handlers[event]) handlers[event](payload);
    }
  }
}
window.consumeSSE = consumeSSE;

/* ---------------- 运行控制 ---------------- */

function setRunning(state) {
  running = state;
  els.startBtn.disabled = false;
  els.btnText.textContent = state ? "停止测试" : startedOnce ? "重新测试" : "开始测试";
  els.btnIconPlay.style.display = state ? "none" : "block";
  els.btnIconStop.style.display = state ? "block" : "none";
  els.downSize.disabled = state;
  els.upSize.disabled = state;
  els.modeBtns.forEach((b) => (b.disabled = state));
}

function requestStop() {
  abortFlag = true;
  if (abortController) abortController.abort();
  if (currentXhr) currentXhr.abort();
}

function resetUI() {
  maxSpeed = 100;
  downSamples = [];
  upSamples = [];
  setGauge(0);
  els.downValue.textContent = "--";
  els.upValue.textContent = "--";
  els.pingValue.textContent = "--";
  els.pingValue.style.color = "";
  drawChart(els.chartDown, [], COLORS.download);
  drawChart(els.chartUp, [], COLORS.upload);
}

function finishAborted() {
  const down = avgOfPhase("download");
  const up = avgOfPhase("upload");
  if (down != null) els.downValue.textContent = down.toFixed(1);
  if (up != null) els.upValue.textContent = up.toFixed(1);
  setPhase("已终止");
  setProgress(0, "测试已终止", "部分数据已保留");
  setSpeed(0);
  saveHttpHistory({
    mode: currentMode,
    ping_ms: els.pingValue.textContent !== "--" ? parseFloat(els.pingValue.textContent) : null,
    download_mbps: down,
    upload_mbps: up,
    details: { down_mb: getDownMB(), up_mb: getUpMB(), aborted: true },
  });
}

async function runTest() {
  if (running) return;
  startedOnce = true;
  abortController = new AbortController();
  abortFlag = false;
  const mode = currentMode;
  const downMB = getDownMB();
  const upMB = getUpMB();
  let ping = null;
  let downAvg = null;
  let upAvg = null;
  resetUI();
  setRunning(true);

  try {
    setPhase("延迟测试");
    setProgress(0.02, "正在测量延迟", "Ping × 3");
    ping = await measurePing(abortController.signal);
    els.pingValue.textContent = ping.toFixed(0);
    els.pingValue.style.color = ping < 30 ? "var(--green)" : ping < 80 ? "var(--yellow)" : "var(--red)";
    setPhase(`延迟 ${ping.toFixed(0)} ms`);

    if (mode === "all" || mode === "download") {
      phaseStart = performance.now();
      setPhase("下载测试");
      setProgress(0, `下载测试开始`, `${downMB} MB`);
      const down = await testDownload(downMB, (s) => {
        setSpeed(s, { phase: "下载中" });
        pushSample("download", s);
      }, abortController.signal);
      if (abortFlag) { finishAborted(); return; }
      downAvg = down.avg;
      els.downValue.textContent = downAvg.toFixed(1);
      setPhase("下载完成");
      setProgress(0, "下载完成", "准备上传数据...");
    }

    if (mode === "all" || mode === "upload") {
      setPhase("准备数据");
      setProgress(0, `正在生成 ${upMB}MB 随机测试数据...`, "浏览器本地生成");
      const blob = await generateRandomData(upMB * MB, (done, total) => {
        setProgress(done / total, `正在生成 ${upMB}MB 随机测试数据...`, fmtPct(done / total));
      }, abortController.signal);
      if (abortFlag || !blob) { finishAborted(); return; }

      phaseStart = performance.now();
      setPhase("上传测试");
      setProgress(0, `上传测试开始`, `${upMB} MB`);
      const up = await testUpload(blob, (s) => {
        setSpeed(s, { phase: "上传中" });
        pushSample("upload", s);
      }, abortController.signal);
      if (abortFlag) { finishAborted(); return; }
      upAvg = up.avg;
      els.upValue.textContent = upAvg.toFixed(1);
    }

    setPhase("测试完成");
    setProgress(1, "测试完成", "测试已完成");
    setSpeed(0);
    saveHttpHistory({
      mode,
      ping_ms: ping,
      download_mbps: downAvg,
      upload_mbps: upAvg,
      details: { down_mb: downMB, up_mb: upMB },
    });
  } catch (err) {
    if (err.name === "AbortError" || abortFlag) {
      finishAborted();
    } else {
      console.error(err);
      setPhase("测试失败");
      setProgress(0, `测试失败：${err.message}`, "请检查服务器连接后重试");
    }
  } finally {
    setRunning(false);
  }
}

els.startBtn.addEventListener("click", () => (running ? requestStop() : runTest()));
els.modeBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    if (running) return;
    currentMode = btn.dataset.mode;
    els.modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
  })
);

/* ---------------- 历史保存 ---------------- */

async function saveHttpHistory(rec) {
  try {
    await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "http", ...rec }),
    });
  } catch (e) {}
}

/* ---------------- 页面初始化 ---------------- */

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  })
);

fetch("/api/self")
  .then((r) => r.json())
  .then((d) => {
    const s = d.self || {};
    const label = document.getElementById("serverLabel");
    label.textContent = `${s.ip || "?"}:${s.http_port || 5000} · UDP :${s.udp_port || 5001}`;
    label.title = `主机名: ${s.hostname || ""}`;
  })
  .catch(() => {
    document.getElementById("serverLabel").textContent = "本服务器";
  });
