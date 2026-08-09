const h = {
  body: document.getElementById("historyBody"),
  filter: document.getElementById("historyFilter"),
  refresh: document.getElementById("historyRefresh"),
  clear: document.getElementById("historyClear"),
};

const TYPE_NAMES = { http: "HTTP 测速", s2s: "服务器互联", udp: "UDP 测试" };

function esc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(v, digits = 2) {
  return v == null || v === "" ? "-" : Number(v).toFixed(digits);
}

function render(rows) {
  if (!rows.length) {
    h.body.innerHTML = '<tr><td colspan="8" class="empty-row">暂无记录</td></tr>';
    return;
  }
  h.body.innerHTML = rows
    .map((r) => {
      const typeName = TYPE_NAMES[r.type] || r.type;
      const peer = r.peer ? r.peer.replace(/^https?:\/\//, "") : "-";
      return `<tr>
        <td>${esc(r.ts)}</td>
        <td><span class="type-badge type-${esc(r.type)}">${esc(typeName)}</span></td>
        <td title="${esc(r.peer || "")}">${esc(peer)}</td>
        <td>${fmtNum(r.ping_ms)}</td>
        <td>${fmtNum(r.download_mbps)}</td>
        <td>${fmtNum(r.upload_mbps)}</td>
        <td>${fmtNum(r.udp_loss)}</td>
        <td>${fmtNum(r.udp_rtt_ms)}</td>
      </tr>`;
    })
    .join("");
}

async function loadHistory() {
  const type = h.filter.value;
  const url = type ? `/api/history?type=${encodeURIComponent(type)}` : "/api/history";
  try {
    const res = await fetch(url);
    render(await res.json());
  } catch (e) {
    h.body.innerHTML = '<tr><td colspan="8" class="empty-row">加载失败</td></tr>';
  }
}

async function clearHistory() {
  if (!confirm("确定清空全部历史记录？")) return;
  try {
    await fetch("/api/history/clear", { method: "POST" });
    await loadHistory();
  } catch (e) {}
}

h.filter.addEventListener("change", loadHistory);
h.refresh.addEventListener("click", loadHistory);
h.clear.addEventListener("click", clearHistory);
loadHistory();
