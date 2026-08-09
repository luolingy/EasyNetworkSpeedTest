import json
import os
import queue
import socket
import sqlite3
import statistics
import struct
import threading
import time
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "speedtest.db"
CONFIG_PATH = BASE_DIR / "config.json"

CHUNK_SIZE = 1024 * 1024
MAX_SIZE_MB = 2000
DEFAULT_SIZE_MB = 150
UDP_PORT = int(os.environ.get("SPEED_UDP_PORT", 5001))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = (MAX_SIZE_MB + 512) * 1024 * 1024


# ---------------- 数据库 / 配置 ----------------

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            type TEXT NOT NULL,
            peer TEXT,
            mode TEXT,
            ping_ms REAL,
            download_mbps REAL,
            upload_mbps REAL,
            udp_loss REAL,
            udp_rtt_ms REAL,
            udp_jitter_ms REAL,
            details TEXT
        )"""
    )
    conn.commit()
    conn.close()


def save_history(rec):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """INSERT INTO history (ts,type,peer,mode,ping_ms,download_mbps,upload_mbps,udp_loss,udp_rtt_ms,udp_jitter_ms,details)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            time.strftime("%Y-%m-%d %H:%M:%S"),
            rec.get("type", "http"),
            rec.get("peer"),
            rec.get("mode"),
            rec.get("ping_ms"),
            rec.get("download_mbps"),
            rec.get("upload_mbps"),
            rec.get("udp_loss"),
            rec.get("udp_rtt_ms"),
            rec.get("udp_jitter_ms"),
            json.dumps(rec.get("details", {}), ensure_ascii=False),
        ),
    )
    conn.commit()
    conn.close()


def list_history(type_filter=None, limit=200):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if type_filter:
        rows = conn.execute(
            "SELECT * FROM history WHERE type=? ORDER BY id DESC LIMIT ?", (type_filter, limit)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_history():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM history")
    conn.commit()
    conn.close()


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    seed = [u.strip() for u in os.environ.get("SPEED_PEER", "").split(",") if u.strip()]
    cfg = {"peers": [{"name": u, "url": u} for u in seed]}
    save_config(cfg)
    return cfg


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def self_info():
    host = socket.gethostname()
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    if not ips:
        ips.append("127.0.0.1")
    return {"hostname": host, "ip": ips[0], "http_port": int(os.environ.get("SPEED_PORT", 5000)), "udp_port": UDP_PORT}


init_db()


# ---------------- 随机数据 ----------------

def random_stream(size_mb):
    remaining = size_mb * 1024 * 1024
    while remaining > 0:
        chunk = os.urandom(min(CHUNK_SIZE, remaining))
        remaining -= len(chunk)
        yield chunk


# ---------------- UDP 回显服务器 ----------------

def udp_server(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
    except OSError as e:
        print(f"[udp] bind failed: {e}")
        return
    print(f"[udp] echo server listening on udp :{port}")
    while True:
        try:
            data, addr = s.recvfrom(65535)
            s.sendto(data, addr)
        except OSError:
            continue


def start_udp():
    t = threading.Thread(target=udp_server, args=(UDP_PORT,), daemon=True)
    t.start()


def udp_probe_stream(host, port, count, size, interval, timeout):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    for seq in range(count):
        payload = struct.pack("!I", seq) + os.urandom(max(size - 4, 0))
        t0 = time.monotonic()
        rtt = None
        try:
            sock.sendto(payload, (host, port))
            sock.recvfrom(size + 64)
            rtt = (time.monotonic() - t0) * 1000
        except (socket.timeout, OSError):
            pass
        yield seq, rtt is not None, rtt
        if interval > 0:
            time.sleep(interval)
    sock.close()


def udp_stats(count, rtts):
    sent = count
    received = len(rtts)
    if rtts:
        return {
            "sent": sent,
            "received": received,
            "loss_pct": round((sent - received) / sent * 100, 2) if sent else 0,
            "avg_rtt_ms": round(statistics.mean(rtts), 2),
            "min_rtt_ms": round(min(rtts), 2),
            "max_rtt_ms": round(max(rtts), 2),
            "jitter_ms": round(statistics.pstdev(rtts), 2),
        }
    return {
        "sent": sent,
        "received": received,
        "loss_pct": 100.0,
        "avg_rtt_ms": None,
        "min_rtt_ms": None,
        "max_rtt_ms": None,
        "jitter_ms": None,
    }


def udp_probe(host, port, count, size, interval, timeout):
    rtts = []
    for _seq, _ok, rtt in udp_probe_stream(host, port, count, size, interval, timeout):
        if rtt is not None:
            rtts.append(rtt)
    return udp_stats(count, rtts)


# ---------------- 服务器互联（S2S） ----------------

def s2s_ping(peer_url):
    t0 = time.monotonic()
    requests.get(peer_url.rstrip("/") + "/ping", timeout=15)
    return round((time.monotonic() - t0) * 1000, 2)


def s2s_download(peer_url, size_mb, on_progress=None):
    with requests.get(peer_url.rstrip("/") + "/download", params={"size": size_mb}, stream=True, timeout=(10, 600)) as r:
        r.raise_for_status()
        total = 0
        t0 = time.monotonic()
        last = t0
        lastb = 0
        for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
            if not chunk:
                continue
            total += len(chunk)
            now = time.monotonic()
            if on_progress and now - last >= 0.25:
                dt = now - last
                on_progress(((total - lastb) * 8) / (dt * 1e6))
                last = now
                lastb = total
        elapsed = time.monotonic() - t0
    return {"received": total, "elapsed_ms": round(elapsed * 1000, 2), "mbps": round((total * 8) / (elapsed * 1e6), 2)}


def s2s_upload(peer_url, size_mb, on_progress=None):
    total = size_mb * 1024 * 1024

    def gen():
        remaining = total
        sent = 0
        t0 = time.monotonic()
        last = t0
        lastb = 0
        while remaining > 0:
            c = os.urandom(min(CHUNK_SIZE, remaining))
            remaining -= len(c)
            sent += len(c)
            now = time.monotonic()
            if on_progress and now - last >= 0.25:
                dt = now - last
                on_progress(((sent - lastb) * 8) / (dt * 1e6))
                last = now
                lastb = sent
            yield c

    t0 = time.monotonic()
    with requests.post(peer_url.rstrip("/") + "/upload", data=gen(), timeout=(10, 900)) as r:
        r.raise_for_status()
    elapsed = time.monotonic() - t0
    return {"sent": total, "elapsed_ms": round(elapsed * 1000, 2), "mbps": round((total * 8) / (elapsed * 1e6), 2)}


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------- HTTP 路由 ----------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/ping")
def ping():
    return jsonify({"pong": time.monotonic()})


@app.route("/download")
def download():
    size_mb = min(request.args.get("size", default=DEFAULT_SIZE_MB, type=int), MAX_SIZE_MB)
    response = Response(
        random_stream(size_mb),
        mimetype="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=random_{size_mb}mb.bin",
            "Cache-Control": "no-store",
        },
    )
    return response


@app.route("/upload", methods=["POST"])
def upload():
    start = time.monotonic()
    total = 0
    while True:
        chunk = request.stream.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
    elapsed = time.monotonic() - start
    speed_mbps = (total * 8) / (elapsed * 1e6) if elapsed > 0 else 0
    return jsonify({"size": total, "elapsed_ms": round(elapsed * 1000, 2), "speed_mbps": round(speed_mbps, 2)})


@app.route("/api/self")
def api_self():
    return jsonify({"self": self_info(), "peers": load_config().get("peers", [])})


@app.route("/api/peers", methods=["GET", "POST"])
def api_peers():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        peers = data.get("peers")
        if not isinstance(peers, list):
            return jsonify({"error": "peers must be a list"}), 400
        cfg = load_config()
        cfg["peers"] = [p for p in peers if isinstance(p, dict) and p.get("url")]
        save_config(cfg)
        return jsonify({"peers": cfg["peers"]})
    return jsonify({"peers": load_config().get("peers", [])})


@app.route("/api/udp/run")
def api_udp_run():
    host = (request.args.get("host") or "").strip()
    port = request.args.get("port", default=UDP_PORT, type=int)
    count = request.args.get("count", default=100, type=int)
    size = request.args.get("size", default=64, type=int)
    interval_ms = request.args.get("interval", default=10, type=int)
    host = host or self_info()["ip"]
    count = max(1, min(count, 1000))
    size = max(20, min(size, 1200))
    interval = max(0, min(interval_ms, 1000)) / 1000

    def gen():
        yield sse("init", {"host": host, "port": port, "count": count, "size": size})
        try:
            rtts = []
            for seq, ok, rtt in udp_probe_stream(host, port, count, size, interval, timeout=max(0.2, interval + 0.5)):
                if rtt is not None:
                    rtts.append(rtt)
                yield sse("packet", {"seq": seq, "ok": ok, "rtt_ms": rtt})
            result = udp_stats(count, rtts)
            yield sse("result", result)
            save_history({
                "type": "udp",
                "peer": f"{host}:{port}",
                "mode": "udp",
                "udp_loss": result["loss_pct"],
                "udp_rtt_ms": result["avg_rtt_ms"],
                "udp_jitter_ms": result["jitter_ms"],
                "details": {"count": count, "size": size, "sent": result["sent"], "received": result["received"], "min": result["min_rtt_ms"], "max": result["max_rtt_ms"]},
            })
            yield sse("done", {})
        except Exception as e:
            yield sse("error", {"message": str(e)})

    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-store"})


@app.route("/api/s2s/run")
def api_s2s_run():
    peer_url = (request.args.get("url") or "").strip().rstrip("/")
    if not peer_url:
        return jsonify({"error": "缺少对端服务器 URL"}), 400
    if not peer_url.startswith(("http://", "https://")):
        peer_url = "http://" + peer_url
    udp_port = request.args.get("udp_port", default=UDP_PORT, type=int)
    down_mb = max(1, min(request.args.get("down_size", default=DEFAULT_SIZE_MB, type=int), MAX_SIZE_MB))
    up_mb = max(1, min(request.args.get("up_size", default=DEFAULT_SIZE_MB, type=int), MAX_SIZE_MB))
    udp_count = max(1, min(request.args.get("udp_count", default=200, type=int), 1000))
    peer_host = peer_url.split("//")[-1].split(":")[0]

    def run_phase(name, label, fn, state, state_key):
        q = queue.Queue()

        def inner():
            try:
                r = fn(lambda m: q.put(("progress", {"phase": name, "mbps": round(m, 2)})))
                state[state_key] = r["mbps"]
                q.put(("result", {"phase": name, "mbps": r["mbps"], "elapsed_ms": r.get("elapsed_ms")}))
            except Exception as e:
                q.put(("error", {"message": str(e)}))
            q.put(("_done", None))

        threading.Thread(target=inner, daemon=True).start()
        yield sse("phase", {"name": name, "label": label})
        while True:
            try:
                evt = q.get(timeout=0.2)
            except queue.Empty:
                continue
            if evt[0] == "_done":
                break
            yield sse(evt[0], evt[1])

    def gen():
        state = {"peer": peer_url}
        try:
            yield sse("phase", {"name": "ping", "label": "Ping 延迟"})
            state["ping_ms"] = s2s_ping(peer_url)
            yield sse("ping", {"ping_ms": state["ping_ms"]})

            yield from run_phase("download", f"下载 {down_mb} MB", lambda cb: s2s_download(peer_url, down_mb, cb), state, "download_mbps")
            yield from run_phase("upload", f"上传 {up_mb} MB", lambda cb: s2s_upload(peer_url, up_mb, cb), state, "upload_mbps")

            yield sse("phase", {"name": "udp", "label": "UDP 丢包 / 延时"})
            udp = udp_probe(peer_host, udp_port, udp_count, size=64, interval=0.01, timeout=0.7)
            state["udp_loss"] = udp["loss_pct"]
            state["udp_rtt_ms"] = udp["avg_rtt_ms"]
            state["udp_jitter_ms"] = udp["jitter_ms"]
            yield sse("result", {"phase": "udp", **udp})

            save_history({
                "type": "s2s",
                "peer": peer_url,
                "mode": "all",
                "ping_ms": state["ping_ms"],
                "download_mbps": state["download_mbps"],
                "upload_mbps": state["upload_mbps"],
                "udp_loss": state["udp_loss"],
                "udp_rtt_ms": state["udp_rtt_ms"],
                "udp_jitter_ms": state["udp_jitter_ms"],
                "details": {"down_mb": down_mb, "up_mb": up_mb, "udp_count": udp_count},
            })
            yield sse("done", state)
        except Exception as e:
            yield sse("error", {"message": str(e)})

    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-store"})


@app.route("/api/history", methods=["GET", "POST"])
def api_history():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        if not isinstance(data, dict) or not data.get("type"):
            return jsonify({"error": "invalid record"}), 400
        save_history(data)
        return jsonify({"ok": True})
    type_filter = request.args.get("type") or None
    return jsonify(list_history(type_filter))


@app.route("/api/history/clear", methods=["POST"])
def api_history_clear():
    clear_history()
    return jsonify({"ok": True})


start_udp()

if __name__ == "__main__":
    port = int(os.environ.get("SPEED_PORT", 5000))
    print(f"[http] server running on http://0.0.0.0:{port} (udp echo on :{UDP_PORT})")
    app.run(host="0.0.0.0", port=port, threaded=True)
