import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionCatalog, parseSessionFile } from "./session-parser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);
const PANEL_SOURCE = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "trajectory-panel.js"), "utf8");
const PANEL_VERSION = PANEL_SOURCE.match(/const VERSION = "([^"]+)"/)?.[1] || "";
const SUPPORT_DIR = path.join(os.homedir(), ".codex", "trajectory-panel");
const LOG_PATH = path.join(SUPPORT_DIR, "companion.log");
const PASSIVE = process.argv.includes("--passive");
function portArgument(name, fallback) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = arg ? Number(arg.split("=")[1]) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}
const DEBUG_PORT = portArgument("port", 9333);
const CONTROL_PORT = portArgument("control-port", 19333);
const LOOPBACK = "127.0.0.1";
const START_ARGS = ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${DEBUG_PORT}`];
const catalog = new SessionCatalog();
fs.mkdirSync(SUPPORT_DIR, { recursive: true });

function log(message, error) {
  const suffix = error ? ` · ${error?.stack || error}` : "";
  const line = `${new Date().toISOString()} ${message}${suffix}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
    const size = fs.statSync(LOG_PATH).size;
    if (size > 1_500_000) fs.writeFileSync(LOG_PATH, fs.readFileSync(LOG_PATH, "utf8").slice(-500_000));
  } catch {}
}

function requestedCommand() {
  if (process.argv.includes("--shutdown")) return "shutdown";
  if (PASSIVE) return "passive";
  if (process.argv.includes("--launch")) return "launch";
  if (process.argv.includes("--idle")) return "idle";
  if (process.argv.includes("--watchdog")) return "watchdog";
  return "startup";
}

function notifyExisting(command) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: LOOPBACK, port: CONTROL_PORT });
    let finished = false;
    const done = (connected) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once("connect", () => { socket.write(`${command}\n`, () => done(true)); });
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function powershell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
}

function findCodexExecutable(refresh = false) {
  const override = process.env.CODEX_APP_PATH;
  if (override && fs.existsSync(override)) return path.resolve(override);
  const cached = path.join(SUPPORT_DIR, "codex-path.txt");
  if (!refresh) {
    try {
      const candidate = fs.readFileSync(cached, "utf8").trim();
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  const script = "$p=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1;if($p){$m=[xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml'));$e=($m.Package.Applications.Application | Select-Object -First 1).Executable;if($e){Join-Path $p.InstallLocation $e}}";
  const result = powershell(script);
  const found = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!found || !fs.existsSync(found)) throw new Error("没有找到 Microsoft Store 版 Codex");
  fs.writeFileSync(cached, found);
  return found;
}

function processIdsFor(executable) {
  const quoted = executable.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Where-Object {$_.ExecutablePath -eq '${quoted}'} | ForEach-Object {$_.ProcessId}`;
  const result = powershell(script);
  return String(result.stdout || "").split(/\r?\n/).map(Number).filter(Number.isFinite);
}

function stopCodex(executable) {
  const quoted = executable.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Where-Object {$_.ExecutablePath -eq '${quoted}'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`;
  powershell(script);
}

let codexExecutable = "";
let managedLaunchAt = 0;
let everConnected = false;
let observedAbsentAfterConnect = false;
let repairCandidateSince = 0;
let stopping = false;

function startCodex({ replace = false } = {}) {
  if (PASSIVE) { log("Passive mode: application launch/restart refused"); return; }
  try {
    codexExecutable ||= findCodexExecutable();
    if (replace) stopCodex(codexExecutable);
    setTimeout(() => {
      const child = spawn(codexExecutable, START_ARGS, {
        cwd: path.dirname(codexExecutable), windowsHide: false, stdio: "ignore",
      });
      child.once("error", (error) => { if (!stopping) log("Codex 启动失败", error); });
      child.unref();
      managedLaunchAt = Date.now();
      repairCandidateSince = 0;
      log(`已启动 Codex（CDP ${DEBUG_PORT}）`);
    }, replace ? 900 : 0);
  } catch (error) {
    log("启动 Codex 失败", error);
  }
}

async function jsonEndpoint(route) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://${LOOPBACK}:${DEBUG_PORT}${route}`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); this.socket = socket; resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); }, { once: true });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => this.close());
    });
    await this.call("Runtime.enable");
  }
  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message.id || !this.pending.has(message.id)) return;
    const { resolve, reject, timer } = this.pending.get(message.id);
    clearTimeout(timer);
    this.pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP 未连接"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 6000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    return result?.result?.value;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("CDP 已断开")); }
    this.pending.clear();
    try { this.socket?.close(); } catch {}
  }
}

let cdp = null;
let targetSocketUrl = "";
let lastContextKey = "";
let lastSessionId = "";
let lastSessionMtime = 0;
let lastForceRefresh = 0;

async function ensureCdp() {
  const targets = await jsonEndpoint("/json/list");
  if (!Array.isArray(targets)) return false;
  const target = targets.find((item) => item.type === "page" && item.url === "app://-/index.html")
    || targets.find((item) => item.type === "page" && /^app:\/\/-\/index\.html/.test(item.url || "") && !/[?&]initialRoute=/.test(item.url || ""));
  if (!target?.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${DEBUG_PORT}/`)) return false;
  if (cdp && !cdp.closed && targetSocketUrl === target.webSocketDebuggerUrl) return true;
  cdp?.close();
  targetSocketUrl = target.webSocketDebuggerUrl;
  cdp = new CdpClient(targetSocketUrl);
  try {
    await cdp.connect();
    await cdp.evaluate(PANEL_SOURCE);
  } catch (error) {
    cdp?.close();
    cdp = null;
    targetSocketUrl = "";
    throw error;
  }
  lastContextKey = "";
  lastSessionMtime = 0;
  log("轨迹面板已注入 Codex");
  return true;
}

async function syncPanel() {
  if (!await ensureCdp()) return false;
  try {
    const version = await cdp.evaluate("window.__codexTrajectoryPanel?.version || ''");
    if (version !== PANEL_VERSION) {
      await cdp.evaluate(PANEL_SOURCE);
      lastContextKey = "";
    }
    const context = await cdp.evaluate("window.__codexTrajectoryPanel?.getContext?.() || {}") || {};
    const forceRefresh = Number(await cdp.evaluate("window.__codexTrajectoryPanelForceRefresh || 0")) || 0;
    const contextKey = JSON.stringify(context);
    const resolved = catalog.resolve(context);
    if (!resolved) {
      if (contextKey !== lastContextKey) {
        await cdp.evaluate(`window.__codexTrajectoryPanel?.updateData(${JSON.stringify({ error: "还没有识别到当前任务。请在左侧点开一个任务。" })})`);
        lastContextKey = contextKey;
      }
      return true;
    }
    const stat = fs.statSync(resolved.filePath);
    if (contextKey === lastContextKey && resolved.id === lastSessionId && stat.mtimeMs === lastSessionMtime && forceRefresh === lastForceRefresh) return true;
    const data = parseSessionFile(resolved.filePath, { maxEvents: 700, maxText: 9000 });
    data.title = resolved.title || context.selectedText || "当前任务轨迹";
    data.sourcePath = undefined;
    await cdp.evaluate(`window.__codexTrajectoryPanel?.updateData(${JSON.stringify(data)})`);
    lastContextKey = contextKey;
    lastSessionId = resolved.id;
    lastSessionMtime = stat.mtimeMs;
    lastForceRefresh = forceRefresh;
    return true;
  } catch (error) {
    log("同步轨迹失败", error);
    cdp?.close();
    cdp = null;
    return false;
  }
}

let syncing = false;
async function supervise() {
  if (stopping || syncing) return;
  syncing = true;
  try {
  const connected = await syncPanel().catch((error) => { log("连接 Codex 失败", error); return false; });
  if (connected) {
    everConnected = true;
    observedAbsentAfterConnect = false;
    repairCandidateSince = 0;
    return;
  }
  // A background companion must never replace a normally launched Codex.
  // Debug-enabled startup is reserved for the explicit `--launch` shortcut.
  } finally { syncing = false; }
}

const command = requestedCommand();
if (command === "watchdog") {
  try { codexExecutable = findCodexExecutable(true); } catch {}
}
if (await notifyExisting(command)) process.exit(0);
if (command === "shutdown") process.exit(0);

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(1500, () => socket.destroy());
  socket.on("error", () => {});
  socket.once("data", (value) => {
    const next = String(value).trim();
    socket.end(JSON.stringify({service:"codex-trajectory", mode:PASSIVE ? "passive" : command, debugPort:DEBUG_PORT, pid:process.pid}) + "\n");
    if (next === "shutdown") {
      stopping = true;
      cdp?.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    } else if (next === "launch" || next === "startup" || next === "watchdog") {
      if (PASSIVE || next !== "launch") return;
      jsonEndpoint("/json/version").then((healthy) => {
        if (healthy) return;
        const running = processIdsFor(codexExecutable || findCodexExecutable()).length > 0;
        startCodex({ replace: running });
      });
    }
  });
});
server.on("error", (error) => { log("控制端口启动失败", error); process.exit(1); });
server.listen(CONTROL_PORT, LOOPBACK, () => {
  log(`后台组件已启动（面板 v${PANEL_VERSION || "unknown"}，控制端口 ${CONTROL_PORT}）`);
  if (command === "launch") startCodex({ replace: false });
});

const timer = setInterval(supervise, 2200);
timer.unref();
process.on("uncaughtException", (error) => log("未捕获异常", error));
process.on("unhandledRejection", (error) => log("未处理异步异常", error));
