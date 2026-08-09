const u = {
  host: document.getElementById("udpHost"),
  port: document.getElementById("udpPort"),
  count: document.getElementById("udpCount"),
  size: document.getElementById("udpSize"),
  interval: document.getElementById("udpInterval"),
  start: document.getElementById("udpStart"),
  btnText: document.getElementById("udpBtnText"),
  loss: document.getElementById("udpLoss"),
  avg: document.getElementById("udpAvg"),
  minMax: document.getElementById("udpMinMax"),
  jitter: document.getElementById("udpJitter"),
  counts: document.getElementById("udpCounts"),
  chart: document.getElementById("chartUdp"),
};

const COLORS = { download: "#4facfe", upload: "#00f2fe" };

const state = { running: false, controller: null, packets: [] };

function fmt(v, digits = 2) {
  return v == null ? "--" : v.toFixed(digits);
}

function liveStats() {
  const sent = state.packets.length;
  const rtts = state.packets.filter((p) => p.rtt != null).map((p) => p.rtt);
  const received = rtts.length;
  const loss = sent > 0 ? ((sent - received) / sent) * 100 : 0;
  u.loss.textContent = fmt(loss) + "%";
  u.counts.textContent = `${sent} / ${received}`;
  if (rtts.length) {
    const sum = rtts.reduce((a, b) => a + b, 0);
    const avg = sum / rtts.length;
    const variance = rtts.reduce((a, b) => a + (b - avg) * (b - avg), 0) / rtts.length;
    u.avg.textContent = fmt(avg);
    u.minMax.textContent = `${fmt(Math.min(...rtts))} / ${fmt(Math.max(...rtts))}`;
    u.jitter.textContent = fmt(Math.sqrt(variance));
    const color = loss > 3 ? "var(--red)" : loss > 0 ? "var(--yellow)" : "var(--green)";
    u.loss.style.color = color;
  }
}

function setRunning(stateOn) {
  state.running = stateOn;
  u.btnText.textContent = stateOn ? "停止测试" : "开始 UDP 测试";
  u.host.disabled = stateOn;
  u.port.disabled = stateOn;
  u.count.disabled = stateOn;
  u.size.disabled = stateOn;
  u.interval.disabled = stateOn;
}

function resetUI() {
  state.packets = [];
  u.loss.textContent = "--";
  u.avg.textContent = "--";
  u.minMax.textContent = "--";
  u.jitter.textContent = "--";
  u.counts.textContent = "--";
  u.loss.style.color = "";
  window.drawRttChart(u.chart, [], COLORS.download);
}

function finish(errMsg) {
  if (errMsg) {
    u.loss.textContent = "失败";
    u.avg.textContent = "失败";
    u.minMax.textContent = errMsg;
    u.jitter.textContent = "--";
  }
  setRunning(false);
}

async function runUdp() {
  if (state.running) {
    if (state.controller) state.controller.abort();
    finish();
    return;
  }
  state.controller = new AbortController();
  resetUI();
  setRunning(true);

  const params = new URLSearchParams({
    host: u.host.value.trim(),
    port: u.port.value,
    count: u.count.value,
    size: u.size.value,
    interval: u.interval.value,
  });

  try {
    await window.consumeSSE("/api/udp/run?" + params.toString(), {
      packet: (d) => {
        state.packets.push({ rtt: d.rtt_ms });
        window.drawRttChart(u.chart, state.packets, COLORS.download);
        liveStats();
      },
      result: (d) => {
        u.loss.textContent = fmt(d.loss_pct) + "%";
        u.avg.textContent = d.avg_rtt_ms != null ? fmt(d.avg_rtt_ms) : "--";
        u.minMax.textContent = d.min_rtt_ms != null ? `${fmt(d.min_rtt_ms)} / ${fmt(d.max_rtt_ms)}` : "--";
        u.jitter.textContent = d.jitter_ms != null ? fmt(d.jitter_ms) : "--";
        u.counts.textContent = `${d.sent} / ${d.received}`;
        const color = d.loss_pct > 3 ? "var(--red)" : d.loss_pct > 0 ? "var(--yellow)" : "var(--green)";
        u.loss.style.color = color;
      },
      error: (d) => finish(d.message),
    }, state.controller.signal);
  } catch (err) {
    if (err.name !== "AbortError") finish(err.message);
  } finally {
    if (state.running) setRunning(false);
  }
}

u.start.addEventListener("click", runUdp);
