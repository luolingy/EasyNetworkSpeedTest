const s = {
  url: document.getElementById("s2sUrl"),
  udpPort: document.getElementById("s2sUdpPort"),
  downSize: document.getElementById("s2sDownSize"),
  upSize: document.getElementById("s2sUpSize"),
  udpCount: document.getElementById("s2sUdpCount"),
  run: document.getElementById("s2sRun"),
  btnText: document.getElementById("s2sBtnText"),
  savePeer: document.getElementById("s2sSavePeer"),
  peerList: document.getElementById("peerList"),
  ping: document.getElementById("s2sPing"),
  down: document.getElementById("s2sDown"),
  up: document.getElementById("s2sUp"),
  loss: document.getElementById("s2sLoss"),
  rtt: document.getElementById("s2sRtt"),
  jitter: document.getElementById("s2sJitter"),
  chartDown: document.getElementById("chartS2SDown"),
  chartUp: document.getElementById("chartS2SUp"),
};

const COLORS = { download: "#4facfe", upload: "#00f2fe" };
const state = { running: false, controller: null, downSamples: [], upSamples: [], phaseStart: 0 };

function setPhase(name, status) {
  const el = document.querySelector(`.phase-item[data-phase="${name}"]`);
  if (!el) return;
  el.classList.remove("active", "done", "error");
  if (status === "active") el.classList.add("active");
  if (status === "done") el.classList.add("done");
  if (status === "error") el.classList.add("error");
}

function resetAllPhases() {
  document.querySelectorAll(".phase-item").forEach((el) => el.classList.remove("active", "done", "error"));
}

function drawSamples(canvas, samples, color) {
  window.drawSpeedChart(canvas, samples, color);
}

function setRunning(stateOn) {
  state.running = stateOn;
  s.btnText.textContent = stateOn ? "停止测试" : "开始互联测试";
  s.url.disabled = stateOn;
  s.udpPort.disabled = stateOn;
  s.downSize.disabled = stateOn;
  s.upSize.disabled = stateOn;
  s.udpCount.disabled = stateOn;
  s.savePeer.disabled = stateOn;
}

function resetUI() {
  state.downSamples = [];
  state.upSamples = [];
  s.ping.textContent = "--";
  s.down.textContent = "--";
  s.up.textContent = "--";
  s.loss.textContent = "--";
  s.rtt.textContent = "--";
  s.jitter.textContent = "--";
  drawSamples(s.chartDown, [], COLORS.download);
  drawSamples(s.chartUp, [], COLORS.upload);
}

async function loadPeers() {
  try {
    const res = await fetch("/api/self");
    const data = await res.json();
    const peers = data.peers || [];
    s.peerList.innerHTML = "";
    peers.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "peer-btn";
      btn.textContent = p.name || p.url;
      btn.title = p.url;
      btn.addEventListener("click", () => {
        s.url.value = p.url;
        if (p.udp_port) s.udpPort.value = p.udp_port;
      });
      s.peerList.appendChild(btn);
    });
    if (peers.length === 0) {
      const span = document.createElement("span");
      span.className = "settings-hint";
      span.textContent = "暂无，可输入对端 URL 后点「保存对端」";
      s.peerList.appendChild(span);
    }
  } catch (e) {}
}

async function savePeer() {
  const url = s.url.value.trim();
  if (!url) return;
  try {
    const res = await fetch("/api/peers");
    const data = await res.json();
    const peers = data.peers || [];
    const norm = url.startsWith("http") ? url : "http://" + url;
    if (!peers.find((p) => (p.url || "") === norm)) {
      peers.push({ name: norm, url: norm, udp_port: parseInt(s.udpPort.value, 10) || 5001 });
      await fetch("/api/peers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peers }),
      });
    }
    await loadPeers();
  } catch (e) {}
}

function finish(errMsg) {
  if (errMsg) {
    s.ping.textContent = "失败";
    s.down.textContent = "失败";
    s.up.textContent = "失败";
    s.loss.textContent = "失败";
    document.querySelectorAll(".phase-item").forEach((el) => el.classList.add("error"));
  }
  setRunning(false);
}

async function runS2S() {
  if (state.running) {
    if (state.controller) state.controller.abort();
    finish();
    return;
  }
  const url = s.url.value.trim();
  if (!url) { s.ping.textContent = "请填写对端 URL"; return; }

  state.controller = new AbortController();
  resetUI();
  resetAllPhases();
  setRunning(true);

  const params = new URLSearchParams({
    url,
    udp_port: s.udpPort.value,
    down_size: s.downSize.value,
    up_size: s.upSize.value,
    udp_count: s.udpCount.value,
  });

  try {
    await window.consumeSSE("/api/s2s/run?" + params.toString(), {
      phase: (d) => {
        setPhase(d.name, "active");
        if (d.name === "download" || d.name === "upload") state.phaseStart = performance.now();
      },
      ping: (d) => {
        s.ping.textContent = d.ping_ms + " ms";
        setPhase("ping", "done");
      },
      progress: (d) => {
        if (d.phase === "download") {
          state.downSamples.push({ t: (performance.now() - state.phaseStart) / 1000, mbps: d.mbps });
          drawSamples(s.chartDown, state.downSamples, COLORS.download);
        } else if (d.phase === "upload") {
          state.upSamples.push({ t: (performance.now() - state.phaseStart) / 1000, mbps: d.mbps });
          drawSamples(s.chartUp, state.upSamples, COLORS.upload);
        }
      },
      result: (d) => {
        if (d.phase === "download") {
          s.down.textContent = d.mbps + " Mbps";
          setPhase("download", "done");
        } else if (d.phase === "upload") {
          s.up.textContent = d.mbps + " Mbps";
          setPhase("upload", "done");
        } else if (d.phase === "udp") {
          s.loss.textContent = d.loss_pct + "%";
          s.rtt.textContent = d.avg_rtt_ms != null ? d.avg_rtt_ms + " ms" : "--";
          s.jitter.textContent = d.jitter_ms != null ? d.jitter_ms + " ms" : "--";
          s.loss.style.color = d.loss_pct > 3 ? "var(--red)" : d.loss_pct > 0 ? "var(--yellow)" : "var(--green)";
          setPhase("udp", "done");
        }
      },
      done: () => setRunning(false),
      error: (d) => finish(d.message),
    }, state.controller.signal);
  } catch (err) {
    if (err.name !== "AbortError") finish(err.message);
  } finally {
    if (state.running) setRunning(false);
  }
}

s.run.addEventListener("click", runS2S);
s.savePeer.addEventListener("click", savePeer);
loadPeers();
