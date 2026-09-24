const vscode = require("vscode")
const path = require("path")
const fs = require("fs")
const util = require("util")
const { execFile } = require("child_process")

const execFileAsync = util.promisify(execFile)

const EXT_DIR = __dirname
const MEDIA_DIR = path.join(EXT_DIR, "media")
const execFileSync2 = require("child_process").execFileSync
const isWin = process.platform === "win32"

function deduceCandidates() {
  const list = []
  if (process.env.OPENCODE_EXE) list.push(process.env.OPENCODE_EXE)
  const dirs = String(process.env.Path || process.env.PATH || "").split(isWin ? ";" : ":")
  for (const d of dirs) {
    if (d) {
      list.push(path.join(d, isWin ? "opencode.exe" : "opencode"))
      if (isWin) list.push(path.join(d, "opencode.cmd"))
    }
  }
  try {
    const home = require("os").homedir()
    list.push(path.join(home, "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"))
    list.push(path.join(home, ".opencode", "bin", "opencode.exe"))
  } catch {}
  return list
}

function resolveOpenCodeExe() {
  const seen = new Set()
  for (const c of deduceCandidates()) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    try {
      if (!fs.existsSync(c)) continue
      const st = fs.statSync(c)
      if (!st.isFile()) continue
      execFileSync2(c, ["--version"], { timeout: 5000, windowsHide: true })
      return c
    } catch {}
  }
  return isWin ? "opencode.exe" : "opencode"
}

const OPENCODE_EXE = resolveOpenCodeExe()

const SESSIONS_SQL =
  "SELECT s.id AS id, s.title AS title, s.directory AS directory, " +
  "s.time_updated AS time_updated " +
  "FROM session s WHERE s.time_archived IS NULL AND s.title IS NOT NULL AND s.title != '' " +
  "ORDER BY s.time_updated DESC LIMIT 25"

const STATUS_SQL =
  "SELECT s.id AS id, s.title AS title, s.model AS model, s.agent AS agent, " +
  "COALESCE(json_extract(p.data, '$.tokens.total'), s.tokens_input + s.tokens_output) AS t_total, " +
  "COALESCE(json_extract(p.data, '$.tokens.input'), s.tokens_input) AS t_input, " +
  "COALESCE(json_extract(p.data, '$.tokens.output'), s.tokens_output) AS t_output, " +
  "COALESCE(json_extract(p.data, '$.tokens.reasoning'), s.tokens_reasoning) AS t_reasoning, " +
  "COALESCE(json_extract(p.data, '$.tokens.cache.read'), s.tokens_cache_read) AS t_cache_read, " +
  "COALESCE(json_extract(p.data, '$.tokens.cache.write'), s.tokens_cache_write) AS t_cache_write, " +
  "COALESCE(json_extract(p.data, '$.cost'), s.cost) AS cost " +
  "FROM session s " +
  "LEFT JOIN part p ON p.session_id = s.id AND json_extract(p.data, '$.type') = 'step-finish' " +
  "AND p.time_updated = (SELECT MAX(time_updated) FROM part WHERE session_id = s.id AND json_extract(data, '$.type') = 'step-finish') " +
  "WHERE s.time_archived IS NULL ORDER BY s.time_updated DESC LIMIT 1"

let panel = null
let reconcileTimer = null
let statusTimer = null
let modelLimitCache = {}
let lspCache = { t: 0, value: null }

function collectMedia() {
  try {
    return fs
      .readdirSync(MEDIA_DIR)
      .filter((f) => /\.(gif|png|jpe?g|webp)$/i.test(f))
      .sort()
  } catch {
    return []
  }
}

function collectAudio() {
  try {
    return fs
      .readdirSync(MEDIA_DIR)
      .filter((f) => /\.(mp3|wav)$/i.test(f))
      .sort()
  } catch {
    return []
  }
}

async function querySessions() {
  try {
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["db", SESSIONS_SQL, "--format", "json"],
      { timeout: 8000, windowsHide: true }
    )
    const rows = JSON.parse(stdout.trim())
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function parseModel(s) {
  try {
    const o = JSON.parse(s)
    if (o && o.id) {
      const prov = o.providerID && o.providerID !== "opencode" ? " · " + o.providerID : ""
      return o.id + prov + (o.variant && o.variant !== "default" ? " · " + o.variant : "")
    }
  } catch {}
  return String(s || "未知模型")
}

async function getContextLimit(modelId, providerId) {
  const key = (providerId || "opencode") + "/" + (modelId || "")
  if (modelLimitCache[key] !== undefined) return modelLimitCache[key]
  try {
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["models", providerId || "opencode", "--verbose"],
      { timeout: 20000, windowsHide: true }
    )
    const blocks = String(stdout).split(/\r?\n(?=\{)/)
    for (const b of blocks) {
      if (!b.trim().startsWith("{")) continue
      try {
        const o = JSON.parse(b)
        if (o && o.id === modelId && o.limit && o.limit.context) {
          modelLimitCache[key] = o.limit.context
          return modelLimitCache[key]
        }
      } catch {}
    }
  } catch {}
  modelLimitCache[key] = 200000
  return modelLimitCache[key]
}

async function lspEnabled() {
  if (Date.now() - lspCache.t < 60e3) return lspCache.value
  lspCache.t = Date.now()
  try {
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["debug", "config"],
      { timeout: 8000, windowsHide: true }
    )
    const cfg = JSON.parse(String(stdout).trim() || "{}")
    lspCache.value = !!(cfg.lsp && typeof cfg.lsp === "object" && Object.keys(cfg.lsp).length)
  } catch {
    lspCache.value = false
  }
  return lspCache.value
}

async function queryStatus() {
  try {
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["db", STATUS_SQL, "--format", "json"],
      { timeout: 8000, windowsHide: true }
    )
    const row = JSON.parse(stdout.trim())
    if (!Array.isArray(row) || !row.length) return null
    const r = row[0]
    let raw = null
    try { raw = JSON.parse(r.model) } catch {}
    r.contextLimit = await getContextLimit(raw && raw.id ? raw.id : r.model, raw && raw.providerID ? raw.providerID : "opencode")
    r.lsp = await lspEnabled()
    r.model = parseModel(r.model)
    r.t_total = Number(r.t_total) || 0
    r.t_input = Number(r.t_input) || 0
    r.t_output = Number(r.t_output) || 0
    r.t_reasoning = Number(r.t_reasoning) || 0
    r.t_cache_read = Number(r.t_cache_read) || 0
    r.t_cache_write = Number(r.t_cache_write) || 0
    r.cost = Number(r.cost) || 0
    return r
  } catch {
    return null
  }
}

function fmt(ms) {
  if (!ms) return ""
  const diff = Date.now() - ms
  if (diff < 60e3) return "刚刚"
  if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前"
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前"
  const d = new Date(ms)
  return (
    d.getMonth() + 1 + "月" + d.getDate() + "日 " +
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0")
  )
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildHtml(webview, mediaFiles, sessions, status, audioFiles) {
  const media = mediaFiles.map((f) => ({
    file: f,
    uri: webview
      .asWebviewUri(vscode.Uri.file(path.join(MEDIA_DIR, f)))
      .toString()
  }))
  const tracks = (audioFiles || []).map((f) => ({
    file: f,
    uri: webview
      .asWebviewUri(vscode.Uri.file(path.join(MEDIA_DIR, f)))
      .toString()
  }))
  const mediaJson = JSON.stringify(media).replace(/</g, "\\u003c")
  const trackJson = JSON.stringify(tracks).replace(/</g, "\\u003c")
  const listJson = JSON.stringify(
    (sessions || []).map((s) => ({
      id: s.id,
      title: s.title,
      dir: s.directory || "",
      time: s.time_updated || 0
    }))
  ).replace(/</g, "\\u003c")
  const statusJson = JSON.stringify(status || null).replace(/</g, "\\u003c")
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; media-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html, body {
  margin: 0; padding: 0; height: 100%;
}
body {
  background: #1b1b1f; color: #e8e8e8;
  font-family: "Microsoft YaHei", system-ui, sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
#stage { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; padding: 10px 8px 2px; }
#pic { max-width: 96%; max-height: 240px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45); }
#bar { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 8px 8px; flex-wrap: wrap; }
#bar button { background: #3a3d41; color: #fff; border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
#bar button:hover { background: #50535a; }
#meta { font-size: 11px; color: #8b8b93; }
#player {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 8px; flex-wrap: wrap;
  border-top: 1px solid #2f2f33; margin-top: 2px;
}
#player button { background: #3a3d41; color: #fff; border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
#player button:hover { background: #50535a; }
#trackName { flex: 1; min-width: 0; font-size: 11px; color: #8be9c6; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#aud { display: none; }
#progressRow {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 0 10px 8px;
}
#seek {
  flex: 1; -webkit-appearance: none; appearance: none;
  height: 4px; border-radius: 2px; background: #3a3d41; outline: none; cursor: pointer;
}
#seek::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 12px; height: 12px; border-radius: 50%;
  background: #8be9c6; cursor: pointer; border: none;
}
#curTime, #durTime { font-size: 11px; color: #8b8b93; min-width: 34px; text-align: center; }
#status {
  flex: 0 0 auto; margin-top: 8px; max-height: 150px; overflow-y: auto;
  font-size: 11px; color: #9fe8c0; background: #101014;
  border-top: 1px solid #3c3c3c; border-bottom: 1px solid #3c3c3c;
  padding: 4px 8px; white-space: pre-line; line-height: 1.8;
}
#status .lbl { color: #69c68a; font-weight: bold; }
#status .val { color: #ffffff; }
#head { display: flex; align-items: center; padding: 6px 10px; font-size: 12px; color: #8be9c6; letter-spacing: 1px; border-bottom: 1px solid #3c3c3c; gap: 8px; }
#head .reload { margin-left: auto; background: none; border: none; color: #8be9c6; cursor: pointer; font-size: 14px; }
#sess { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
#empty { color: #777; font-size: 12px; text-align: center; padding: 16px 10px; }
.item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: transparent; border: none; border-bottom: 1px solid #2f2f33;
  color: #e8e8e8; text-align: left; padding: 7px 4px; cursor: pointer;
}
.item:hover { background: #26262b; }
.item .t { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.item .ts { flex: 0 0 auto; font-size: 10px; color: #8b8b93; }
</style>
</head>
<body>
<div id="stage"><img id="pic" alt=""></div>
<div id="bar">
  <button id="prev">◀</button>
  <button id="next">▶</button>
  <button id="loop">▶ 自动轮播</button>
  <span id="meta"></span>
</div>
<div id="player">
  <button id="playPause">▶ 播放</button>
  <button id="nextTrack">⏭ 下一首</button>
  <span id="trackName">♩ 待播放</span>
  <audio id="aud"></audio>
</div>
<div id="progressRow">
  <span id="curTime">0:00</span>
  <input type="range" id="seek" min="0" max="0" step="0.1" value="0">
  <span id="durTime">0:00</span>
</div>
<div id="status">♬ 正在读取状态…</div>
<div id="head">◈ 历史对话 · 点击恢复原会话<span><button class="reload" id="reload">↻ 刷新</button></span></div>
<div id="sess"><div id="empty">加载中…</div></div>
<script>
const vscode = acquireVsCodeApi()
const media = ${mediaJson}
const list = ${listJson}
const tracks = ${trackJson}
let i = 0
let timer = null
let ti = 0
const pic = document.getElementById("pic")
const meta = document.getElementById("meta")
const sess = document.getElementById("sess")
const statusEl = document.getElementById("status")
const audio = document.getElementById("aud")
const playPauseBtn = document.getElementById("playPause")
const trackNameEl = document.getElementById("trackName")
const seek = document.getElementById("seek")
const curTimeEl = document.getElementById("curTime")
const durTimeEl = document.getElementById("durTime")

function fmtClock(s) {
  s = Math.max(0, Math.floor(isFinite(s) ? s : 0))
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
}

function resetSeek() {
  seek.max = 0
  seek.value = 0
  curTimeEl.textContent = "0:00"
  durTimeEl.textContent = "0:00"
}

function updateSeek() {
  const d = isFinite(audio.duration) ? audio.duration : 0
  seek.max = d > 0 ? d : 0
  seek.value = Math.min(audio.currentTime || 0, d > 0 ? d : 0)
  curTimeEl.textContent = fmtClock(audio.currentTime)
  durTimeEl.textContent = d > 0 ? fmtClock(d) : "0:00"
}

["timeupdate", "loadedmetadata", "durationchange"].forEach((ev) =>
  audio.addEventListener(ev, updateSeek)
)
audio.addEventListener("play", () => { playPauseBtn.textContent = "⏸ 暂停" })
audio.addEventListener("pause", () => { playPauseBtn.textContent = "▶ 播放" })

seek.addEventListener("input", () => {
  curTimeEl.textContent = fmtClock(Number(seek.value))
})
seek.addEventListener("change", () => {
  if (Number(seek.max) > 0) audio.currentTime = Number(seek.value)
})

function fmtFull(n) {
  return Number(n || 0).toLocaleString("en-US")
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function renderStatus(r) {
  if (!r) {
    statusEl.innerHTML = '<span class="lbl">Context</span>\\n<span class="val">—</span> tokens\\n<span class="val">—%</span> used\\n<span class="val">$0.00</span> spent\\n<span class="lbl">LSP</span>\\n<span class="val">LSPs are disabled</span>'
    return
  }
  const ctx = r.t_total || 0
  const pct = r.contextLimit && r.contextLimit > 0 ? Math.round((ctx / r.contextLimit) * 100) : 0
  const lines = []
  if (r.title) lines.push('<span class="lbl">▶ 当前对话：</span><span class="val">' + esc(r.title) + "</span>")
  lines.push('<span class="lbl">Context</span>')
  lines.push('<span class="val">' + fmtFull(ctx) + "</span> tokens")
  lines.push('<span class="val">' + pct + "%</span> used")
  lines.push('<span class="val">$' + (Number(r.cost) === 0 ? "0.00" : Number(r.cost).toFixed(4)) + "</span> spent")
  lines.push('<span class="lbl">LSP</span>')
  lines.push('<span class="val">' + (r.lsp ? "LSPs are enabled" : "LSPs are disabled") + "</span>")
  if (r.model) lines.push('<span class="lbl">model ·</span> <span class="val">' + esc(r.model) + "</span>")
  if (r.agent) lines.push('<span class="lbl">agent ·</span> <span class="val">' + esc(r.agent) + "</span>")
  statusEl.innerHTML = lines.join("\\n")
  statusEl.title = r.title || ""
}

renderStatus(${statusJson})

function show() {
  if (!media.length) {
    pic.removeAttribute("src")
    meta.textContent = "0 / 0"
    return
  }
  pic.src = media[i].uri
  pic.title = media[i].file
  meta.textContent = (i + 1) + " / " + media.length + " · " + media[i].file
}

function trackBase(name) {
  return name.replace(/\.(mp3|wav)$/i, "")
}

function showTrackErr(e) {
  resetSeek()
  trackNameEl.textContent = "⚠ 无法播放：" + (e && e.message ? e.message : e)
  playPauseBtn.textContent = "▶ 播放"
}

function loadTrack(idx) {
  if (!tracks.length) {
    trackNameEl.textContent = "♩ 无音频（media 目录下放 mp3/wav）"
    return
  }
  ti = ((idx % tracks.length) + tracks.length) % tracks.length
  audio.src = tracks[ti].uri
  resetSeek()
  trackNameEl.textContent = "♩ " + trackBase(tracks[ti].file)
  const p = audio.play()
  if (p && p.then) {
    p.then(() => { playPauseBtn.textContent = "⏸ 暂停" }).catch(() => {
      audio.addEventListener("error", function stuck() {
        audio.removeEventListener("error", stuck)
        if (tracks.length > 1) loadTrack(ti + 1)
        else showTrackErr("该文件无法解码，请换用标准 MP3/WAV")
      })
      audio.load()
    })
  } else {
    playPauseBtn.textContent = "⏸ 暂停"
  }
}

playPauseBtn.onclick = () => {
  if (!tracks.length) {
    trackNameEl.textContent = "♩ 无音频（media 目录下放 mp3/wav）"
    return
  }
  if (audio.paused) {
    if (!audio.src) loadTrack(ti)
    else {
      const p = audio.play()
      if (p && p.then) p.then(() => { playPauseBtn.textContent = "⏸ 暂停" }).catch(showTrackErr)
      else playPauseBtn.textContent = "⏸ 暂停"
    }
  } else {
    audio.pause()
    playPauseBtn.textContent = "▶ 播放"
  }
}
document.getElementById("nextTrack").onclick = () => {
  if (!tracks.length) return
  loadTrack(ti + 1)
}
audio.addEventListener("ended", () => {
  if (tracks.length) loadTrack(ti + 1)
})
audio.addEventListener("error", () => {
  const err = audio.error
  showTrackErr(err ? "音频错误 code=" + err.code : "未知错误")
})
if (tracks.length) {
  ti = 0
  audio.src = tracks[0].uri
  trackNameEl.textContent = "♩ " + trackBase(tracks[0].file)
  playPauseBtn.textContent = "▶ 播放"
}

document.getElementById("prev").onclick = () => {
  if (!media.length) return
  i = (i + media.length - 1) % media.length
  show()
}
document.getElementById("next").onclick = () => {
  if (!media.length) return
  i = (i + 1) % media.length
  show()
}
const loopBtn = document.getElementById("loop")
loopBtn.onclick = () => {
  if (media.length < 2) return
  if (timer) {
    clearInterval(timer)
    timer = null
    loopBtn.textContent = "▶ 自动轮播"
  } else {
    timer = setInterval(() => { i = (i + 1) % media.length; show() }, 1300)
    loopBtn.textContent = "■ 停止"
  }
}
document.getElementById("reload").onclick = () => vscode.postMessage({ type: "refresh" })

function fmt(ms) {
  if (!ms) return ""
  const diff = Date.now() - ms
  if (diff < 60e3) return "刚刚"
  if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前"
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前"
  const d = new Date(ms)
  return (
    (d.getMonth() + 1) + "月" + d.getDate() + "日 " +
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0")
  )
}

function render(list) {
  if (!list || !list.length) {
    sess.innerHTML = '<div id="empty">还没有历史对话 —— 去 opencode 聊一次吧 ♪</div>'
    return
  }
  sess.innerHTML = ""
  list.forEach((s) => {
    const b = document.createElement("button")
    b.className = "item"
    const t = document.createElement("span")
    t.className = "t"
    t.textContent = s.title
    const ts = document.createElement("span")
    ts.className = "ts"
    ts.textContent = fmt(s.time)
    b.appendChild(t)
    b.appendChild(ts)
    b.title = (s.dir || "") + " · " + s.id
    b.onclick = () => vscode.postMessage({ type: "resume", sessionId: s.id, directory: s.dir })
    sess.appendChild(b)
  })
}

render(list)
show()

window.addEventListener("message", (ev) => {
  const m = ev.data
  if (m.type === "sessions") render(m.items || [])
  if (m.type === "reload") show()
  if (m.type === "status") renderStatus(m.data)
})
</script>
</body>
</html>`
}

async function finalizeHtml(panel) {
  const [mediaFiles, sessions, status, audioFiles] = await Promise.all([
    Promise.resolve(collectMedia()),
    querySessions(),
    queryStatus(),
    Promise.resolve(collectAudio())
  ])
  if (panel && panel.webview) {
    panel.webview.html = buildHtml(panel.webview, mediaFiles, sessions, status, audioFiles)
  }
}

async function pushStatus() {
  if (!panel || !panel.webview) return
  const status = await queryStatus()
  if (panel && panel.webview) {
    panel.webview.postMessage({ type: "status", data: status })
  }
}

function startStatusTimer() {
  if (statusTimer) return
  statusTimer = setInterval(pushStatus, 5000)
}

function stopStatusTimer() {
  clearInterval(statusTimer)
  statusTimer = null
}

async function openPanel() {
  if (panel) {
    panel.reveal(undefined, true)
    return
  }
  const cols = vscode.window.tabGroups.all
    .map((g) => g.viewColumn)
    .filter((c) => c && c > 0)
  const rightMost = cols.length ? Math.max.apply(null, cols) : 1
  panel = vscode.window.createWebviewPanel(
    "miku.sidebar",
    "OpenCode工具插件",
    { viewColumn: rightMost + 1 },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(MEDIA_DIR)] }
  )
  panel.iconPath = vscode.Uri.file(path.join(MEDIA_DIR, "icon.svg"))
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "refresh") {
      await finalizeHtml(panel)
      pushStatus()
    } else if (msg.type === "resume") {
      resumeSession(msg.sessionId, msg.directory)
    }
  })
  panel.onDidDispose(() => {
    panel = null
    stopStatusTimer()
  })
  await finalizeHtml(panel)
  startStatusTimer()
  pushStatus()
}

const shell = /(powershell|pwsh)\.exe$/i.test(String(vscode.env.shell || ""))
  ? "pwsh"
  : /cmd\.exe$/i.test(String(vscode.env.shell || ""))
    ? "cmd"
    : "other"

function resumeCommand(sessionId, port) {
  const exe = '"' + OPENCODE_EXE.replace(/\\/g, "/") + '"'
  const args = " --session " + sessionId + " --port " + port
  return shell === "pwsh" ? "& " + exe + args : exe + args
}

async function findOpencodeTerminal() {
  const list = vscode.window.terminals
  const results = await Promise.all(list.map(isOpencodeTerminal))
  const idx = results.findIndex(Boolean)
  return idx >= 0 ? list[idx] : null
}

async function focusTerminal(term) {
  try {
    term.show(true)
    await vscode.commands.executeCommand("workbench.action.terminal.focus")
  } catch {
    term.show(true)
  }
}

async function resumeSession(sessionId, directory) {
  const port = 30000 + Math.floor(Math.random() * 20000)
  if (!panel) openPanel()
  const cols = vscode.window.tabGroups.all
    .map((g) => g.viewColumn)
    .filter((c) => c && c > 0)
  const panelCol = panel && panel.viewColumn ? panel.viewColumn : null
  const rightMost = cols.length ? Math.max.apply(null, cols) : 1
  const opencodeCol = panelCol != null && panelCol > 1 ? panelCol - 1 : rightMost + 1
  const term = vscode.window.createTerminal({
    name: "opencode " + String(sessionId).slice(-6),
    cwd: directory || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath),
    location: { viewColumn: opencodeCol }
  })
  term.sendText(resumeCommand(sessionId, port))
  term.show()
  reconcile()
}

async function isOpencodeTerminal(t) {
  if (/opencode/i.test(t.name || "")) return true
  try {
    const pid = await t.processId
    if (!pid) return false
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine"
      ],
      { timeout: 2500, windowsHide: true }
    )
    return /opencode/i.test(stdout || "")
  } catch {
    return false
  }
}

async function reconcile() {
  const list = vscode.window.terminals
  const results = await Promise.all(list.map(isOpencodeTerminal))
  if (results.some(Boolean) && !panel) openPanel()
}

function scheduleReconcile() {
  clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(reconcile, 500)
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("miku.openRight", openPanel),
    vscode.window.onDidOpenTerminal(scheduleReconcile),
    vscode.window.onDidCloseTerminal(scheduleReconcile)
  )
  scheduleReconcile()
}

function deactivate() {}

module.exports = { activate, deactivate }
