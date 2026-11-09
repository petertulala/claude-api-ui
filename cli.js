#!/usr/bin/env node
// claude-api-ui: a small local web UI over `claude -p` (stream-json), billed to an API key.
//
// Runs each prompt as `claude -p --output-format stream-json --verbose
// --include-partial-messages --input-format stream-json [--resume <id>] ...`, writes the
// prompt to stdin as a user message (more can follow mid-turn: steering), and streams the
// events to a browser page over Server-Sent Events. Node.js standard library only.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const PKG = require("./package.json");
const INDEX_HTML = path.join(__dirname, "index.html");
const HOME = os.homedir();
const KEY_FILE = path.join(HOME, ".config", "claude-api-ui", "api_key");
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const SETTINGS_FILE = path.join(HOME, ".claude", "settings.json");
const CLAUDE_JSON = path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json");
const CLAUDE_BIN = process.env.CLAUDE_BIN || which("claude") || "claude";

const TOKEN = crypto.randomBytes(24).toString("base64url");
const RUNS = new Map(); // run id -> Run

// Key sources that mean "billed to the API key", as reported by the init event.
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper"]);
// Name of claude's built-in Claude in Chrome MCP server, as listed in the init event.
const CHROME_MCP = "claude-in-chrome";
const BRAVE_BIN = process.platform === "darwin"
  ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  : process.platform === "win32" ? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  : "/usr/bin/brave-browser";

// ---------- helpers ---------------------------------------------------------

function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Session id -> cost claude saved for it (projects[*].lastCost/lastSessionId in ~/.claude.json).
// Resuming the session that saved last restores that cost, so the run's result.total_cost_usd
// is the whole session's total, not this run's. Snapshot before spawning to subtract it.
function savedSessionCosts() {
  const out = new Map();
  try {
    const d = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
    for (const v of Object.values(d.projects || {}))
      if (v && v.lastSessionId && typeof v.lastCost === "number") out.set(v.lastSessionId, v.lastCost);
  } catch {}
  return out;
}

function claudeSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

// Environment for the child plus where the key came from: ANTHROPIC_API_KEY from the
// environment, else `env` in ~/.claude/settings.json (claude applies that itself too), else
// KEY_FILE. An `apiKeyHelper` in the settings also counts. Returns [env, source or null].
function apiKeyEnv() {
  const env = { ...process.env };
  if (env.ANTHROPIC_API_KEY) return [env, "env"];
  const s = claudeSettings();
  const sEnv = s.env && typeof s.env === "object" ? s.env : {};
  let key = String(sEnv.ANTHROPIC_API_KEY || "").trim();
  if (key) { env.ANTHROPIC_API_KEY = key; return [env, "settings.json"]; }
  if (isFile(KEY_FILE)) {
    key = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (key) { env.ANTHROPIC_API_KEY = key; return [env, "file"]; }
  }
  if (s.apiKeyHelper) return [env, "apiKeyHelper"];
  return [env, null];
}

// POSIX-shell-like word splitting for the "extra args" field (quotes and backslashes).
function shellSplit(s) {
  const out = [];
  let cur = "", inWord = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ""; inWord = false; } continue; }
    inWord = true;
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") { if (i + 1 < s.length) cur += s[++i]; }
    else cur += c;
  }
  if (q) throw new Error("no closing quotation");
  if (inWord) out.push(cur);
  return out;
}

function buildArgv(o) {
  const argv = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose"];
  if (o.partial ?? true) argv.push("--include-partial-messages");
  // Messages, not plain text: they can carry images, and stdin can stay open for steering.
  argv.push("--input-format", "stream-json");
  if (o.session_id) {
    argv.push("--resume", String(o.session_id));
    if (o.fork) argv.push("--fork-session");
  } else if (o.continue) argv.push("--continue");
  if (o.model) argv.push("--model", String(o.model));
  if (o.effort) argv.push("--effort", String(o.effort));
  if (o.permission_mode) argv.push("--permission-mode", String(o.permission_mode));
  // Browser tools. -p can't answer permission prompts, so the chosen browser's MCP tools are
  // pre-allowed (server-level rule = every tool of that server).
  const allow = [];
  const browser = String(o.browser || "");
  if (browser === "chrome") {
    argv.push("--chrome"); // the Claude in Chrome extension, driving your own Chrome window
    allow.push("mcp__" + CHROME_MCP);
  } else if (browser.startsWith("playwright")) {
    // A shared Playwright MCP server that the app keeps running (see ensurePlaywright), so the
    // browser connection survives from one prompt to the next. o.playwright_url is set by the
    // /api/run handler once that server is up.
    argv.push("--mcp-config", JSON.stringify({ mcpServers: { playwright: { type: "http", url: o.playwright_url } } }));
    allow.push("mcp__playwright");
  }
  const tools = [String(o.allowed_tools || "").trim(), ...allow].filter(Boolean).join(" ");
  if (tools) argv.push("--allowedTools", tools);
  if (o.max_budget) argv.push("--max-budget-usd", String(o.max_budget));
  const extra = String(o.extra_args || "").trim();
  if (extra) argv.push(...shellSplit(extra));
  return argv;
}

function normCwd(cwd) {
  cwd = String(cwd || "").trim();
  if (!cwd) return "";
  if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(HOME, cwd.slice(1));
  return path.resolve(cwd);
}

// Claude Code stores sessions in ~/.claude/projects/<cwd with non-alphanumerics replaced by ->.
function projectDir(cwd) { return path.join(PROJECTS_DIR, normCwd(cwd).replace(/[^A-Za-z0-9]/g, "-")); }

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter(b => b && typeof b === "object" && b.type === "text").map(b => b.text || "").join(" ");
  return "";
}

function* jsonLines(text) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

const isMainThread = o => !o.isSidechain && !o.isMeta;

// Reads only the head of each file: enough to find the first prompt, cheap for large sessions.
function readHead(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function listSessions(cwd, limit = 40) {
  const d = projectDir(cwd);
  if (!isDir(d)) return [];
  const files = fs.readdirSync(d).filter(f => f.endsWith(".jsonl")).map(f => {
    const p = path.join(d, f);
    try { return { p, id: f.slice(0, -6), mtime: fs.statSync(p).mtimeMs / 1000 }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  const out = [];
  for (const f of files) {
    let title = "";
    try {
      for (const o of jsonLines(readHead(f.p))) {
        if (o.type === "user" && isMainThread(o)) {
          const t = textOf((o.message || {}).content).trim();
          if (t && !t.startsWith("<")) { title = t; break; }
        }
      }
    } catch { continue; }
    out.push({ id: f.id, mtime: f.mtime, title: title.slice(0, 120) });
  }
  return out;
}

// First prompt (title) and starting directory of a session, from the head of its file.
function sessionMeta(file) {
  let title = "", cwd = "";
  for (const o of jsonLines(readHead(file))) {
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (!title && o.type === "user" && isMainThread(o)) {
      const t = textOf((o.message || {}).content).trim();
      if (t && !t.startsWith("<")) title = t;
    }
    if (title && cwd) break;
  }
  return { title: title.slice(0, 120), cwd };
}

// Recent sessions from every directory except `exclude`, newest first, plus the recently used
// directories. A session is listed only if its directory still exists and maps back to the
// project folder it is stored in, so that resuming it from that directory works.
function listAllSessions(exclude, limit = 30) {
  const skip = exclude ? projectDir(exclude) : null;
  let files = [];
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { return { sessions: [], folders: [] }; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      try { files.push({ p, dir, id: f.slice(0, -6), mtime: fs.statSync(p).mtimeMs / 1000 }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [], folders = [], seenFolder = new Set(), badDir = new Set();
  const doneDir = new Set(); // folder already known (or gone): only needed again for sessions
  for (const f of files) {
    if (sessions.length >= limit && folders.length >= 20) break;
    if (badDir.has(f.dir) || (sessions.length >= limit && doneDir.has(f.dir))) continue;
    let meta;
    try { meta = sessionMeta(f.p); } catch { continue; }
    if (!meta.cwd) continue;
    const cwd = normCwd(meta.cwd);
    if (projectDir(cwd) !== f.dir) continue;
    if (!isDir(cwd)) { badDir.add(f.dir); continue; } // directory deleted: skip all its sessions
    doneDir.add(f.dir);
    if (!seenFolder.has(cwd) && folders.length < 20) { seenFolder.add(cwd); folders.push(cwd); }
    if (f.dir !== skip && sessions.length < limit)
      sessions.push({ id: f.id, mtime: f.mtime, title: meta.title, cwd });
  }
  return { sessions, folders };
}

function sessionFile(cwd, sid) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sid || "")) return null;
  const f = path.join(projectDir(cwd), `${sid}.jsonl`);
  return isFile(f) ? f : null;
}

function sessionHistory(cwd, sid) {
  const f = sessionFile(cwd, sid);
  if (!f) return [];
  const out = [];
  for (const o of jsonLines(fs.readFileSync(f, "utf8")))
    if ((o.type === "user" || o.type === "assistant") && isMainThread(o))
      out.push({ type: o.type, message: o.message || {} });
  return out;
}

// ---------- runs ------------------------------------------------------------

// ---------- shared Playwright MCP servers ----------
// One long-running `@playwright/mcp --port` server per Browser option, started on first use and
// kept until the app quits. claude runs connect to it over HTTP, so the browser (and, in
// extension mode, the extension's connection to your own browser) stays open between prompts
// and sessions instead of being restarted with every `claude -p`.
const PLAYWRIGHT = new Map(); // browser option -> { port, proc, ready, log }

// Extra environment for the server: the `env` of ~/.claude/settings.json (where
// PLAYWRIGHT_MCP_EXTENSION_TOKEN lives; claude applied it when claude started Playwright itself),
// without Anthropic credentials, which Playwright doesn't need.
function settingsEnv() {
  const e = claudeSettings().env;
  const out = {};
  if (e && typeof e === "object")
    for (const [k, v] of Object.entries(e)) if (typeof v === "string" && !k.startsWith("ANTHROPIC_")) out[k] = v;
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function waitForPort(port, timeoutMs, alive) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!alive()) return reject(new Error("the server exited"));
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`no answer on port ${port} after ${timeoutMs / 1000}s`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// Returns the URL of the running server for this Browser option, starting it if needed.
async function ensurePlaywright(browser) {
  const cur = PLAYWRIGHT.get(browser);
  if (cur && cur.proc.exitCode === null && cur.proc.signalCode === null) {
    await cur.ready;
    keepPlaywrightConnected(cur); // reconnects if the browser was closed in the meantime
    return `http://127.0.0.1:${cur.port}/mcp`;
  }
  const port = await freePort();
  const args = ["-y", "@playwright/mcp@latest", "--port", String(port), "--host", "127.0.0.1", "--shared-browser-context"];
  if (browser === "playwright-headless") args.push("--headless");
  if (browser.startsWith("playwright-extension")) args.push("--extension");
  const env = { ...process.env, ...settingsEnv() };
  // Other Chromium browsers: point Playwright at the browser's binary, so it looks for the
  // extension in that browser instead of Google Chrome.
  if (browser === "playwright-extension-brave") env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = BRAVE_BIN;
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(npx, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const entry = { browser, port, proc, log: [], anchor: null, anchoring: null };
  const keep = line => { if (line) { entry.log.push(line); if (entry.log.length > 30) entry.log.shift(); } };
  readline.createInterface({ input: proc.stdout }).on("line", keep);
  readline.createInterface({ input: proc.stderr }).on("line", keep);
  proc.on("error", e => keep(`cannot run ${npx}: ${e.message}`));
  proc.on("exit", () => { if (PLAYWRIGHT.get(browser) === entry) PLAYWRIGHT.delete(browser); });
  const alive = () => proc.exitCode === null && proc.signalCode === null && !!proc.pid;
  entry.ready = waitForPort(port, 120000, alive).catch(e => {
    killGroup(proc, "SIGTERM");
    if (PLAYWRIGHT.get(browser) === entry) PLAYWRIGHT.delete(browser);
    throw new Error(`Playwright MCP did not start (${e.message}). ${entry.log.slice(-5).join(" | ")}`);
  });
  PLAYWRIGHT.set(browser, entry);
  console.log(`  Playwright MCP (${browser}) starting on port ${port}`);
  await entry.ready;
  keepPlaywrightConnected(entry);
  return `http://127.0.0.1:${port}/mcp`;
}

// ---- the app's own, permanent client of the shared server ----
// Playwright MCP closes the browser (and the extension's connection to yours) when its last
// client disconnects, which is every time a `claude -p` run ends. So the app stays connected as
// an idle client of its own for as long as the server runs: an MCP session over Streamable
// HTTP, opened with one harmless call (list tabs) so the shared browser connection is created
// with the app as a member. claude runs join and leave it; it closes only when the app quits.

// One JSON-RPC message to the server. Resolves with the session id and, for requests, the
// response (sent as plain JSON or as an SSE event).
function mcpPost(port, session, msg) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(msg));
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                      "Content-Length": body.length };
    if (session) headers["mcp-session-id"] = session;
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, res => {
      const sid = res.headers["mcp-session-id"] || session;
      if (msg.id === undefined) { res.resume(); return resolve({ sid }); }
      res.setEncoding("utf8");
      let buf = "", done = false;
      const finish = result => { if (!done) { done = true; resolve({ sid, result }); res.destroy(); } };
      res.on("data", chunk => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try { const o = JSON.parse(line.slice(5)); if (o.id === msg.id) return finish(o); } catch {}
        }
      });
      res.on("end", () => { let o = null; try { o = JSON.parse(buf); } catch {} finish(o); });
    });
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("no response from Playwright MCP")));
    req.end(body);
  });
}

async function anchorPlaywright(entry) {
  const init = await mcpPost(entry.port, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-api-ui", version: PKG.version } },
  });
  if (!init.sid || !init.result || init.result.error) throw new Error("initialize failed");
  await mcpPost(entry.port, init.sid, { jsonrpc: "2.0", method: "notifications/initialized" });
  // Open the session's server-to-client stream, as MCP clients do. The server pings on it every
  // few seconds and ends the session if a ping goes unanswered, so answer each one.
  const sid = init.sid;
  const stream = http.request({ host: "127.0.0.1", port: entry.port, path: "/mcp", method: "GET",
    headers: { Accept: "text/event-stream", "mcp-session-id": sid } }, res => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", chunk => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let o;
        try { o = JSON.parse(line.slice(5)); } catch { continue; }
        if (o.method === "ping" && o.id !== undefined)
          mcpPost(entry.port, sid, { jsonrpc: "2.0", id: o.id, result: {} }).catch(() => {});
      }
    });
    res.on("end", () => { if (entry.anchor === sid) entry.anchor = null; }); // reconnects on the next prompt
  });
  stream.on("error", () => { if (entry.anchor === sid) entry.anchor = null; });
  stream.end();
  entry.anchorStream = stream;
  const r = await mcpPost(entry.port, init.sid, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } },
  });
  const res = r.result && r.result.result;
  if (!res || res.isError) {
    stream.destroy();
    const text = res && Array.isArray(res.content) ? res.content.map(c => c.text || "").join(" ") : JSON.stringify(r.result);
    throw new Error(String(text).slice(0, 300));
  }
  entry.anchor = init.sid;
  console.log(`  Playwright MCP (${entry.browser}): browser connected, kept open between prompts`);
}

// Starts the app's client if it isn't connected yet. Not awaited: the run doesn't need it, and
// with the extension the connection can wait for you to approve it in the browser.
function keepPlaywrightConnected(entry) {
  if (entry.anchoring) return;
  entry.anchoring = (async () => {
    if (entry.anchor) {
      // Still connected? (The browser may have gone away, e.g. you quit it.)
      try {
        const r = await mcpPost(entry.port, entry.anchor, { jsonrpc: "2.0", id: 3, method: "tools/call",
          params: { name: "browser_tabs", arguments: { action: "list" } } });
        if (r.result && r.result.result && !r.result.result.isError) return;
      } catch {}
      if (entry.anchorStream) entry.anchorStream.destroy();
      entry.anchor = null;
    }
    await anchorPlaywright(entry);
  })().catch(e => {
    entry.log.push(`keep-alive client: ${e.message}`);
    console.log(`  Playwright MCP (${entry.browser}): couldn't keep the browser connected: ${e.message}`);
  }).finally(() => { entry.anchoring = null; });
}

function killGroup(proc, sig) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") proc.kill(sig);
    else process.kill(-proc.pid, sig);
  } catch {}
}

function stopPlaywright() { for (const e of PLAYWRIGHT.values()) killGroup(e.proc, "SIGTERM"); }

class Run {
  constructor(id, argv, cwd, prompt, env, requireApiKey, resumeId, browser) {
    this.id = id;
    this.savedCosts = savedSessionCosts(); // before spawn: what claude may restore
    this.resumeId = resumeId || null;
    this.baseline = 0;
    this.events = []; // [kind, payload]
    this.listeners = new Set();
    this.done = false;
    this.stopped = false;
    this.requireApiKey = requireApiKey;
    this.browser = browser || "";
    // detached: own process group, so Stop also kills the tools claude started.
    this.proc = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.proc.on("error", e => this.push("stderr", `[gui] cannot run ${argv[0]}: ${e.message}`));
    this.proc.stdin.on("error", () => {});
    // stdin stays open while the turn runs so the user can steer (POST /api/steer); it is
    // closed on the first result, after which claude finishes what it has read and exits.
    this.inputOpen = true;
    this.proc.stdin.write(prompt);
    readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on("line", line => {
      if (!line) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return this.push("stderr", line); }
      this.guard(obj);
      this.accountCost(obj);
      this.push("event", obj);
      if (obj.type === "result") this.endInput();
    });
    readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity }).on("line", line => {
      if (line) this.push("stderr", line);
    });
    this.proc.on("exit", () => { if (this.stopped) this.killGroup("SIGKILL"); }); // leftover tools hold the pipes
    this.proc.on("close", (code, signal) => {
      this.push("exit", code ?? (signal ? -(os.constants.signals[signal] || 1) : -1));
      this.done = true;
      for (const l of this.listeners) l(null);
    });
  }

  push(kind, payload) {
    this.events.push([kind, payload]);
    for (const l of this.listeners) l([kind, payload]);
  }

  // Adds run_cost_usd (this run alone) to the result event; see savedSessionCosts().
  accountCost(obj) {
    if (obj.type === "system" && obj.subtype === "init") {
      this.baseline = this.savedCosts.get(obj.session_id) ?? this.savedCosts.get(this.resumeId) ?? 0;
    } else if (obj.type === "result" && typeof obj.total_cost_usd === "number") {
      const t = obj.total_cost_usd;
      obj.run_cost_usd = t >= this.baseline ? t - this.baseline : t; // below baseline = nothing restored
    }
  }

  // Checks on the init event, before the model has done anything.
  guard(obj) {
    if (obj.type !== "system" || obj.subtype !== "init") return;
    // Not billed to the API key, and the user required that.
    const src = obj.apiKeySource;
    if (this.requireApiKey && !API_KEY_SOURCES.has(src)) {
      this.push("stderr", `[gui] apiKeySource is ${JSON.stringify(src)}, not an API key — stopping ` +
                          "(untick 'Require API key' to allow this).");
      return this.stop();
    }
    // Claude in Chrome was chosen but claude didn't load it. Without its tools Claude falls back
    // to shell commands like `open -na "Google Chrome"`, which can start a second Chrome with an
    // empty profile instead of using your windows, so stop instead.
    if (this.browser === "chrome" && !(obj.mcp_servers || []).some(m => m && m.name === CHROME_MCP)) {
      this.push("stderr", "[gui] Claude in Chrome did not load, so the run was stopped before Claude " +
        "could start a separate Chrome. Claude Code turns Claude in Chrome on only for sessions on a " +
        "claude.ai account, not for runs billed to an API key. To have Claude use your own Chrome " +
        "windows with the API key, pick Settings → Browser → \"Your Chrome (Playwright extension)\" " +
        "and install the Playwright extension in that Chrome profile.");
      return this.stop();
    }
  }

  killGroup(sig) {
    if (!this.proc.pid) return;
    try {
      if (process.platform === "win32") this.proc.kill(sig);
      else process.kill(-this.proc.pid, sig);
    } catch {}
  }

  // Write one more user message into the running turn. False once input is closed.
  steer(line) {
    if (!this.inputOpen || this.done || this.stopped) return false;
    this.proc.stdin.write(line);
    return true;
  }

  endInput() {
    if (!this.inputOpen) return;
    this.inputOpen = false;
    try { this.proc.stdin.end(); } catch {}
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.endInput();
    this.killGroup("SIGTERM");
    setTimeout(() => this.killGroup("SIGKILL"), 3000).unref();
  }
}

// ---------- HTTP ------------------------------------------------------------

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

function authorized(req, url) {
  const tok = Buffer.from(String(req.headers["x-token"] || url.searchParams.get("t") || ""));
  const want = Buffer.from(TOKEN);
  return tok.length === want.length && crypto.timingSafeEqual(tok, want);
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 20;

// Pasted images: [{media_type, data (base64)}], validated.
function checkImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("images must be a list");
  if (list.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per prompt`);
  return list.map((im, i) => {
    if (!im || !IMAGE_TYPES.has(im.media_type)) throw new Error(`image ${i + 1}: type must be png, jpeg, gif or webp`);
    const data = String(im.data || "");
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error(`image ${i + 1}: data is not base64`);
    if (data.length * 0.75 > 5 * 1024 * 1024) throw new Error(`image ${i + 1}: over the API's 5 MB limit`);
    return { media_type: im.media_type, data };
  });
}

// One stream-json input line: a user message with the images first, then the text.
function userMessageLine(text, images) {
  const content = images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
  if (text.trim()) content.push({ type: "text", text });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error("request too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function stream(req, res, run) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const write = ([kind, payload]) => res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  run.events.forEach(write);
  if (run.done) return res.end();
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  const listener = ev => { if (ev) write(ev); else { cleanup(); res.end(); } };
  const cleanup = () => { clearInterval(ping); run.listeners.delete(listener); };
  run.listeners.add(listener);
  req.on("close", cleanup);
}

async function handle(req, res, defaultCwd) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
  if (!authorized(req, url))
    return sendJson(res, { error: "bad token — open the URL printed in the terminal" }, 403);
  const p = url.pathname, q = k => url.searchParams.get(k) || "";

  if (req.method === "GET") {
    if (p === "/") {
      const body = Buffer.from(fs.readFileSync(INDEX_HTML, "utf8").replace("__TOKEN__", TOKEN));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (p === "/api/info") {
      const [, src] = apiKeyEnv();
      return sendJson(res, { claude_bin: CLAUDE_BIN, default_cwd: defaultCwd, home: HOME, api_key_present: !!src, api_key_from: src });
    }
    if (p === "/api/sessions") return sendJson(res, listSessions(q("cwd")));
    if (p === "/api/sessions/all") return sendJson(res, listAllSessions(q("exclude")));
    if (p === "/api/history") return sendJson(res, sessionHistory(q("cwd"), q("id")));
    if (p.startsWith("/api/stream/")) {
      const run = RUNS.get(p.split("/").pop());
      return run ? stream(req, res, run) : sendJson(res, { error: "unknown run" }, 404);
    }
  } else if (req.method === "POST") {
    if (p === "/api/run") {
      let o;
      try { o = await readBody(req); } catch (e) { return sendJson(res, { error: e.message }, 400); }
      const cwd = normCwd(o.cwd) || defaultCwd;
      if (!isDir(cwd)) return sendJson(res, { error: `not a directory: ${cwd}` }, 400);
      const sid = o.session_id;
      if (sid && !sessionFile(cwd, sid))
        return sendJson(res, { error: `session ${sid} is not stored for ${cwd}; a session keeps the ` +
                                      "directory it started in (click New to use another directory)" }, 400);
      let prompt = String(o.prompt || "");
      let images;
      try { images = checkImages(o.images); } catch (e) { return sendJson(res, { error: e.message }, 400); }
      if (!prompt.trim() && !images.length) return sendJson(res, { error: "empty prompt" }, 400);
      o.images = images;
      prompt = userMessageLine(prompt, images);
      const [env, src] = apiKeyEnv();
      const require = o.require_api_key ?? true;
      if (require && !src)
        return sendJson(res, { error: `ANTHROPIC_API_KEY is not set (env, ${SETTINGS_FILE} env, or ` +
                                      `${KEY_FILE}) and 'Require API key' is on` }, 400);
      if (String(o.browser || "").startsWith("playwright")) {
        try { o.playwright_url = await ensurePlaywright(String(o.browser)); }
        catch (e) { return sendJson(res, { error: e.message }, 500); }
      }
      let argv;
      try { argv = buildArgv(o); } catch (e) { return sendJson(res, { error: `extra args: ${e.message}` }, 400); }
      const id = crypto.randomBytes(8).toString("hex");
      let run;
      try { run = new Run(id, argv, cwd, prompt, env, !!require, o.session_id, o.browser); }
      catch (e) { return sendJson(res, { error: `cannot start ${CLAUDE_BIN}: ${e.message}` }, 500); }
      RUNS.set(id, run);
      return sendJson(res, { run_id: id, argv, cwd, images: images.length });
    }
    if (p.startsWith("/api/steer/")) {
      const run = RUNS.get(p.split("/").pop());
      if (!run) return sendJson(res, { error: "unknown run" }, 404);
      let o, images;
      try { o = await readBody(req); images = checkImages(o.images); }
      catch (e) { return sendJson(res, { error: e.message }, 400); }
      const text = String(o.prompt || "");
      if (!text.trim() && !images.length) return sendJson(res, { error: "empty prompt" }, 400);
      return sendJson(res, { ok: run.steer(userMessageLine(text, images)), images: images.length });
    }
    if (p.startsWith("/api/stop/")) {
      const run = RUNS.get(p.split("/").pop());
      if (run) run.stop();
      return sendJson(res, { ok: !!run });
    }
  }
  sendJson(res, { error: "not found" }, 404);
}

// ---------- main ------------------------------------------------------------

const HELP = `claude-api-ui ${PKG.version} — local web UI for \`claude -p\`, billed to your API key

Usage: claude-api-ui [--cwd DIR] [--port N] [--no-browser]

  --cwd DIR      default working directory for claude (default: current directory)
  --port N       port to listen on, 127.0.0.1 only (default: 8765, or the next free one)
  --no-browser   don't open the browser, just print the URL
  -v, --version  print the version
  -h, --help     show this help

API key: ANTHROPIC_API_KEY from the environment, "env" in ~/.claude/settings.json,
or ~/.config/claude-api-ui/api_key. Set CLAUDE_BIN to use a specific claude binary.`;

function parseArgs(argv) {
  const a = { port: 8765, cwd: process.cwd(), browser: true };
  for (let i = 0; i < argv.length; i++) {
    let [k, v] = argv[i].split(/=(.*)/s);
    const val = () => {
      if (v === undefined) v = argv[++i];
      if (v === undefined) fail(`${k} needs a value`);
      return v;
    };
    if (k === "-h" || k === "--help") { console.log(HELP); process.exit(0); }
    else if (k === "-v" || k === "--version") { console.log(PKG.version); process.exit(0); }
    else if (k === "--no-browser") a.browser = false;
    else if (k === "--port") { a.port = Number(val()); if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) fail("bad --port"); }
    else if (k === "--cwd") a.cwd = val();
    else fail(`unknown option: ${argv[i]}`);
  }
  return a;
}

function fail(msg) { console.error(`claude-api-ui: ${msg}\n\n${HELP}`); process.exit(2); }

function listen(server, port, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onError = e => {
        if (e.code === "EADDRINUSE" && left > 1) attempt(p + 1, left - 1);
        else reject(e);
      };
      server.once("error", onError);
      server.listen(p, "127.0.0.1", () => { server.off("error", onError); resolve(p); });
    };
    attempt(port, tries);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const defaultCwd = normCwd(a.cwd);
  if (!isDir(defaultCwd)) fail(`not a directory: ${defaultCwd}`);
  const server = http.createServer((req, res) => {
    handle(req, res, defaultCwd).catch(e => {
      if (!res.headersSent) sendJson(res, { error: String(e && e.message || e) }, 500);
      else res.end();
    });
  });
  let port;
  try { port = await listen(server, a.port); }
  catch (e) { console.error(`claude-api-ui: cannot listen: ${e.message}`); process.exit(1); }
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  console.log(`claude-api-ui on ${url}\n  claude:  ${CLAUDE_BIN}\n  cwd:     ${defaultCwd}\n` +
              `  API key: ${apiKeyEnv()[1] || "NOT SET"}\nCtrl+C to quit.`);
  if (a.browser) setTimeout(() => openBrowser(url), 400);
  const quit = () => { for (const r of RUNS.values()) r.stop(); stopPlaywright(); setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main();
