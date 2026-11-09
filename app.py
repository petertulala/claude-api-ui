#!/usr/bin/env python3
"""claude-api-ui: a small local web GUI over `claude -p` (stream-json).

Runs each prompt as `claude -p --output-format stream-json --verbose
--include-partial-messages [--resume <id>] ...` and streams the events to a
browser page over Server-Sent Events. Standard library only.

Usage:  python3 app.py [--port 8765] [--cwd DIR] [--no-browser]
"""

import argparse
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
INDEX_HTML = HERE / "index.html"
KEY_FILE = Path.home() / ".config" / "claude-api-ui" / "api_key"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
SETTINGS_FILE = Path.home() / ".claude" / "settings.json"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or "claude"

TOKEN = secrets.token_urlsafe(24)
RUNS = {}  # run_id -> Run
RUNS_LOCK = threading.Lock()

# Key sources that mean "billed to the API key", as reported by the init event.
API_KEY_SOURCES = {"ANTHROPIC_API_KEY", "apiKeyHelper"}


def claude_settings():
    try:
        s = json.loads(SETTINGS_FILE.read_text())
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def api_key_env():
    """Environment for the child plus where the key came from.

    ANTHROPIC_API_KEY from the environment, else `env` in ~/.claude/settings.json
    (claude applies that itself too), else KEY_FILE. An `apiKeyHelper` in the
    settings also counts as a key. Returns (env, source or None).
    """
    env = dict(os.environ)
    if env.get("ANTHROPIC_API_KEY"):
        return env, "env"
    s = claude_settings()
    s_env = s.get("env") if isinstance(s.get("env"), dict) else {}
    key = str(s_env.get("ANTHROPIC_API_KEY") or "").strip()
    if key:
        env["ANTHROPIC_API_KEY"] = key
        return env, "settings.json"
    if KEY_FILE.is_file():
        key = KEY_FILE.read_text().strip()
        if key:
            env["ANTHROPIC_API_KEY"] = key
            return env, "file"
    if s.get("apiKeyHelper"):
        return env, "apiKeyHelper"
    return env, None


class Run:
    def __init__(self, run_id, argv, cwd, prompt, env, require_api_key):
        self.id = run_id
        self.argv = argv
        self.events = []  # list of (kind, payload)
        self.cond = threading.Condition()
        self.done = False
        self.stopped = False
        self.require_api_key = require_api_key
        self.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,  # own process group, so Stop kills tools too
        )
        threading.Thread(target=self._feed_stdin, args=(prompt,), daemon=True).start()
        self._readers = [
            threading.Thread(target=self._read, args=(self.proc.stdout, "out"), daemon=True),
            threading.Thread(target=self._read, args=(self.proc.stderr, "err"), daemon=True),
        ]
        for t in self._readers:
            t.start()
        threading.Thread(target=self._wait, daemon=True).start()

    def _feed_stdin(self, prompt):
        try:
            self.proc.stdin.write(prompt.encode())
            self.proc.stdin.close()
        except OSError:
            pass

    def push(self, kind, payload):
        with self.cond:
            self.events.append((kind, payload))
            self.cond.notify_all()

    def _read(self, stream, kind):
        for raw in iter(stream.readline, b""):
            line = raw.decode(errors="replace").rstrip("\n")
            if not line:
                continue
            if kind == "out":
                try:
                    obj = json.loads(line)
                except ValueError:
                    self.push("stderr", line)
                    continue
                self._guard(obj)
                self.push("event", obj)
            else:
                self.push("stderr", line)

    def _guard(self, obj):
        """Kill the run if it is not billed to the API key and the user required that."""
        if not self.require_api_key:
            return
        if obj.get("type") == "system" and obj.get("subtype") == "init":
            src = obj.get("apiKeySource")
            if src not in API_KEY_SOURCES:
                self.push("stderr", f"[gui] apiKeySource is {src!r}, not an API key — stopping "
                                    "(untick 'Require API key' to allow this).")
                self.stop()

    def _wait(self):
        code = self.proc.wait()
        if self.stopped:
            self._killpg(signal.SIGKILL)  # leftover tool processes would hold the pipes open
        for t in self._readers:
            t.join()
        self.push("exit", code)
        with self.cond:
            self.done = True
            self.cond.notify_all()

    def _killpg(self, sig):
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def stop(self):
        if not self.stopped:
            self.stopped = True
            self._killpg(signal.SIGTERM)
            threading.Timer(3, self._killpg, args=(signal.SIGKILL,)).start()


def build_argv(o):
    argv = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose"]
    if o.get("partial", True):
        argv.append("--include-partial-messages")
    if o.get("session_id"):
        argv += ["--resume", o["session_id"]]
        if o.get("fork"):
            argv.append("--fork-session")
    elif o.get("continue"):
        argv.append("--continue")
    if o.get("model"):
        argv += ["--model", o["model"]]
    if o.get("effort"):
        argv += ["--effort", o["effort"]]
    if o.get("permission_mode"):
        argv += ["--permission-mode", o["permission_mode"]]
    if o.get("allowed_tools", "").strip():
        argv += ["--allowedTools", o["allowed_tools"].strip()]
    if o.get("max_budget"):
        argv += ["--max-budget-usd", str(o["max_budget"])]
    if o.get("extra_args", "").strip():
        argv += shlex.split(o["extra_args"])
    return argv


def norm_cwd(cwd):
    return os.path.abspath(os.path.expanduser(cwd.strip())) if cwd and cwd.strip() else ""


def project_dir(cwd):
    return PROJECTS_DIR / re.sub(r"[^A-Za-z0-9]", "-", norm_cwd(cwd))


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def list_sessions(cwd, limit=40):
    d = project_dir(cwd)
    if not d.is_dir():
        return []
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    out = []
    for f in files:
        first = ""
        try:
            with f.open() as fh:
                for line in fh:
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    if obj.get("type") == "user" and not obj.get("isSidechain") and not obj.get("isMeta"):
                        t = text_of(obj.get("message", {}).get("content")).strip()
                        if t and not t.startswith("<"):
                            first = t
                            break
        except OSError:
            continue
        out.append({"id": f.stem, "mtime": f.stat().st_mtime, "title": first[:120]})
    return out


def session_file(cwd, sid):
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid or ""):
        return None
    f = project_dir(cwd) / f"{sid}.jsonl"
    return f if f.is_file() else None


def session_exists(cwd, sid):
    return session_file(cwd, sid) is not None


def session_history(cwd, sid):
    f = session_file(cwd, sid)
    if not f:
        return []
    out = []
    with f.open() as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("type") in ("user", "assistant") and not obj.get("isSidechain") and not obj.get("isMeta"):
                out.append({"type": obj["type"], "message": obj.get("message", {})})
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "claude-api-ui"

    def log_message(self, fmt, *args):  # quiet
        pass

    # --- helpers -------------------------------------------------------
    def _authorized(self, qs):
        tok = self.headers.get("X-Token") or (qs.get("t") or [""])[0]
        return secrets.compare_digest(tok, TOKEN)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # --- routes --------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not self._authorized(qs):
            return self._json({"error": "bad token — open the URL printed in the terminal"}, 403)
        if u.path == "/":
            html = INDEX_HTML.read_text().replace("__TOKEN__", TOKEN)
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/info":
            _, src = api_key_env()
            self._json({
                "claude_bin": CLAUDE_BIN,
                "default_cwd": self.server.default_cwd,
                "api_key_present": bool(src),
                "api_key_from": src,
            })
        elif u.path == "/api/sessions":
            self._json(list_sessions((qs.get("cwd") or [""])[0]))
        elif u.path == "/api/history":
            self._json(session_history((qs.get("cwd") or [""])[0], (qs.get("id") or [""])[0]))
        elif u.path.startswith("/api/stream/"):
            self._stream(u.path.rsplit("/", 1)[-1])
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        if not self._authorized(parse_qs(u.query)):
            return self._json({"error": "bad token"}, 403)
        if u.path == "/api/run":
            o = self._body()
            cwd = norm_cwd(o.get("cwd") or "") or self.server.default_cwd
            if not os.path.isdir(cwd):
                return self._json({"error": f"not a directory: {cwd}"}, 400)
            sid = o.get("session_id")
            if sid and not session_exists(cwd, sid):
                return self._json({"error": f"session {sid} is not stored for {cwd}; a session "
                                            "keeps the directory it started in (click New "
                                            "to use another directory)"}, 400)
            prompt = o.get("prompt", "")
            if not prompt.strip():
                return self._json({"error": "empty prompt"}, 400)
            env, src = api_key_env()
            require = bool(o.get("require_api_key", True))
            if require and not src:
                return self._json({"error": "ANTHROPIC_API_KEY is not set (env, "
                                            f"{SETTINGS_FILE} env, or {KEY_FILE}) "
                                            "and 'Require API key' is on"}, 400)
            try:
                argv = build_argv(o)
            except ValueError as e:
                return self._json({"error": f"extra args: {e}"}, 400)
            run_id = secrets.token_hex(8)
            try:
                run = Run(run_id, argv, cwd, prompt, env, require)
            except OSError as e:
                return self._json({"error": f"cannot start {CLAUDE_BIN}: {e}"}, 500)
            with RUNS_LOCK:
                RUNS[run_id] = run
            self._json({"run_id": run_id, "argv": argv, "cwd": cwd})
        elif u.path.startswith("/api/stop/"):
            run = RUNS.get(u.path.rsplit("/", 1)[-1])
            if run:
                run.stop()
            self._json({"ok": bool(run)})
        else:
            self._json({"error": "not found"}, 404)

    def _stream(self, run_id):
        run = RUNS.get(run_id)
        if not run:
            return self._json({"error": "unknown run"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        i = 0
        try:
            while True:
                with run.cond:
                    while i >= len(run.events) and not run.done:
                        run.cond.wait(timeout=15)
                        if i >= len(run.events) and not run.done:
                            break  # heartbeat
                    batch = run.events[i:]
                    finished = run.done and i + len(batch) >= len(run.events)
                if not batch and not finished:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                for kind, payload in batch:
                    self.wfile.write(f"event: {kind}\ndata: {json.dumps(payload)}\n\n".encode())
                i += len(batch)
                self.wfile.flush()
                if finished:
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--cwd", default=os.getcwd(), help="default working directory for claude")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    port = a.port
    for _ in range(20):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("no free port")
    srv.daemon_threads = True
    srv.default_cwd = os.path.abspath(os.path.expanduser(a.cwd))

    url = f"http://127.0.0.1:{port}/?t={TOKEN}"
    print(f"claude-api-ui on {url}\n  claude: {CLAUDE_BIN}\n  cwd:    {srv.default_cwd}\n"
          f"  API key: {api_key_env()[1] or 'NOT SET'}\nCtrl+C to quit.",
          flush=True)
    if not a.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for r in list(RUNS.values()):
            r.stop()
        time.sleep(0.2)


if __name__ == "__main__":
    main()
