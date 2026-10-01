const vscode = require("vscode")
const path = require("path")
const fs = require("fs")
const http = require("http")
const util = require("util")
const { execFile } = require("child_process")

const execFileAsync = util.promisify(execFile)

let ncm = null
try {
  ncm = require(path.join(__dirname, "ncm.js"))
} catch {}

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
let ncmQrKey = null
let ncmQrTimer = null

function stopQrPoll() {
  if (ncmQrTimer) {
    clearInterval(ncmQrTimer)
    ncmQrTimer = null
  }
}

async function startQrPoll(p) {
  stopQrPoll()
  ncmQrTimer = setInterval(async () => {
    if (!p || !p.webview || !ncmQrKey) {
      stopQrPoll()
      return
    }
    try {
      const r = await ncm.qrCheck(ncmQrKey)
      if (r.code === 800) {
        stopQrPoll()
        p.webview.postMessage({ type: "ncm:qr", data: null, hint: "二维码已失效，请重新生成" })
      } else if (r.code === 802) {
        p.webview.postMessage({ type: "ncm:qr", data: null, hint: "已扫码，请在手机上确认" })
      } else if (r.code === 803) {
        stopQrPoll()
        ncmQrKey = null
        const u = await ncm.loadProfile().catch(() => null)
        p.webview.postMessage({ type: "ncm:user", data: u })
        p.webview.postMessage({ type: "ncm:msg", text: "扫码登录成功" })
      }
    } catch {}
  }, 2000)
}

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

function mapSessions(sessions) {
  return (sessions || []).map((s) => ({
    id: s.id,
    title: s.title,
    dir: s.directory || "",
    time: s.time_updated || 0
  }))
}

async function runDb(sql) {
  const { stdout } = await execFileAsync(
    OPENCODE_EXE,
    ["db", sql, "--format", "json"],
    { timeout: 20000, windowsHide: true }
  )
  return JSON.parse(stdout.trim())
}

let kpCache = { sessionId: null, list: null, directory: null, t: 0 }

async function queryConversationText(sessionId) {
  const rows = await runDb(
    "SELECT p.data AS pdata, m.data AS mdata FROM part p JOIN message m ON m.id = p.message_id " +
    "WHERE p.session_id='" + sessionId + "' AND json_extract(p.data,'$.type')='text' ORDER BY p.time_created"
  )
  const lines = []
  for (const r of rows) {
    try {
      const p = JSON.parse(r.pdata)
      const m = JSON.parse(r.mdata)
      if (p.synthetic || p.ignored) continue
      const txt = String(p.text || "").trim()
      if (!txt) continue
      const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统"
      lines.push("[" + role + "] " + txt)
    } catch {}
  }
  let joined = lines.join("\n")
  const max = 60000
  if (joined.length > max) joined = "…（前文省略）…\n" + joined.slice(-max)
  return joined
}

function parseKp(s) {
  s = String(s || "")
  const a = s.indexOf("[")
  const b = s.lastIndexOf("]")
  if (a < 0 || b <= a) return []
  try {
    const arr = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(arr) ? arr.filter((x) => x && x.name) : []
  } catch {
    return []
  }
}

async function extractKeyPoints(text) {
  const prompt =
    "你是对话要点提取助手。下面是某次 opencode 对话的纯文本记录（[用户]/[助手] 标注）。\n" +
    "请提取本次对话中最重要的知识点，要求：\n" +
    "1) 每个知识点给出 name（名称，简短 ≤12字）、summary（一句话简述，≤40字）、kw（用于在原文中定位该知识点讨论位置的独特关键词，必须原样取自对话文本中的 [用户] 消息，≤15字，优先取自较新的用户消息）；\n" +
    "2) 只输出 JSON 数组，格式 [{\"name\":\"...\",\"summary\":\"...\",\"kw\":\"...\"}]，不要输出任何其他文字或代码块标记。\n\n对话内容：\n" + text
  const tmp = path.join(require("os").tmpdir(), "opencode-kp-" + Date.now())
  try {
    fs.mkdirSync(tmp, { recursive: true })
    const child = execFile(OPENCODE_EXE, ["run", "--dir", tmp, "--title", "知识提取", "--format", "json", "-"], { timeout: 120000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 })
    child.stdin.end(prompt)
    const stdout = await new Promise((res, rej) => {
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", () => {})
      child.on("error", rej)
      child.on("close", (code) => (code === 0 ? res(out) : rej(new Error("run exit " + code + " " + out.slice(0, 300)))))
    })
    const lines = String(stdout).split(/\r?\n/).filter(Boolean)
    let sessionId = null
    let aiText = ""
    for (const line of lines) {
      try {
        const ev = JSON.parse(line)
        if (ev.sessionID && !sessionId) sessionId = ev.sessionID
        if (ev.type === "text" && ev.part && ev.part.text) aiText += ev.part.text
      } catch {}
    }
    if (sessionId) {
      try { await execFileAsync(OPENCODE_EXE, ["session", "delete", sessionId], { timeout: 10000, windowsHide: true }) } catch {}
    }
    return parseKp(aiText)
  } catch {
    return []
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

async function loadKeyPoints(sessionId, directory) {
  if (kpCache.sessionId === sessionId && kpCache.list && Date.now() - kpCache.t < 5 * 60e3) {
    return kpCache.list
  }
  const text = await queryConversationText(sessionId)
  const list = text ? await extractKeyPoints(text) : []
  kpCache = { sessionId, list, directory, t: Date.now() }
  return list
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 用户笔记持久化 ----------
const NOTES_FILE = (() => {
  try {
    return path.join(require("os").homedir(), ".opencode-tool-notes.json")
  } catch {
    return path.join(EXT_DIR, ".opencode-tool-notes.json")
  }
})()

function notesLoad() {
  try {
    const raw = fs.readFileSync(NOTES_FILE, "utf8")
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function notesSave(list) {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(Array.isArray(list) ? list : []), "utf8")
  } catch {}
}

function httpGetOk(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs || 2500 }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode === 200))
    })
    req.on("error", () => resolve(false))
    req.on("timeout", () => { req.destroy(); resolve(false) })
  })
}

async function waitForTuiHealth(port, attempts, gapMs) {
  const url = "http://127.0.0.1:" + port + "/global/health"
  for (let i = 0; i < attempts; i++) {
    if (await httpGetOk(url)) return true
    await sleep(gapMs)
  }
  return false
}

async function inputToSession(sessionId, directory, text) {
  let term = await findOpencodeTerminal(sessionId)
  let port = null
  if (!term && sessionId) {
    port = await resumeSession(sessionId, directory)
    for (let i = 0; i < 30 && !term; i++) {
      await sleep(600)
      term = await findOpencodeTerminal(sessionId)
    }
  }
  if (!term) return
  if (port) {
    await waitForTuiHealth(port, 30, 500)
    await sleep(2000)
  } else {
    await sleep(600)
  }
  await focusTerminal(term)
  try {
    term.sendText(String(text || "").slice(0, 300), false)
  } catch {}
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

let modelsCache = { t: 0, list: null }

function parseModelsOutput(s) {
  const lines = String(s || "").split(/\r?\n/)
  const starts = []
  lines.forEach((l, i) => { if (l.trim() === "{") starts.push(i) })
  const blocks = []
  for (let i = 0; i < starts.length; i++) {
    let depth = 0
    const buf = []
    for (let j = starts[i]; j < lines.length; j++) {
      buf.push(lines[j])
      for (const ch of lines[j]) { if (ch === "{") depth++; else if (ch === "}") depth-- }
      if (depth === 0) break
    }
    blocks.push(buf.join("\n"))
  }
  const out = []
  for (const b of blocks) {
    try {
      const o = JSON.parse(b)
      if (!o || !o.id) continue
      out.push({
        id: o.id,
        providerID: o.providerID || "",
        name: o.name || o.id,
        image: !!(o.capabilities && o.capabilities.input && o.capabilities.input.image),
        video: !!(o.capabilities && o.capabilities.input && o.capabilities.input.video),
        pdf: !!(o.capabilities && o.capabilities.input && o.capabilities.input.pdf),
        ctx: (o.limit && o.limit.context) || 0
      })
    } catch {}
  }
  return out
}

async function queryModels() {
  if (modelsCache.list && Date.now() - modelsCache.t < 10 * 60e3) return modelsCache.list
  try {
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["models", "--verbose"],
      { timeout: 25000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    )
    modelsCache = { t: Date.now(), list: parseModelsOutput(stdout) }
    return modelsCache.list
  } catch {
    return []
  }
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

function buildHtml(webview, mediaFiles, sessions, status, audioFiles, models) {
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
    mapSessions(sessions)
  ).replace(/</g, "\\u003c")
  const statusJson = JSON.stringify(status || null).replace(/</g, "\\u003c")
  const modelsJson = JSON.stringify(models || []).replace(/</g, "\\u003c")
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https: http:; media-src ${webview.cspSource} https: http: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'">
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
#ncmWrap {
  flex: 0 0 auto; display: flex; flex-direction: column;
  border-top: 1px solid #2f2f33; margin-top: 2px;
  font-size: 11px; color: #cfcfd6;
}
#ncmHead {
  display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  cursor: pointer; color: #ec4141; font-weight: bold;
}
#ncmHead .tgl { margin-left: auto; color: #ec4141; font-weight: normal; }
#ncmPane { padding: 2px 10px 10px; display: none; }
#ncmWrap.open #ncmPane { display: block; }
#ncmLogin {
  display: flex; flex-direction: column; gap: 6px;
}
#ncmUser { display: flex; align-items: center; gap: 6px; }
#ncmUser .u { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#ncmUser button { background: #3a3d41; color: #fff; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
#ncmLogin button { background: #3a3d41; color: #fff; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
#ncmLogin button:hover { background: #50535a; }
#ncmLogin input { background: #101014; color: #e8e8e8; border: 1px solid #3c3c3c; border-radius: 4px; padding: 3px 6px; font-size: 11px; width: 100%; }
#ncmModeTabs { display: flex; gap: 4px; margin-bottom: 4px; }
#ncmModeTabs button { flex: 1; background: #ec4141; color: #fff; font-weight: bold; border: 1px solid #c33536; }
#ncmModeTabs button.act { background: #c33536; }
#ncmModeTabs button:hover { background: #ec5a5a; }
#ncmModeTabs button.act:hover { background: #c33536; }
#ncmPane.kv2 #ncmQrBox { display: none; }
#ncmPane.kv2 #ncmPwdBox { display: block; }
#ncmPane:not(.kv2) #ncmPwdBox { display: none; }
#ncmLogin .hidden { display: none; }
#ncmQrBox { display: flex; flex-direction: column; align-items: center; gap: 4px; }
#ncmQrBox img { width: 120px; height: 120px; image-rendering: pixelated; border-radius: 6px; background: #fff; }
#ncmQrHint { color: #ec4141; }
#ncmPwdBox { display: flex; flex-direction: column; gap: 6px; }
#ncmPwdRow { display: flex; gap: 6px; }
#ncmPwdRow input { flex: 1; }
#ncmPwdRow button { flex: 0 0 auto; }
#ncmMsg { min-height: 14px; color: #fff; white-space: pre-line; }
#ncmMsg.err { color: #ff7d7d; }
#playlistSel { display: flex; align-items: center; gap: 6px; }
#playlistSel select { flex: 1; background: #101014; color: #e8e8e8; border: 1px solid #3c3c3c; border-radius: 4px; padding: 3px; font-size: 11px; max-width: 100%; }
#sourceSwitch { display: flex; align-items: center; gap: 6px; padding: 5px 10px; flex-wrap: wrap; }
#sourceSwitch b { color: #69c68a; }
#sourceSwitch button { background: #3a3d41; color: #fff; border: 1px solid transparent; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; line-height: 16px; white-space: nowrap; }
#sourceSwitch button.act { background: #3f8f5f; color: #fff; font-weight: bold; border: 1px solid #2f6b45; }
#sourceSwitch #srcNcm.act { background: #ec4141; border: 1px solid #c33536; }
#sourceSwitch button.dis { opacity: .5; filter: grayscale(70%); }
#sourceSwitch button#srcLocal.dis { background: #3a3d41; color: #9a9aa2; font-weight: normal; border-color: transparent; }
#sourceSwitch button#srcNcm.dis { background: #3a3d41; color: #9a9aa2; font-weight: normal; border-color: transparent; }
#ncmWrap {
  flex: 0 0 auto; display: flex; flex-direction: column;
  border-top: 1px solid #2f2f33; margin-top: 0;
  font-size: 11px; color: #cfcfd6;
}
#playBtnNcm:hover { background: #50535a; }
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
  padding: 4px 8px; line-height: 1.8;
}
#status .sh { color: #69c68a; font-weight: bold; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px; }
#status .sh:hover { color: #8be9c6; }
#status .sh .arw { display: inline-block; transition: transform .15s; font-size: 9px; color: #8b8b93; }
#status.closed .sh .arw { transform: rotate(-90deg); }
#status.closed .sbody { display: none; }
#status .sbody { white-space: pre-line; }
#status .lbl { color: #69c68a; font-weight: bold; }
#status .val { color: #ffffff; }
#models {
  flex: 0 0 auto; max-height: 150px; overflow-y: auto;
  font-size: 11px; color: #b8b8c0; background: #101014;
  border-bottom: 1px solid #3c3c3c;
  padding: 4px 8px; line-height: 1.7;
}
#models .mh { color: #69c68a; font-weight: bold; margin-bottom: 2px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px; }
#models .mh:hover { color: #8be9c6; }
#models .mh .arw { display: inline-block; transition: transform .15s; font-size: 9px; color: #8b8b93; }
#models .mcount { color: #8b8b93; font-weight: normal; font-size: 10px; }
#models.closed .mh .arw { transform: rotate(-90deg); }
#models.closed .mbody { display: none; }
#models .mbody { display: flex; flex-direction: column; }
#models .mrow { display: flex; align-items: center; gap: 6px; }
#models .mname { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#models .mcap { flex: 0 0 auto; display: inline-flex; gap: 3px; font-size: 10px; }
#models .cap { border: 1px solid #46464c; border-radius: 3px; padding: 0 3px; color: #8b8b93; }
#models .cap.on { color: #fff; border-color: #69c68a; background: #14332a; }
#models .cap.off { opacity: .35; }
#head { display: flex; align-items: center; padding: 4px 8px; font-size: 12px; color: #8be9c6; letter-spacing: 1px; border-bottom: 1px solid #3c3c3c; gap: 6px; }
#head .tab { background: #3a3d41; color: #fff; border: 1px solid transparent; border-radius: 4px; padding: 2px 10px; cursor: pointer; font-size: 11px; box-sizing: border-box; }
#head .tab.act { background: #3f8f5f; border: 1px solid #2f6b46; }
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
.item .ops { flex: 0 0 auto; display: inline-flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item:hover .ops { opacity: 1; }
.item .op {
  background: #3a3d41; color: #cfcfd6; border: none; border-radius: 3px;
  padding: 1px 5px; cursor: pointer; font-size: 10px; line-height: 14px;
}
.item .op:hover { background: #50535a; color: #fff; }
.item .op.danger:hover { background: #c33536; }
.kpitem {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  background: transparent; border: none; border-bottom: 1px solid #2f2f33;
  color: #e8e8e8; text-align: left; padding: 7px 4px; cursor: pointer;
}
.kpitem:hover { background: #26262b; }
.kpitem .kn { font-weight: bold; color: #69c68a; }
.kpitem .ks { font-size: 11px; color: #8b8b93; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#notesWrap { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
#notesWrap .nrow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#notesWrap input { flex: 1; background: #101014; color: #e8e8e8; border: 1px solid #3c3c3c; border-radius: 4px; padding: 4px 8px; font-size: 12px; min-width: 0; }
#notesWrap input:focus { outline: none; border-color: #69c68a; }
#notesWrap textarea { width: 100%; box-sizing: border-box; background: #101014; color: #e8e8e8; border: 1px solid #3c3c3c; border-radius: 4px; padding: 6px 8px; font-size: 12px; font-family: inherit; resize: vertical; min-height: 90px; }
#notesWrap textarea:focus { outline: none; border-color: #69c68a; }
#notesWrap button { flex: 0 0 auto; background: #3a3d41; color: #fff; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
#notesWrap button:hover { background: #50535a; }
#notesWrap button#noteAdd { background: #3f8f5f; }
#notesWrap button#noteAdd:hover { background: #4da372; }
#notesWrap button.arm { background: #c33536 !important; }
#noteHead { font-size: 11px; color: #8be9c6; cursor: pointer; padding: 2px 0; user-select: none; }
#noteList { display: flex; flex-direction: column; max-height: 180px; overflow-y: auto; }
.noteitem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: transparent; border: none; border-bottom: 1px solid #2f2f33;
  color: #e8e8e8; text-align: left; padding: 6px 4px; cursor: pointer;
}
.noteitem:hover { background: #26262b; }
.noteitem .ni { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.noteitem .nu { flex: 0 0 auto; font-size: 10px; color: #8b8b93; }
.noteitem.act { background: #14332a; }
.noteitem.act .ni { color: #69c68a; font-weight: bold; }
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
<div id="sourceSwitch">
  <b>音乐来源：</b>
  <button id="srcLocal" class="act">本地 media</button>
  <button id="srcNcm">网易云歌单</button>
</div>
<div id="ncmWrap">
  <div id="ncmHead">♪ 网易云音乐<span class="tgl">▾ 展开</span></div>
  <div id="ncmPane">
    <div id="ncmLogin">
      <div id="ncmUser" style="display:none">
        <span class="u" id="ncmUserName"></span>
        <button id="ncmLogout">退出</button>
      </div>
      <div id="ncmModeTabs">
        <button id="tabQr" class="act">扫码登录</button>
        <button id="tabPwd">手机号登录</button>
      </div>
      <div id="ncmQrBox">
        <button id="ncmNewQr">生成二维码</button>
        <img id="ncmQrImg" alt="" style="display:none">
        <span id="ncmQrHint"></span>
      </div>
      <div id="ncmPwdBox">
        <div id="ncmPwdRow">
          <input id="ncmPhone" placeholder="手机号">
          <input id="ncmPwd" type="password" placeholder="密码">
        </div>
        <button id="ncmPwdLogin">登录</button>
      </div>
      <div id="ncmMsg"></div>
    </div>
    <div id="playlistSel">
      <select id="ncmPlaylistSel"><option value="">登录后选择歌单</option></select>
      <button id="playBtnNcm">▶ 播放歌单</button>
    </div>
  </div>
</div>
<div id="status" class="closed"><div class="sh"><span class="arw">▼</span>会话状态</div><div class="sbody">♬ 正在读取状态…</div></div>
<div id="models" class="closed"><div class="mh"><span class="arw">▼</span>可用模型</div><div class="mbody"><div class="mrow"><span class="mname">加载中…</span></div></div></div>
<div id="head">
  <button id="tabSess" class="tab act">历史对话</button>
  <button id="tabKp" class="tab">关键内容</button>
  <button id="tabNotes" class="tab">用户笔记</button>
  <span><button class="reload" id="reload">↻ 刷新</button></span>
</div>
<div id="sess"><div id="empty">加载中…</div></div>
<script>
const vscode = acquireVsCodeApi()
const media = ${mediaJson}
let list = ${listJson}
const tracks = ${trackJson}
let i = 0
let timer = null
let ti = 0
let mode = "local"
let currentList = []
let ncmTracks = []
let ncmPlaylists = []
let ncmQrKey = null
let ncmQrTimer = null
let ncmUser = null
let ncmReqSeq = 0
const pic = document.getElementById("pic")
const meta = document.getElementById("meta")
const sess = document.getElementById("sess")
const statusEl = document.getElementById("status")
const statusBodyEl = statusEl.querySelector(".sbody")
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
    statusBodyEl.innerHTML = '<span class="lbl">Context</span>\\n<span class="val">—</span> tokens\\n<span class="val">—%</span> used\\n<span class="val">$0.00</span> spent\\n<span class="lbl">LSP</span>\\n<span class="val">LSPs are disabled</span>'
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
  statusBodyEl.innerHTML = lines.join("\\n")
  statusBodyEl.title = r.title || ""
}

renderStatus(${statusJson})

const modelsEl = document.getElementById("models")

statusEl.addEventListener("click", (e) => {
  if (e.target.closest(".sh")) statusEl.classList.toggle("closed")
})

modelsEl.addEventListener("click", (e) => {
  if (e.target.closest(".mh")) modelsEl.classList.toggle("closed")
})

function renderModels(list) {
  const arrow = '<span class="arw">▼</span>'
  const head = '<div class="mh">' + arrow + "可用模型" + (list && list.length ? ' <span class="mcount">(' + list.length + ')</span>' : "") + "</div>"
  if (!list || !list.length) {
    modelsEl.innerHTML = head + '<div class="mbody"><div class="mrow"><span class="mname">暂无模型数据</span></div></div>'
    return
  }
  const boxes = []
  for (const m of list) {
    const cap = []
    cap.push('<span class="cap ' + (m.pdf ? "on" : "off") + '" title="' + esc(m.pdf ? "支持 PDF 附件" : "不支持 PDF") + '">PDF</span>')
    cap.push('<span class="cap ' + (m.image ? "on" : "off") + '" title="' + esc(m.image ? "支持图片输入" : "不支持图片输入") + '">图片</span>')
    cap.push('<span class="cap ' + (m.video ? "on" : "off") + '" title="' + esc(m.video ? "支持视频输入" : "不支持视频输入") + '">视频</span>')
    const label = (m.name || m.id) + (m.ctx ? " · " + fmtCtx(m.ctx) : "")
    boxes.push('<div class="mrow"><span class="mname" title="' + esc(m.id + (m.providerID ? " (" + m.providerID + ")" : "")) + '">' + esc(label) + '</span><span class="mcap">' + cap.join("") + '</span></div>')
  }
  modelsEl.innerHTML = head + '<div class="mbody">' + boxes.join("") + "</div>"
}

function fmtCtx(n) {
  n = Number(n) || 0
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1000) return Math.round(n / 1000) + "K"
  return String(n)
}

renderModels(${modelsJson})

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

function showNcmCover(item) {
  if (item && item.pic) {
    pic.src = item.pic
    pic.title = item.name || ""
  }
  if (item && (item.name || item.artists)) {
    meta.textContent = "♪ " + item.name + (item.artists ? " · " + item.artists : "")
    trackNameEl.textContent = "♪ " + item.name + (item.artists ? " · " + item.artists : "")
  }
  if (!media.length) meta.textContent = "0 / 0"
}

function trackBase(name) {
  return name.replace(/\.(mp3|wav)$/i, "")
}

function showTrackErr(e) {
  resetSeek()
  trackNameEl.textContent = "⚠ 无法播放：" + (e && e.message ? e.message : e)
  playPauseBtn.textContent = "▶ 播放"
}

function itemLabel(it) {
  return mode === "ncm"
    ? (it.name + (it.artists ? " · " + it.artists : ""))
    : trackBase(it.file)
}

function setMode(m, keepPos) {
  mode = m
  const srcBtnLocal = document.getElementById("srcLocal")
  const srcBtnNcm = document.getElementById("srcNcm")
  srcBtnLocal.classList.toggle("act", mode === "local")
  srcBtnNcm.classList.toggle("act", mode === "ncm")
  // 互斥置灰：只用当前来源，另一个不可点
  srcBtnLocal.classList.toggle("dis", mode === "ncm")
  srcBtnNcm.classList.toggle("dis", mode === "local")
  // 网易云模式：只隐藏切歌/轮播控制条，图片区保留以正常显示专辑封面
  const bar = document.getElementById("bar")
  if (bar) bar.style.display = mode === "ncm" ? "none" : "flex"
  if (mode === "ncm" && ncmUser) requestNcmPlaylists()
}

function startLocalList(armOnly) {
  audio.pause()
  setMode("local")
  currentList = tracks
  ti = 0
  show()
  if (!tracks.length) {
    trackNameEl.textContent = "♩ 无音频（media 目录下放 mp3/wav）"
    playPauseBtn.textContent = "▶ 播放"
    return
  }
  audio.src = tracks[0].uri
  resetSeek()
  trackNameEl.textContent = "♩ " + trackBase(tracks[0].file)
  playPauseBtn.textContent = "▶ 播放"
  if (!armOnly) playIndex(0)
}

function startNcmList(list) {
  audio.pause()
  setMode("ncm")
  currentList = list || []
  ti = 0
  if (!currentList.length) {
    trackNameEl.textContent = "♩ 该歌单为空"
    playPauseBtn.textContent = "▶ 播放"
    return
  }
  playIndex(0)
}

function playIndex(idx, noAuto) {
  const L = currentList
  if (!L || !L.length) return
  ti = ((idx % L.length) + L.length) % L.length
  const item = L[ti]
  if (mode === "local") {
    const file = item.file
    const uri = tracks[ti].uri
    show()
    audio.src = uri
    resetSeek()
    trackNameEl.textContent = "♩ " + trackBase(file)
    const p = audio.play()
    if (p && p.then) {
      p.then(() => { playPauseBtn.textContent = "⏸ 暂停" }).catch(() => {
        audio.addEventListener("error", function stuck() {
          audio.removeEventListener("error", stuck)
          if (L.length > 1) playIndex(ti + 1)
          else showTrackErr("该文件无法解码，请换用标准 MP3/WAV")
        })
        audio.load()
      })
    } else {
      playPauseBtn.textContent = "⏸ 暂停"
    }
  } else {
    trackNameEl.textContent = "➭ 加载 " + itemLabel(item) + "…"
    showNcmCover(item)
    vscode.postMessage({ type: "ncm:url", id: item.id, idx: ti, seq: ++ncmReqSeq })
  }
}

function playNcmUrl(idx, url, notFound, seq) {
  if (seq != null && seq !== ncmReqSeq) return
  const L = currentList
  if (!L || !L.length) { audio.pause(); return }
  if (notFound || !url) {
    if (L.length > 1) { nextTrack(); return }
    showTrackErr("无法获取播放地址（可能需要 VIP 或无版权）")
    return
  }
  ti = idx
  audio.src = url
  resetSeek()
  trackNameEl.textContent = "➭ " + itemLabel(L[idx])
  showNcmCover(L[idx])
  const p = audio.play()
  if (p && p.then) p.then(() => { playPauseBtn.textContent = "⏸ 暂停" }).catch(() => {
    audio.addEventListener("error", function stuck() {
      audio.removeEventListener("error", stuck)
      if (L.length > 1) nextTrack()
      else showTrackErr("无法播放（可能需要 VIP）")
    })
    audio.load()
  })
}

function nextTrack() {
  if (!currentList.length) return
  playIndex(ti + 1)
}

function playCur() {
  if (!currentList || !currentList.length) { startLocalList(); return }
  if (audio.paused) {
    if (mode === "local" && !audio.src) playIndex(ti)
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

playPauseBtn.onclick = playCur
document.getElementById("nextTrack").onclick = () => { nextTrack() }
audio.addEventListener("ended", () => { nextTrack() })
audio.addEventListener("error", () => {
  const err = audio.error
  showTrackErr(err ? "音频错误 code=" + err.code : "未知错误")
})
startLocalList(true)

// ---------- 网易云音乐 ----------
const ncmWrap = document.getElementById("ncmWrap")
const ncmPane = document.getElementById("ncmPane")
const ncmUserEl = document.getElementById("ncmUser")
const ncmMsg = document.getElementById("ncmMsg")
const ncmQrBox = document.getElementById("ncmQrBox")
const ncmPwdBox = document.getElementById("ncmPwdBox")
const ncmQrImg = document.getElementById("ncmQrImg")
const ncmQrHint = document.getElementById("ncmQrHint")
const ncmPlaylistSel = document.getElementById("ncmPlaylistSel")
const ncmUserName = document.getElementById("ncmUserName")

function ncmSetMsg(t, isErr) {
  ncmMsg.textContent = t || ""
  ncmMsg.className = isErr ? "err" : ""
}

function toast(t) {
  const mark = '<span class="lbl">◆</span> <span class="val">' + esc(t) + "</span>"
  const old = statusBodyEl.innerHTML
  statusEl.classList.remove("closed")
  statusBodyEl.innerHTML = mark
  setTimeout(() => { if (statusBodyEl.innerHTML === mark) statusBodyEl.innerHTML = old }, 2000)
}

ncmWrap.querySelector("#ncmHead").onclick = (ev) => {
  ev.stopPropagation()
  ncmWrap.classList.toggle("open")
  const tgl = ncmWrap.querySelector(".tgl")
  tgl.textContent = ncmWrap.classList.contains("open") ? "▴ 收起" : "▾ 展开"
  if (ncmWrap.classList.contains("open")) setMode(mode)
}

document.getElementById("ncmNewQr").onclick = () => {
  ncmSetMsg("正在生成二维码…")
  vscode.postMessage({ type: "ncm:qrNew" })
}

document.getElementById("ncmPwdLogin").onclick = () => {
  const phone = document.getElementById("ncmPhone").value.trim()
  const pwd = document.getElementById("ncmPwd").value
  if (!phone || !pwd) { ncmSetMsg("请输入手机号和密码", true); return }
  ncmSetMsg("正在登录…")
  vscode.postMessage({ type: "ncm:pwdLogin", phone, password: pwd })
}

document.getElementById("ncmLogout").onclick = () => vscode.postMessage({ type: "ncm:logout" })

document.getElementById("tabQr").onclick = () => {
  document.getElementById("tabQr").classList.add("act")
  document.getElementById("tabPwd").classList.remove("act")
  ncmPane.classList.remove("kv2")
}
document.getElementById("tabPwd").onclick = () => {
  document.getElementById("tabPwd").classList.add("act")
  document.getElementById("tabQr").classList.remove("act")
  ncmPane.classList.add("kv2")
}

document.getElementById("srcLocal").onclick = () => {
  startLocalList()
}
document.getElementById("srcNcm").onclick = () => {
  if (!ncmWrap.classList.contains("open")) ncmWrap.classList.add("open")
  const tgl = ncmWrap.querySelector(".tgl")
  if (tgl) tgl.textContent = "▴ 收起"
  setMode("ncm", true)
  if (!ncmUser) ncmSetMsg("请先登录网易云音乐", true)
}

document.getElementById("playBtnNcm").onclick = () => {
  const id = ncmPlaylistSel.value
  if (!id) { ncmSetMsg("请先选择歌单", true); return }
  ncmSetMsg("载入歌单…")
  vscode.postMessage({ type: "ncm:loadPlaylist", id })
}

function renderNcmUser(u) {
  ncmUser = u
  if (u) {
    ncmUserName.textContent = u.nickname || u.userId || ""
    ncmUserEl.style.display = "flex"
    ncmQrBox.classList.add("hidden")
    ncmPwdBox.classList.add("hidden")
    ncmSetMsg("已登录：欢迎，" + (u.nickname || ""))
  } else {
    ncmUserName.textContent = ""
    ncmUserEl.style.display = "none"
    ncmQrBox.classList.remove("hidden")
    ncmPwdBox.classList.remove("hidden")
    ncmSetMsg("")
  }
}

function renderNcmQr(data, hint) {
  ncmQrImg.style.display = data && data.qrimg ? "block" : "none"
  if (data && data.qrimg) ncmQrImg.src = data.qrimg
  ncmQrHint.textContent = hint || ""
}

function renderNcmPlaylists(list) {
  ncmPlaylists = list || []
  ncmPlaylistSel.innerHTML = ""
  const opt0 = document.createElement("option")
  opt0.value = ""
  opt0.textContent = ncmPlaylists.length ? "选择歌单（" + ncmPlaylists.length + " 个）" : "无歌单"
  ncmPlaylistSel.appendChild(opt0)
  for (const pl of ncmPlaylists) {
    const op = document.createElement("option")
    op.value = pl.id
    op.textContent = pl.name + "（" + pl.trackCount + " 首）"
    ncmPlaylistSel.appendChild(op)
  }
}

function requestNcmPlaylists() {
  if (!ncmUser) return
  vscode.postMessage({ type: "ncm:playlists" })
}

// ---------- 页面消息处理 ----------
window.addEventListener("message", (ev) => {
  const m = ev.data
  if (m.type === "sessions") { list = m.items || []; render(list) }
  if (m.type === "reload") show()
  if (m.type === "status") renderStatus(m.data)
  if (m.type === "models") renderModels(m.list || [])
  if (m.type === "session:renamed") {
    const row = list.find((x) => x.id === m.sessionId)
    if (row) row.title = m.title
    toast("已重命名：'" + m.title + "'")
    render(list)
  }
  if (m.type === "session:deleted") {
    list = list.filter((x) => x.id !== m.sessionId)
    if (kpSessionId === m.sessionId) { kpSessionId = null; kpList = [] }
    toast("会话已删除")
    render(list)
  }
  if (m.type === "ops:err") toast("操作失败：" + (m.text || ""))
  if (m.type === "ncm:user") { renderNcmUser(m.data); if (m.data && !ncmPlaylists.length) requestNcmPlaylists() }
  if (m.type === "ncm:qr") renderNcmQr(m.data, m.hint)
  if (m.type === "ncm:playlists") renderNcmPlaylists(m.list)
  if (m.type === "ncm:playlistLoaded") {
    ncmSetMsg("歌单已载入，共 " + (m.list ? m.list.length : 0) + " 首")
    startNcmList(m.list || [])
  }
  if (m.type === "ncm:url") playNcmUrl(m.idx, m.url, m.notFound, m.seq)
  if (m.type === "ncm:msg") ncmSetMsg(m.text, m.isErr)
  if (m.type === "kp:data") {
    kpSessionId = m.sessionId
    kpSessionDir = m.directory
    kpList = m.list || []
    renderKp(kpList)
  }
  if (m.type === "kp:err") {
    sess.innerHTML = '<div id="empty">' + esc(m.text || "AI 提取失败") + '</div>'
  }
  if (m.type === "notes:data") {
    noteList = m.notes || []
    noteListLoaded = true
    currentNoteId = noteList.length ? noteList[0].id : null
    renderNotes()
  }
})

// init: probe logged-in state
vscode.postMessage({ type: "ncm:status" })

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
    const row = document.createElement("div")
    row.className = "item"
    const t = document.createElement("span")
    t.className = "t"
    t.textContent = s.title
    t.title = (s.dir || "") + " · " + s.id
    const ts = document.createElement("span")
    ts.className = "ts"
    ts.textContent = fmt(s.time)
    const ops = document.createElement("span")
    ops.className = "ops"
    const ren = document.createElement("button")
    ren.className = "op"
    ren.textContent = "重命名"
    ren.title = "重命名会话"
    ren.onclick = (e) => { e.stopPropagation(); promptRename(s) }
    const del = document.createElement("button")
    del.className = "op danger"
    del.textContent = "删除"
    del.title = "删除会话"
    del.onclick = (e) => { e.stopPropagation(); promptDelete(s) }
    ops.appendChild(ren)
    ops.appendChild(del)
    row.appendChild(t)
    row.appendChild(ts)
    row.appendChild(ops)
    row.onclick = () => vscode.postMessage({ type: "resume", sessionId: s.id, directory: s.dir })
    sess.appendChild(row)
  })
}

let opsArmed = { t: 0, id: null }

function promptDelete(s) {
  const now = Date.now()
  if (opsArmed.id !== "del:" + s.id || now - opsArmed.t > 2500) {
    opsArmed = { t: now, id: "del:" + s.id }
    vscode.postMessage({ type: "ops:toast", text: "再次点击「删除」确认删除该会话" })
    return
  }
  opsArmed = { t: 0, id: null }
  vscode.postMessage({ type: "session:delete", sessionId: s.id })
}

function promptRename(s) {
  vscode.postMessage({ type: "session:renamePrompt", sessionId: s.id, current: (s.title || "").trim() })
}

function copyClipboard(text) {
  try {
    const ta = document.createElement("textarea")
    ta.value = String(text || "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    document.execCommand("copy")
    document.body.removeChild(ta)
  } catch {}
}

let kpSessionId = null
let kpList = []
let kpSessionDir = null
let currentNoteId = null

function renderKp(list) {
  if (!list || !list.length) {
    sess.innerHTML = '<div id="empty">暂无关键内容 —— 点击右上角 ↻ 刷新后重试</div>'
    return
  }
  sess.innerHTML = ""
  list.forEach((k, idx) => {
    const b = document.createElement("button")
    b.className = "kpitem"
    const kn = document.createElement("span")
    kn.className = "kn"
    kn.textContent = k.name || "知识点 " + (idx + 1)
    const ks = document.createElement("span")
    ks.className = "ks"
    ks.textContent = k.summary || ""
    b.appendChild(kn)
    b.appendChild(ks)
    b.title = "点击把该知识点填入会话输入框并复制到剪贴板"
    b.onclick = async () => {
      const text = (k.name || "知识点 " + (idx + 1)) + "：" + (k.summary || "")
      copyClipboard(text)
      sess.innerHTML = '<div id="empty">✓ 已复制到剪贴板并填入会话输入框，回车即可发出</div>'
      vscode.postMessage({ type: "kp:input", sessionId: kpSessionId, directory: kpSessionDir, text: text })
      setTimeout(() => { if (getActiveTab() === "kp") renderKp(kpList) }, 2500)
    }
    sess.appendChild(b)
  })
}

function getActiveTab() {
  const tabSess = document.getElementById("tabSess")
  const tabKp = document.getElementById("tabKp")
  const tabNotes = document.getElementById("tabNotes")
  if (tabKp && tabKp.classList.contains("act")) return "kp"
  if (tabNotes && tabNotes.classList.contains("act")) return "notes"
  return "sess"
}

// ---------- 用户笔记 ----------
let noteList = []
let noteListLoaded = false
let notesListOpen = false

function renderNotes() {
  sess.innerHTML = ""
  const wrap = document.createElement("div")
  wrap.id = "notesWrap"
  const r1 = document.createElement("div")
  r1.className = "nrow"
  const inp = document.createElement("input")
  inp.id = "noteTitleInp"
  inp.placeholder = "输入笔记标题…"
  const add = document.createElement("button")
  add.id = "noteAdd"
  add.textContent = "+ 新增"
  r1.appendChild(inp)
  r1.appendChild(add)
  const ta = document.createElement("textarea")
  ta.id = "noteBodyInp"
  ta.placeholder = "在下面输入笔记内容…"
  const r2 = document.createElement("div")
  r2.className = "nrow"
  const head = document.createElement("div")
  head.id = "noteHead"
  head.textContent = "▸ 历史笔记"
  const del = document.createElement("button")
  del.id = "noteDel"
  del.textContent = "删除"
  const ren = document.createElement("button")
  ren.id = "noteRen"
  ren.textContent = "重命名"
  r2.appendChild(head)
  const spacer = document.createElement("span")
  spacer.style.flex = "1"
  r2.appendChild(spacer)
  r2.appendChild(del)
  r2.appendChild(ren)
  const list = document.createElement("div")
  list.id = "noteList"
  wrap.appendChild(r1)
  wrap.appendChild(ta)
  wrap.appendChild(r2)
  wrap.appendChild(list)
  sess.appendChild(wrap)

  const cur = () => noteList.find((n) => n.id === currentNoteId) || null

  function persist() {
    vscode.postMessage({ type: "notes:save", notes: noteList })
  }

  function renderList() {
    list.innerHTML = ""
    head.textContent = (notesListOpen ? "▾" : "▸") + " 历史笔记（" + noteList.length + "）"
    list.style.display = notesListOpen ? "flex" : "none"
    noteList.forEach((n) => {
      const b = document.createElement("button")
      b.className = "noteitem" + (n.id === currentNoteId ? " act" : "")
      const t = document.createElement("span")
      t.className = "ni"
      t.textContent = n.title
      const ts = document.createElement("span")
      ts.className = "nu"
      ts.textContent = fmt(n.time)
      b.appendChild(t)
      b.appendChild(ts)
      b.onclick = () => {
        currentNoteId = n.id
        inp.value = n.title
        ta.value = n.content || ""
        renderList()
        ta.focus()
      }
      list.appendChild(b)
    })
  }

  function loadNote(n) {
    if (!n) return
    currentNoteId = n.id
    inp.value = n.title
    ta.value = n.content || ""
  }

  add.onclick = () => {
    const title = (inp.value || "").trim() || "未命名笔记"
    const n = { id: "n" + Date.now() + "_" + Math.floor(Math.random() * 100000), title: title, content: "", time: Date.now() }
    noteList.unshift(n)
    persist()
    loadNote(n)
    renderList()
    ta.focus()
  }

  ta.addEventListener("input", () => {
    const n = cur()
    if (!n) return
    n.content = ta.value
    n.time = Date.now()
    persist()
  })

  head.onclick = () => {
    notesListOpen = !notesListOpen
    renderList()
  }

  let armed = false
  del.onclick = () => {
    if (!cur()) return
    if (!armed) {
      armed = true
      del.textContent = "确认删除？"
      del.classList.add("arm")
      setTimeout(() => { armed = false; del.textContent = "删除"; del.classList.remove("arm") }, 2500)
      return
    }
    armed = false
    del.textContent = "删除"
    del.classList.remove("arm")
    const id = currentNoteId
    noteList = noteList.filter((n) => n.id !== id)
    currentNoteId = noteList.length ? noteList[0].id : null
    if (currentNoteId) loadNote(cur())
    else { inp.value = ""; ta.value = "" }
    persist()
    renderList()
  }

  ren.onclick = () => {
    const n = cur()
    if (!n) return
    const title = (inp.value || "").trim()
    if (!title) { inp.focus(); return }
    n.title = title
    n.time = Date.now()
    persist()
    renderList()
  }

  if (!cur()) {
    if (noteList.length) loadNote(noteList[0])
    else { inp.value = ""; ta.value = "" }
  }
  renderList()
}

function showTab(which) {
  const tabSess = document.getElementById("tabSess")
  const tabKp = document.getElementById("tabKp")
  const tabNotes = document.getElementById("tabNotes")
  tabSess.classList.toggle("act", which === "sess")
  tabKp.classList.toggle("act", which === "kp")
  tabNotes.classList.toggle("act", which === "notes")
  if (which === "kp") {
    const sid = list.length ? list[0].id : null
    const dir = list.length ? list[0].dir : null
    if (kpSessionId === sid && kpList.length) {
      renderKp(kpList)
    } else {
      sess.innerHTML = '<div id="empty">正在用 AI 提取关键内容…</div>'
      vscode.postMessage({ type: "kp:load", sessionId: sid, directory: dir })
    }
  } else if (which === "notes") {
    if (noteListLoaded) {
      renderNotes()
    } else {
      sess.innerHTML = '<div id="empty">正在加载用户笔记…</div>'
      vscode.postMessage({ type: "notes:load" })
    }
  } else {
    sess.innerHTML = '<div id="empty">正在加载历史对话…</div>'
    vscode.postMessage({ type: "sessions:request" })
  }
}

document.getElementById("tabSess").onclick = () => showTab("sess")
document.getElementById("tabKp").onclick = () => showTab("kp")
document.getElementById("tabNotes").onclick = () => showTab("notes")

render(list)
show()
</script>
</body>
</html>`
}

async function finalizeHtml(panel) {
  const [mediaFiles, sessions, status, audioFiles, models] = await Promise.all([
    Promise.resolve(collectMedia()),
    querySessions(),
    queryStatus(),
    Promise.resolve(collectAudio()),
    queryModels()
  ])
  if (panel && panel.webview) {
    panel.webview.html = buildHtml(panel.webview, mediaFiles, sessions, status, audioFiles, models)
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
    } else if (msg.type === "sessions:request") {
      let ss = []
      try {
        ss = await querySessions()
      } catch {}
      panel.webview.postMessage({ type: "sessions", items: mapSessions(ss) })
    } else if (msg.type === "models:request") {
      let list = []
      try {
        list = await queryModels()
      } catch {}
      panel.webview.postMessage({ type: "models", list })
    } else if (msg.type === "resume") {
      resumeSession(msg.sessionId, msg.directory)
    } else if (msg.type === "kp:load") {
      let sessions = []
      try {
        sessions = await querySessions()
      } catch {}
      const cur = sessions && sessions.length ? sessions[0] : null
      if (!cur) {
        panel.webview.postMessage({ type: "kp:err", text: "暂无会话可分析" })
        return
      }
      const sid = (msg.sessionId && sessions.some((s) => s.id === msg.sessionId)) ? msg.sessionId : cur.id
      const dir = msg.directory || cur.directory || null
      try {
        const list = await loadKeyPoints(sid, dir)
        panel.webview.postMessage({ type: "kp:data", list, sessionId: sid, directory: dir })
      } catch (e) {
        panel.webview.postMessage({ type: "kp:err", text: "AI 提取失败：" + ((e && e.message) || "未知") })
      }
    } else if (msg.type === "kp:input") {
      inputToSession(msg.sessionId, msg.directory, msg.text)
    } else if (msg.type === "session:rename") {
      try {
        const title = String(msg.title || "").trim().replace(/'/g, "''")
        if (title) {
          await runDb("UPDATE session SET title='" + title + "' WHERE id='" + msg.sessionId + "'")
          panel.webview.postMessage({ type: "session:renamed", sessionId: msg.sessionId, title })
        }
      } catch (e) {
        panel.webview.postMessage({ type: "ops:err", text: (e && e.message) || "重命名失败" })
      }
    } else if (msg.type === "session:renamePrompt") {
      const result = await vscode.window.showInputBox({
        prompt: "重命名会话",
        value: msg.current || "",
        placeHolder: "输入新标题",
        title: "重命名会话 " + String(msg.sessionId || "").slice(-8)
      })
      if (typeof result === "string" && result.trim() && result.trim() !== (msg.current || "")) {
        panel.webview.postMessage({ type: "session:rename", sessionId: msg.sessionId, title: result.trim() })
      }
    } else if (msg.type === "session:delete") {
      try {
        await execFileAsync(OPENCODE_EXE, ["session", "delete", msg.sessionId], { timeout: 15000, windowsHide: true })
        panel.webview.postMessage({ type: "session:deleted", sessionId: msg.sessionId })
      } catch (e) {
        panel.webview.postMessage({ type: "ops:err", text: (e && e.message) || "删除失败" })
      }
    } else if (msg.type === "notes:load") {
      panel.webview.postMessage({ type: "notes:data", notes: notesLoad() })
    } else if (msg.type === "notes:save") {
      notesSave(msg.notes)
    } else if (msg.type === "ncm:status") {
      if (!ncm) {
        panel.webview.postMessage({ type: "ncm:msg", text: "网易云模块缺失（NeteaseCloudMusicApi 未安装）", isErr: true })
        return
      }
      try {
        const u = await ncm.loadProfile()
        panel.webview.postMessage({ type: "ncm:user", data: u })
      } catch {}
    } else if (msg.type === "ncm:qrNew") {
      try {
        const key = await ncm.qrKey()
        const data = await ncm.qrCreate(key)
        ncmQrKey = key
        panel.webview.postMessage({ type: "ncm:qr", data: { qrimg: data.qrimg }, hint: "请用网易云 App 扫码" })
        startQrPoll(panel)
      } catch (e) {
        panel.webview.postMessage({ type: "ncm:msg", text: "二维码生成失败：" + (e && e.message), isErr: true })
      }
    } else if (msg.type === "ncm:pwdLogin") {
      try {
        const u = await ncm.loginByPhone(msg.phone, msg.password)
        panel.webview.postMessage({ type: "ncm:user", data: u })
        panel.webview.postMessage({ type: "ncm:msg", text: "登录成功" })
      } catch (e) {
        panel.webview.postMessage({ type: "ncm:msg", text: "登录失败：" + (e && e.message), isErr: true })
      }
    } else if (msg.type === "ncm:logout") {
      ncm.logout()
      panel.webview.postMessage({ type: "ncm:user", data: null })
      panel.webview.postMessage({ type: "ncm:msg", text: "已退出登录" })
    } else if (msg.type === "ncm:playlists") {
      try {
        const pl = await ncm.myPlaylists()
        panel.webview.postMessage({ type: "ncm:playlists", list: pl })
      } catch (e) {
        panel.webview.postMessage({ type: "ncm:msg", text: "读取歌单失败：" + (e && e.message), isErr: true })
      }
    } else if (msg.type === "ncm:loadPlaylist") {
      try {
        const tracks = await ncm.playlistTracks(msg.id)
        panel.webview.postMessage({ type: "ncm:playlistLoaded", list: tracks })
      } catch (e) {
        panel.webview.postMessage({ type: "ncm:msg", text: "载入歌单失败：" + (e && e.message), isErr: true })
      }
    } else if (msg.type === "ncm:url") {
      try {
        const url = await ncm.songUrl(msg.id)
        panel.webview.postMessage({ type: "ncm:url", idx: msg.idx, seq: msg.seq, url: url || null, notFound: !url })
      } catch (e) {
        panel.webview.postMessage({ type: "ncm:url", idx: msg.idx, seq: msg.seq, url: null, notFound: true, err: (e && e.message) || "未知" })
      }
    }
  })
  panel.onDidDispose(() => {
    panel = null
    stopStatusTimer()
    stopQrPoll()
    ncmQrKey = null
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

async function findOpencodeTerminal(sessionId) {
  const list = vscode.window.terminals
  const results = await Promise.all(list.map((t) => isOpencodeTerminal(t, sessionId)))
  let match = -1
  for (let i = 0; i < results.length; i++) {
    if (results[i] === 2) { match = i; break }
  }
  if (match < 0) match = results.findIndex(Boolean)
  return match >= 0 ? list[match] : null
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
  return port
}

async function isOpencodeTerminal(t, sessionId) {
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
    const cl = stdout || ""
    if (typeof sessionId === "string" && cl.indexOf("--session " + sessionId) >= 0) return 2
    return /opencode/i.test(cl)
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
  openPanel()
  scheduleReconcile()
}

function deactivate() {}

module.exports = { activate, deactivate }
