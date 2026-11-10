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
  "FROM session s WHERE s.time_archived IS NULL AND s.parent_id IS NULL AND s.title IS NOT NULL AND s.title != '' " +
  "ORDER BY s.time_updated DESC LIMIT 25"

const AGENT_GROUPS_SQL =
  "SELECT c.id AS id, c.title AS title, c.directory AS directory, c.time_updated AS time_updated, " +
  "c.parent_id AS parent_id, c.agent AS agent, " +
  "p.title AS parent_title, p.directory AS parent_directory, p.agent AS parent_agent " +
  "FROM session c LEFT JOIN session p ON p.id = c.parent_id " +
  "WHERE c.parent_id IS NOT NULL AND c.time_archived IS NULL " +
  "ORDER BY c.time_updated DESC LIMIT 300"

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
  "LEFT JOIN part p ON p.id = (SELECT p2.id FROM part p2 WHERE p2.session_id = s.id " +
  "AND json_extract(p2.data, '$.type') = 'step-finish' ORDER BY p2.time_updated DESC LIMIT 1) " +
  "WHERE s.time_archived IS NULL ORDER BY s.time_updated DESC LIMIT 1"

let panel = null
let reconcileTimer = null
let statusTimer = null
let modelLimitCache = {}
let modelListCache = { t: 0, value: null }
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

async function execDbRows(sql) {
  const { stdout } = await execFileAsync(
    OPENCODE_EXE,
    ["db", sql, "--format", "json"],
    { timeout: 8000, windowsHide: true }
  )
  const rows = JSON.parse(String(stdout || "").trim() || "[]")
  return Array.isArray(rows) ? rows : []
}

async function querySessions() {
  try {
    return await execDbRows(SESSIONS_SQL)
  } catch {
    return []
  }
}

async function queryAgentSessions() {
  try {
    return await execDbRows(AGENT_GROUPS_SQL)
  } catch {
    return []
  }
}

function sqlLit(s) {
  return String(s == null ? "" : s).replace(/'/g, "''")
}

function sqlId(s) {
  return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "")
}

async function renameSession(sessionId, title) {
  const sid = sqlId(sessionId)
  if (!sid) throw new Error("会话 ID 无效")
  const t = String(title == null ? "" : title).replace(/\s+/g, " ").trim()
  if (!t) throw new Error("标题不能为空")
  if (t.length > 200) throw new Error("标题过长（最多 200 字）")
  await execDbRows("UPDATE session SET title = '" + sqlLit(t) + "' WHERE id = '" + sid + "'")
  const rows = await execDbRows("SELECT id, title FROM session WHERE id = '" + sid + "'")
  if (!rows.length) throw new Error("会话不存在，可能已被删除")
  if (rows[0].title !== t) throw new Error("重命名未生效")
  return rows[0].title
}

async function deleteSession(sessionId) {
  const sid = sqlId(sessionId)
  if (!sid) throw new Error("会话 ID 无效")
  const exists = await execDbRows("SELECT id FROM session WHERE id = '" + sid + "'")
  if (!exists.length) throw new Error("会话不存在，可能已被删除")
  await execFileAsync(OPENCODE_EXE, ["session", "delete", sid], { timeout: 20000, windowsHide: true })
  const after = await execDbRows("SELECT id FROM session WHERE id = '" + sid + "'")
  if (after.length) throw new Error("删除未生效")
  return true
}

function mapSessions(sessions) {
  return (sessions || []).map((s) => ({
    id: s.id,
    title: s.title,
    dir: s.directory || "",
    time: s.time_updated || 0,
    parentId: s.parent_id || "",
    parentTitle: s.parent_title || "",
    parentDir: s.parent_directory || "",
    agent: s.agent || "",
    parentAgent: s.parent_agent || ""
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

// 扫描运行中的 opencode TUI 进程，取出它们各自带的 --session
function getRunningTuiSessions() {
  if (!isWin) return Promise.resolve([])
  return execFileAsync(
    "powershell.exe",
    [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | ForEach-Object { $_.CommandLine }"
    ],
    { timeout: 6000, windowsHide: true }
  )
    .then((r) => {
      const out = []
      const seen = {}
      for (const cl of String(r.stdout || "").split(/\r?\n/)) {
        const line = cl.trim()
        if (!line) continue
        const m = line.match(/--session\s+(\S+)/)
        if (!m) continue
        const id = m[1]
        if (seen[id]) continue
        seen[id] = 1
        out.push(id)
      }
      return out
    })
    .catch(() => [])
}

let tuiSessionCache = { t: 0, value: [] }

// 正在运行的 TUI 会话（去重、带短缓存）
async function liveTuiSessions() {
  if (tuiSessionCache.t && Date.now() - tuiSessionCache.t < 3e3 && tuiSessionCache.value.length) {
    return tuiSessionCache.value
  }
  const v = await getRunningTuiSessions()
  tuiSessionCache = { t: Date.now(), value: v }
  return v
}

async function queryStatus() {
  try {
    // 优先用正在运行的 TUI 会话，避免多开时取错会话
    const live = await liveTuiSessions()
    let sql = STATUS_SQL
    if (live.length === 1) {
      sql = STATUS_SQL.replace(
        "WHERE s.time_archived IS NULL",
        "WHERE s.time_archived IS NULL AND s.id = " + JSON.stringify(live[0]).replace(/"/g, "'")
      )
    } else if (live.length > 1) {
      const inList = live.map((x) => JSON.stringify(x).replace(/"/g, "'")).join(",")
      sql = STATUS_SQL.replace(
        "WHERE s.time_archived IS NULL",
        "WHERE s.time_archived IS NULL AND s.id IN (" + inList + ")"
      )
    }
    const { stdout } = await execFileAsync(
      OPENCODE_EXE,
      ["db", sql, "--format", "json"],
      { timeout: 20000, windowsHide: true }
    )
    const row = JSON.parse(stdout.trim())
    if (!Array.isArray(row) || !row.length) return null
    const r = row[0]
    let raw = null
    try { raw = JSON.parse(r.model) } catch {}
    r.contextLimit = await getContextLimit(raw && raw.id ? raw.id : r.model, raw && raw.providerID ? raw.providerID : "opencode")
    r.lsp = await lspEnabled()
    r.modelId = (raw && raw.id) || String(r.model || "")
    r.providerId = (raw && raw.providerID) || "opencode"
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
    mapSessions(sessions)
  ).replace(/</g, "\\u003c")
  const statusJson = JSON.stringify(status || null).replace(/</g, "\\u003c")
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
#stage { flex: 0 1 auto; min-height: 0; max-height: 30vh; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 8px 8px 2px; }
#pic { max-width: 96%; max-height: min(240px, 26vh); border-radius: 8px; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45); }
#bar { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 8px 8px; flex-wrap: wrap; }
body.ncmMode #bar button { display: none; }
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
  flex: 0 0 auto; display: none; flex-direction: column;
  border-top: 1px solid #2f2f33; margin-top: 2px;
  font-size: 11px; color: #cfcfd6;
}
body.ncmMode #ncmWrap { display: flex; }
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
#sourceSwitch button:hover { background: #50535a; }
#sourceSwitch button.act { background: #3f8f5f; border-color: #2f6b46; font-weight: bold; }
#sourceSwitch button.act:hover { background: #4fa36f; }
#sourceSwitch #srcNcm.act { background: #c33536; border-color: #a02a2b; }
#playBtnNcm {
  background: #3a3d41; color: #fff; border: none; border-radius: 4px;
  padding: 3px 10px; cursor: pointer; font-size: 11px;
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
  flex: 0 0 auto; margin: 0; max-height: none; min-height: 0; overflow: visible;
  font-size: 11px; color: #9fe8c0; background: #101014;
  border-bottom: 1px solid #3c3c3c;
  padding: 4px 8px; white-space: pre-line; line-height: 1.8;
}
#status .lbl { color: #69c68a; font-weight: bold; }
#status .val { color: #ffffff; }
#modelRow {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
  flex-wrap: wrap;
  padding: 4px 8px; font-size: 11px; color: #9fe8c0; background: #101014;
  border-bottom: 1px solid #3c3c3c;
}
#modelRow .lbl { color: #69c68a; font-weight: bold; }
#modelRow select {
  flex: 1; min-width: 0; background: #101014; color: #e8e8e8;
  border: 1px solid #3c3c3c; border-radius: 4px; padding: 2px; font-size: 11px;
}
#modelRow button {
  flex: 0 0 auto; background: #3a3d41; color: #fff; border: none;
  border-radius: 4px; padding: 2px 10px; cursor: pointer; font-size: 11px;
}
#modelRow button:hover { background: #50535a; }
#modelRow button:disabled { opacity: 0.5; cursor: default; }
#modelToggle.act { background: #3f8f5f; color: #fff; }
.model-cur { color: #8be9c6; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
.model-src {
  font-size: 10px; line-height: 14px; padding: 0 6px; border-radius: 8px;
  background: #2b2b30; color: #b9b9c2; border: 1px solid #3c3c3c;
  white-space: nowrap; flex: 0 0 auto;
}
.model-src.p-opencode { background: #20302a; color: #8be9c6; border-color: #2f6b46; }
.model-src.p-opencode-go { background: #1f2937; color: #7fb3ff; border-color: #2f4f7a; }
.model-src.p-anthropic { background: #302620; color: #e0a86b; border-color: #6b4f2f; }
.model-src.p-other { background: #261f30; color: #c9a0ff; border-color: #4f3f6b; }
.mi-src {
  font-size: 9px; line-height: 13px; padding: 0 4px; border-radius: 7px;
  background: #2b2b30; color: #9a9aa4; border: 1px solid #34343a;
  white-space: nowrap; flex: 0 0 auto;
}
.mi-src.p-opencode { color: #8be9c6; border-color: #2f6b46; }
.mi-src.p-opencode-go { color: #7fb3ff; border-color: #2f4f7a; }
.mi-src.p-anthropic { color: #e0a86b; border-color: #6b4f2f; }
.mi-src.p-other { color: #c9a0ff; border-color: #4f3f6b; }
.model-caps { display: flex; gap: 3px; flex: 0 0 auto; }
.cap {
  font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 3px;
  background: #2d3a4a; color: #6ea8ff; white-space: nowrap;
}
.cap.off { background: #2b2b30; color: #5c5c66; }
.cap.hot { background: #3f4a2d; color: #b6e36a; }
.model-panel {
  max-height: 190px; overflow-y: auto; padding: 4px 8px 6px;
  border-bottom: 1px solid #3c3c3c; background: #1e1e20;
}
.model-item {
  display: flex; align-items: center; gap: 5px; padding: 3px 0;
  border-bottom: 1px solid #2b2b30; font-size: 11px;
}
.model-item:last-child { border-bottom: none; }
.mi-name { color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
.mi-name .mi-id { color: #6a6a75; font-size: 10px; }
.model-item.cur .mi-name { color: #8be9c6; }
.mi-cur { color: #8be9c6; font-size: 10px; flex: 0 0 auto; }
#modelMsg { color: #8b8b93; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#modelMsg.err { color: #ff7d7d; }
#head { display: flex; flex-wrap: wrap; align-items: center; row-gap: 4px; padding: 4px 8px; font-size: 12px; color: #8be9c6; letter-spacing: 1px; border-bottom: 1px solid #3c3c3c; gap: 6px; }
#head .tab { background: #3a3d41; color: #fff; border: 1px solid transparent; border-radius: 4px; padding: 2px 10px; cursor: pointer; font-size: 11px; box-sizing: border-box; }
#head .tab.act { background: #3f8f5f; border: 1px solid #2f6b46; }
#head .reload { margin-left: auto; background: none; border: none; color: #8be9c6; cursor: pointer; font-size: 14px; }
.area { display: flex; flex-direction: column; flex: 0 1 auto; min-height: 36px; overflow: hidden; }
.area > .ahead { display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: #16161a; border-bottom: 1px solid #2f2f33; cursor: pointer; user-select: none; font-size: 11px; color: #8be9c6; letter-spacing: 1px; flex: 0 0 auto; }
.area > .ahead .atitle { flex: 1; font-weight: bold; }
.area > .ahead .achest { display: inline-block; transition: transform .15s ease; }
.area.collapsed > .ahead .achest { transform: rotate(-90deg); }
.area > .abody { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.area.collapsed { flex: 0 0 auto; }
.area.collapsed > .abody { display: none; }
.gutter { flex: 0 0 6px; cursor: row-resize; background: #141418; border-top: 1px solid #2a2a2e; border-bottom: 1px solid #2a2a2e; position: relative; }
.gutter::after { content: ""; position: absolute; left: 50%; top: 50%; width: 24px; height: 2px; margin: -1px 0 0 -12px; background: #3a3d41; border-radius: 1px; }
.gutter:hover, .gutter.drag { background: #3f8f5f; }
.gutter:hover::after, .gutter.drag::after { background: #fff; }
.resizing { user-select: none; }
#tabArea { flex: 1 1 auto; min-height: 120px; overflow: hidden; display: flex; flex-direction: column; }
#tabArea.collapsed { flex: 0 0 auto; }
#head .tab { user-select: none; }
#head .tab.dragging { opacity: .4; }
#newSessRow { padding: 6px 8px 2px; }
#newSess { width: 100%; background: #2f6b46; border: 1px solid #3f8f5f; color: #fff; border-radius: 4px; padding: 5px 0; cursor: pointer; font-size: 12px; }
#newSess:hover { background: #3f8f5f; }
#newSess:active { background: #356f4b; }
#newSess:disabled { opacity: .5; cursor: default; }
#sess { flex: 1 1 auto; min-height: 60px; overflow-y: auto; padding: 0 8px 8px; }
#empty { color: #777; font-size: 12px; text-align: center; padding: 16px 10px; }
.item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border-bottom: 1px solid #2f2f33; padding: 7px 4px; box-sizing: border-box;
}
.item:hover { background: #26262b; }
.item .imain {
  display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
  background: none; border: none; color: #e8e8e8; text-align: left;
  padding: 0; margin: 0; cursor: pointer; font: inherit; min-height: 18px;
}
.item .t { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.item .ts { flex: 0 0 auto; font-size: 10px; color: #8b8b93; }
.item .itools { flex: 0 0 auto; display: flex; gap: 4px; align-items: center; opacity: .5; }
.item:hover .itools, .item:focus-within .itools { opacity: 1; }
.ibtn {
  background: #3a3d41; color: #cfcfd6; border: 1px solid #45494e; border-radius: 4px;
  padding: 1px 6px; font-size: 10px; cursor: pointer; line-height: 15px; white-space: nowrap;
}
.ibtn:hover { background: #50535a; }
.ibtn:disabled { opacity: .5; cursor: default; }
.ibtn.ok { background: #2f6b46; border-color: #3f8f5f; color: #fff; }
.ibtn.ok:hover { background: #3f8f5f; }
.ibtn.del:hover { background: #7a2626; border-color: #a02a2b; }
.ibtn.danger { background: #c33536; border-color: #a02a2b; color: #fff; font-weight: bold; }
#sessMsg { font-size: 11px; padding: 0 4px 6px; color: #8be9c6; }
#sessMsg.err { color: #ff8080; }
#sessMsg:empty { display: none; }
.agroup { margin: 2px 0 10px; }
.aghead {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: #22303a; border: 1px solid #2f4f5a; border-radius: 4px;
  padding: 5px 8px; cursor: pointer; text-align: left;
  color: #8be9c6; font-size: 12px; box-sizing: border-box;
}
.aghead:hover { background: #2a3b47; }
.aghead .agt { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: bold; }
.aghead .agc { flex: 0 0 auto; font-size: 10px; color: #7fb3a0; }
.aitem {
  display: flex; align-items: center; gap: 6px; position: relative;
  padding: 5px 4px 5px 16px; border-bottom: 1px solid #2b2b30; box-sizing: border-box;
}
.aitem::before { content: "└"; position: absolute; left: 4px; color: #4a6b62; font-size: 11px; }
.aitem:hover { background: #26262b; }
.aitem .aimain {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;
  background: none; border: none; color: #d8d8de; text-align: left;
  padding: 0; margin: 0; cursor: pointer; font: inherit; min-height: 18px;
}
.aitem .at { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.aitem .ats { flex: 0 0 auto; font-size: 10px; color: #8b8b93; }
.agtag {
  flex: 0 0 auto; font-size: 9px; line-height: 14px; padding: 0 5px;
  border-radius: 7px; white-space: nowrap; border: 1px solid #34343a;
  background: #2b2b30; color: #9a9aa4;
}
.agtag.mgr { background: #2d3a4a; color: #7fb3ff; border-color: #2f4f7a; }
.agtag.sub { background: #2b2b30; color: #9a9aa4; border-color: #34343a; }
.ieditwrap { display: flex; flex-direction: column; gap: 6px; padding: 10px 4px; align-items: flex-start; }
.ieditwrap .ilab { font-size: 12px; color: #69c68a; }
.ieditwrap .irow { display: flex; gap: 6px; align-items: center; width: 100%; }
.iedit { flex: 1; min-width: 0; background: #101014; color: #e8e8e8; border: 1px solid #3c3c3c; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.iedit:focus { outline: none; border-color: #3f8f5f; }
.ieditwrap .itip { font-size: 10px; color: #8b8b93; }
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
<div id="mediaArea" class="area">
<div class="ahead" id="mediaHead"><span class="atitle">♪ 媒体与播放</span><span class="achest">▾</span></div>
<div class="abody" id="mediaBody">
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
</div>
</div>
<div class="gutter" id="gutterMedia"></div>
<div id="statusArea" class="area">
<div class="ahead" id="statusHead"><span class="atitle">◧ 状态栏</span><span class="achest">▾</span></div>
<div class="abody" id="statusBody">
<div id="status">♬ 正在读取状态…</div>
<div id="modelRow">
  <span class="lbl">model</span>
  <span id="modelCurrent" class="model-cur">—</span>
  <span id="modelSource" class="model-src" hidden></span>
  <span id="modelCaps" class="model-caps"></span>
  <button id="modelToggle" class="model-toggle">可用模型 ▾</button>
  <span id="modelMsg"></span>
</div>
<div id="modelPanel" class="model-panel" hidden></div>
</div>
</div>
<div class="gutter" id="gutterStatus"></div>
<div id="tabArea" class="area">
<div class="ahead" id="tabHead"><span class="atitle">☰ 功能栏</span><span class="achest">▾</span></div>
<div class="abody" id="tabBody">
<div id="newSessRow">
  <button id="newSess">＋ 开启新会话</button>
</div>
<div id="head">
  <button id="tabSess" class="tab act">历史对话</button>
  <button id="tabKp" class="tab">关键内容</button>
  <button id="tabNotes" class="tab">用户笔记</button>
  <button id="tabAgent" class="tab">Agent群组</button>
  <span><button class="reload" id="reload">↻ 刷新</button></span>
</div>
<div id="sessMsg"></div>
<div id="sess"><div id="empty">加载中…</div></div>
</div>
</div>
<script>
const vscode = acquireVsCodeApi()
const media = ${mediaJson}
let list = ${listJson}
let activeTab = "sess"
let sessionsLoaded = true
let kpSeq = 0
let sessSeq = 0
let notesSeq = 0
let agentSeq = 0
let agentLoaded = false
let agentList = []
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
let lastStatus = null
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
  lastStatus = r || null
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

// ---------- 模型信息（只读展示，不提供切换） ----------
let modelListLoaded = false
let modelInfoList = []
const modelCurrent = document.getElementById("modelCurrent")
const modelSource = document.getElementById("modelSource")
const modelCaps = document.getElementById("modelCaps")
const modelPanel = document.getElementById("modelPanel")
const modelToggle = document.getElementById("modelToggle")
const modelMsg = document.getElementById("modelMsg")

function setModelMsg(text, isErr) {
  modelMsg.textContent = text || ""
  modelMsg.className = isErr ? "err" : ""
}

function requestModelList() {
  if (modelListLoaded) return
  modelListLoaded = true
  vscode.postMessage({ type: "model:list" })
}

function capChip(text, on, cls) {
  const s = document.createElement("span")
  s.className = "cap" + (on ? (cls ? " " + cls : "") : " off")
  s.textContent = text
  return s
}

function providerKey(p) {
  const v = String(p || "").toLowerCase()
  if (v === "opencode") return "p-opencode"
  if (v === "opencode-go" || v === "opencodego" || v === "opencode_go" || v === "opencode go") return "p-opencode-go"
  if (v === "anthropic") return "p-anthropic"
  return "p-other"
}

function providerLabel(p) {
  const v = String(p || "")
  if (v === "opencode-go") return "opencode go"
  return v || "未知来源"
}

function sourceBadge(cls, provider) {
  const s = document.createElement("span")
  s.className = cls + " " + providerKey(provider)
  s.textContent = providerLabel(provider)
  s.title = "模型来源：" + providerLabel(provider)
  return s
}

function updateSourceBadge(provider) {
  if (!modelSource) return
  if (!provider) {
    modelSource.hidden = true
    modelSource.textContent = ""
    return
  }
  modelSource.hidden = false
  modelSource.className = "model-src " + providerKey(provider)
  modelSource.textContent = providerLabel(provider)
  modelSource.title = "模型来源：" + providerLabel(provider)
}

function renderModelPanel() {
  modelPanel.innerHTML = ""
  const cur = currentModelKey()
  let vcount = 0
  for (const m of modelInfoList) {
    const row = document.createElement("div")
    row.className = "model-item" + (m.provider + "/" + m.model === cur ? " cur" : "")
    const nm = document.createElement("span")
    nm.className = "mi-name"
    nm.textContent = m.name || m.label
    const id = document.createElement("span")
    id.className = "mi-id"
    id.textContent = " " + m.model
    nm.appendChild(id)
    row.appendChild(nm)
    row.appendChild(sourceBadge("mi-src", m.provider))
    if (m.provider + "/" + m.model === cur) {
      const c = document.createElement("span")
      c.className = "mi-cur"
      c.textContent = "当前"
      row.appendChild(c)
    }
    if (m.image) { vcount++; row.appendChild(capChip("\u{1F441}", true, "hot")) }
    row.appendChild(capChip("视频", !!m.video))
    row.appendChild(capChip("PDF", !!m.pdf))
    row.appendChild(capChip("推理", !!m.reasoning))
    modelPanel.appendChild(row)
  }
  return vcount
}

function currentModelKey() {
  const r = lastStatus
  if (!r || !r.modelId) return ""
  return (r.providerId || "opencode") + "/" + r.modelId
}

function findModelByKey(key) {
  if (!key) return null
  for (const m of modelInfoList) if (m.provider + "/" + m.model === key) return m
  return null
}

function renderModelList(list) {
  modelInfoList = list || []
  refreshModelInfo()
  const vcount = renderModelPanel()
  const total = modelInfoList.length
  setModelMsg(
    !total ? "未取到模型列表"
    : vcount ? total + " 个可用模型 · " + vcount + " 个支持读图"
    : total + " 个可用模型",
    !total
  )
}

function refreshModelInfo() {
  const key = currentModelKey()
  if (!key) { modelCurrent.textContent = "—"; modelCaps.innerHTML = ""; updateSourceBadge(""); return }
  const cur = findModelByKey(key)
  const provider = cur ? cur.provider : key.split("/")[0]
  modelCurrent.textContent = cur ? (cur.name || cur.label) : ((lastStatus && lastStatus.modelId) || key)
  updateSourceBadge(provider)
  modelCaps.innerHTML = ""
  modelCaps.appendChild(capChip("\u{1F441}读图", cur ? !!cur.image : false, "hot"))
  modelCaps.appendChild(capChip("视频", cur ? !!cur.video : false))
  modelCaps.appendChild(capChip("PDF", cur ? !!cur.pdf : false))
  modelCaps.appendChild(capChip("推理", cur ? !!cur.reasoning : false))
  modelCaps.appendChild(capChip("工具", cur ? !!cur.toolcall : false))
}

function syncModelSelection() {
  refreshModelInfo()
  if (modelInfoList.length) renderModelPanel()
}

modelToggle.onclick = () => {
  const show = modelPanel.hasAttribute("hidden")
  if (show) modelPanel.removeAttribute("hidden")
  else modelPanel.setAttribute("hidden", "")
  modelToggle.className = show ? "model-toggle act" : "model-toggle"
  modelToggle.textContent = show ? "可用模型 ▴" : "可用模型 ▾"
}

renderStatus(${statusJson})
refreshModelInfo()
requestModelList()

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
  document.body.classList.toggle("ncmMode", mode === "ncm")
  if (mode === "ncm") {
    setNcmOpen(true)
    requestNcmPlaylists()
  }
}

function startLocalList(armOnly) {
  audio.pause()
  mode = "local"
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
  mode = "ncm"
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

function setNcmOpen(open) {
  ncmWrap.classList.toggle("open", open)
  const tgl = ncmWrap.querySelector(".tgl")
  if (tgl) tgl.textContent = open ? "▴ 收起" : "▾ 展开"
}

ncmWrap.querySelector("#ncmHead").onclick = (ev) => {
  ev.stopPropagation()
  setNcmOpen(!ncmWrap.classList.contains("open"))
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
  setMode("local", true)
}
document.getElementById("srcNcm").onclick = () => {
  if (!ncmUser) { ncmSetMsg("请先登录网易云", true); return }
  setMode("ncm", true)
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
  if (m.type === "sessions") {
    if (m.seq != null && m.seq !== sessSeq) return
    list = m.items || []
    sessionsLoaded = true
    if (isTab("sess")) render(list)
  }
  if (m.type === "agent:data") {
    if (m.seq != null && m.seq !== agentSeq) return
    agentList = m.items || []
    agentLoaded = true
    if (isTab("agent")) renderAgent(agentList)
  }
  if (m.type === "sess:done") {
    const target = list.find((s) => s.id === m.sessionId)
    if (m.op === "rename") {
      if (m.ok) {
        if (target) target.title = m.title
        editingId = null
        if (isTab("sess")) render(list)
        sessFlash("已重命名为「" + (m.title || "") + "」", false)
      } else {
        sessFlash("重命名失败：" + (m.error || "未知错误"), true)
        if (isTab("sess") && editingId === m.sessionId && target) startRename(target)
      }
    } else if (m.op === "delete") {
      if (m.ok) {
        list = list.filter((s) => s.id !== m.sessionId)
        editingId = null
        if (isTab("sess")) render(list)
        sessFlash("已删除该会话", false)
      } else {
        if (isTab("sess")) render(list)
        sessFlash("删除失败：" + (m.error || "未知错误"), true)
      }
    }
  }
  if (m.type === "reload") show()
  if (m.type === "sess:newed") {
    const btn = document.getElementById("newSess")
    if (btn) btn.disabled = false
    sessFlash(m.ok ? "已在新终端开启新会话" : ("开启新会话失败：" + (m.error || "未知错误")), !m.ok)
  }
  if (m.type === "status") { renderStatus(m.data); syncModelSelection() }
  if (m.type === "model:data") renderModelList(m.list)
  if (m.type === "model:msg") setModelMsg(m.text, m.isErr)
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
    if (m.seq != null && m.seq !== kpSeq) return
    kpSessionId = m.sessionId
    kpSessionDir = m.directory
    kpList = m.list || []
    if (isTab("kp")) renderKp(kpList)
  }
  if (m.type === "kp:err") {
    if (m.seq != null && m.seq !== kpSeq) return
    if (isTab("kp")) sess.innerHTML = '<div id="empty">' + esc(m.text || "AI 提取失败") + '</div>'
  }
  if (m.type === "notes:data") {
    if (m.seq != null && m.seq !== notesSeq) return
    noteList = m.notes || []
    noteListLoaded = true
    currentNoteId = noteList.length ? noteList[0].id : null
    if (isTab("notes")) renderNotes()
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

;(function initPaneLayout() {
  const MIN = 40
  const mediaArea = document.getElementById("mediaArea")
  const statusArea = document.getElementById("statusArea")
  const tabArea = document.getElementById("tabArea")

  const setH = (el, px) => { el.style.flex = "0 0 " + px + "px"; el.style.height = px + "px" }
  const clearH = (el) => { el.style.flex = ""; el.style.height = "" }
  const restoreH = (area) => {
    let v = 0
    try { v = parseInt(localStorage.getItem(area.id + ":h") || "0", 10) } catch {}
    if (v > 0) setH(area, Math.min(v, window.innerHeight * 0.9))
  }
  const setupCollapse = (area, key) => {
    const head = area.querySelector(".ahead")
    let collapsed = false
    try { collapsed = localStorage.getItem(key) === "1" } catch {}
    const apply = (c) => {
      collapsed = c
      area.classList.toggle("collapsed", c)
      if (c) clearH(area); else restoreH(area)
      try { localStorage.setItem(key, c ? "1" : "0") } catch {}
    }
    if (head) head.addEventListener("click", () => apply(!collapsed))
    apply(collapsed)
  }
  const setupResize = (area, gutter, other) => {
    let startY = 0, startH = 0, dragging = false
    gutter.addEventListener("pointerdown", (e) => {
      if (area.classList.contains("collapsed")) return
      dragging = true
      startY = e.clientY
      startH = area.getBoundingClientRect().height
      gutter.classList.add("drag")
      area.classList.add("resizing")
      try { gutter.setPointerCapture(e.pointerId) } catch {}
      e.preventDefault()
    })
    gutter.addEventListener("pointermove", (e) => {
      if (!dragging) return
      const others = other.getBoundingClientRect().height
      const max = Math.max(MIN + 10, window.innerHeight - others - 150)
      let h = startH + (e.clientY - startY)
      h = Math.max(MIN, Math.min(max, h))
      setH(area, Math.round(h))
    })
    const stop = () => {
      if (!dragging) return
      dragging = false
      gutter.classList.remove("drag")
      area.classList.remove("resizing")
      try { localStorage.setItem(area.id + ":h", String(Math.round(area.getBoundingClientRect().height))) } catch {}
    }
    gutter.addEventListener("pointerup", stop)
    gutter.addEventListener("pointercancel", stop)
  }

  setupCollapse(mediaArea, "ocMediaCollapsed")
  setupCollapse(statusArea, "ocStatusCollapsed")
  setupCollapse(tabArea, "ocTabCollapsed")
  setupResize(mediaArea, document.getElementById("gutterMedia"), statusArea)
  setupResize(statusArea, document.getElementById("gutterStatus"), mediaArea)

  const head = document.getElementById("head")
  const reloadSpan = document.getElementById("reload").parentElement
  const tabEls = Array.from(head.querySelectorAll(".tab"))
  let order = []
  try { order = JSON.parse(localStorage.getItem("ocTabOrder") || "[]") } catch {}
  if (Array.isArray(order)) {
    order.forEach((id) => {
      const el = document.getElementById(id)
      if (el && el.classList.contains("tab") && el.parentElement === head) head.insertBefore(el, reloadSpan)
    })
  }
  const saveOrder = () => {
    try { localStorage.setItem("ocTabOrder", JSON.stringify(Array.from(head.querySelectorAll(".tab")).map((el) => el.id))) } catch {}
  }
  let dragEl = null
  const afterEl = (x) => {
    const els = Array.from(head.querySelectorAll(".tab:not(.dragging)"))
    let closest = null, closestOff = -Infinity
    els.forEach((el) => {
      const box = el.getBoundingClientRect()
      const off = x - (box.left + box.width / 2)
      if (off < 0 && off > closestOff) { closestOff = off; closest = el }
    })
    return closest
  }
  let lastDragEnd = 0
  head.addEventListener("dragend", () => { lastDragEnd = Date.now() }, true)
  head.addEventListener("click", (e) => {
    if (Date.now() - lastDragEnd < 200) { e.stopPropagation(); e.preventDefault() }
  }, true)
  tabEls.forEach((t) => {
    t.draggable = true
    t.addEventListener("dragstart", (e) => {
      dragEl = t
      t.classList.add("dragging")
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id) } catch {}
    })
    t.addEventListener("dragend", () => {
      t.classList.remove("dragging")
      dragEl = null
      saveOrder()
    })
  })
  head.addEventListener("dragover", (e) => {
    if (!dragEl) return
    e.preventDefault()
    const after = afterEl(e.clientX)
    if (after && after !== dragEl) head.insertBefore(dragEl, after)
    else if (!after) head.insertBefore(dragEl, reloadSpan)
  })
  head.addEventListener("drop", (e) => e.preventDefault())
})()

const newSessBtn = document.getElementById("newSess")
newSessBtn.onclick = () => {
  if (newSessBtn.disabled) return
  newSessBtn.disabled = true
  sessFlash("正在开启新会话…", false)
  vscode.postMessage({ type: "sess:new" })
  setTimeout(() => { newSessBtn.disabled = false }, 2000)
}

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

let sessMsgTimer = null
let editingId = null

function sessFlash(text, isErr) {
  const el = document.getElementById("sessMsg")
  if (!el) return
  el.textContent = text || ""
  el.className = isErr ? "err" : ""
  if (sessMsgTimer) clearTimeout(sessMsgTimer)
  sessMsgTimer = text ? setTimeout(() => { el.textContent = ""; el.className = "" }, 6000) : null
}

function sessItem(s) {
  const row = document.createElement("div")
  row.className = "item"
  row.dataset.id = s.id

  const main = document.createElement("button")
  main.className = "imain"
  const t = document.createElement("span")
  t.className = "t"
  t.textContent = s.title || "(无标题)"
  const ts = document.createElement("span")
  ts.className = "ts"
  ts.textContent = fmt(s.time)
  main.appendChild(t)
  main.appendChild(ts)
  main.title = (s.dir || "") + " · " + s.id
  main.onclick = () => vscode.postMessage({ type: "resume", sessionId: s.id, directory: s.dir })

  const tools = document.createElement("span")
  tools.className = "itools"

  const ren = document.createElement("button")
  ren.className = "ibtn"
  ren.textContent = "重命名"
  ren.title = "给这条历史对话换个名字"
  ren.onclick = (e) => {
    e.stopPropagation()
    startRename(s)
  }

  const del = document.createElement("button")
  del.className = "ibtn del"
  del.textContent = "删除"
  del.title = "永久删除这条历史对话（含全部消息，不可撤销）"
  let armed = false
  let armTimer = null
  del.onclick = (e) => {
    e.stopPropagation()
    if (!armed) {
      armed = true
      del.textContent = "确认删除?"
      del.className = "ibtn danger"
      sessFlash("再点一次「确认删除?」将永久删除此会话及其全部消息", true)
      if (armTimer) clearTimeout(armTimer)
      armTimer = setTimeout(() => {
        if (!armed) return
        armed = false
        del.textContent = "删除"
        del.className = "ibtn del"
      }, 6000)
      return
    }
    armed = false
    if (armTimer) clearTimeout(armTimer)
    del.disabled = true
    ren.disabled = true
    sessFlash("正在删除…", false)
    vscode.postMessage({ type: "sess:delete", sessionId: s.id })
  }

  tools.appendChild(ren)
  tools.appendChild(del)
  row.appendChild(main)
  row.appendChild(tools)
  return row
}

function startRename(s) {
  editingId = s.id
  const wrap = document.createElement("div")
  wrap.className = "ieditwrap"

  const lab = document.createElement("div")
  lab.className = "ilab"
  lab.textContent = "重命名历史对话"

  const row = document.createElement("div")
  row.className = "irow"
  const inp = document.createElement("input")
  inp.className = "iedit"
  inp.value = s.title || ""
  const ok = document.createElement("button")
  ok.className = "ibtn ok"
  ok.textContent = "保存"
  const ca = document.createElement("button")
  ca.className = "ibtn"
  ca.textContent = "取消"
  row.appendChild(inp)
  row.appendChild(ok)
  row.appendChild(ca)

  const tip = document.createElement("div")
  tip.className = "itip"
  tip.textContent = "回车保存 · Esc 取消 · 原名：" + (s.title || "(无标题)")

  wrap.appendChild(lab)
  wrap.appendChild(row)
  wrap.appendChild(tip)
  sess.innerHTML = ""
  sess.appendChild(wrap)

  const back = () => { editingId = null; render(list) }
  const submit = () => {
    const v = String(inp.value || "").replace(/\s+/g, " ").trim()
    if (!v) { sessFlash("标题不能为空", true); inp.focus(); return }
    ok.disabled = true
    ca.disabled = true
    sessFlash("正在重命名…", false)
    vscode.postMessage({ type: "sess:rename", sessionId: s.id, title: v })
  }
  ok.onclick = (e) => { e.stopPropagation(); submit() }
  ca.onclick = (e) => { e.stopPropagation(); back() }
  inp.onclick = (e) => e.stopPropagation()
  inp.onkeydown = (e) => {
    e.stopPropagation()
    if (e.key === "Enter") { e.preventDefault(); submit() }
    else if (e.key === "Escape") { e.preventDefault(); back() }
  }
  inp.focus()
  if (inp.select) inp.select()
}

function render(list) {
  if (editingId) editingId = null
  if (!list || !list.length) {
    sess.innerHTML = '<div id="empty">还没有历史对话 —— 去 opencode 聊一次吧 ♪</div>'
    return
  }
  sess.innerHTML = ""
  list.forEach((s) => {
    sess.appendChild(sessItem(s))
  })
}

function subTitle(t) {
  const v = String(t || "").replace(/\s*\(@[^)]*subagent\)\s*$/i, "").trim()
  return v || "(无标题)"
}

function agentTag(name, kind) {
  const s = document.createElement("span")
  s.className = "agtag " + (kind === "mgr" ? "mgr" : "sub")
  s.textContent = "@" + (name || "subagent")
  s.title = (kind === "mgr" ? "管理 Agent：" : "Subagent：") + (name || "subagent")
  return s
}

function renderAgent(list) {
  if (!list || !list.length) {
    sess.innerHTML = '<div id="empty">还没有 Agent 群组 —— 使用 subagent 后会出现在这里</div>'
    return
  }
  const groups = []
  const byParent = new Map()
  for (const it of list) {
    const key = it.parentId || "(未知管理会话)"
    let g = byParent.get(key)
    if (!g) {
      g = {
        key: it.parentId || "",
        title: it.parentTitle || "(未知管理会话)",
        dir: it.parentDir || "",
        agent: it.parentAgent || "",
        items: []
      }
      byParent.set(key, g)
      groups.push(g)
    }
    g.items.push(it)
  }
  sess.innerHTML = ""
  groups.forEach((g) => {
    const wrap = document.createElement("div")
    wrap.className = "agroup"

    const head = document.createElement("button")
    head.className = "aghead"
    const ht = document.createElement("span")
    ht.className = "agt"
    ht.textContent = g.title
    const hc = document.createElement("span")
    hc.className = "agc"
    hc.textContent = g.items.length + " 个 Subagent"
    head.appendChild(ht)
    head.appendChild(hc)
    if (g.agent) head.appendChild(agentTag(g.agent, "mgr"))
    head.title = g.key ? ("管理会话 · " + g.key) : "管理会话未知"
    if (g.key) {
      head.onclick = () => vscode.postMessage({ type: "resume", sessionId: g.key, directory: g.dir })
    }
    wrap.appendChild(head)

    g.items.forEach((it) => {
      const row = document.createElement("div")
      row.className = "aitem"
      const main = document.createElement("button")
      main.className = "aimain"
      const t = document.createElement("span")
      t.className = "at"
      t.textContent = subTitle(it.title)
      const ts = document.createElement("span")
      ts.className = "ats"
      ts.textContent = fmt(it.time)
      main.appendChild(t)
      main.appendChild(ts)
      main.title = (it.dir || "") + " · " + it.id
      main.onclick = () => vscode.postMessage({ type: "resume", sessionId: it.id, directory: it.dir })
      row.appendChild(main)
      row.appendChild(agentTag(it.agent || "subagent", "sub"))
      wrap.appendChild(row)
    })

    sess.appendChild(wrap)
  })
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
    b.title = "点击把该知识点填入会话输入框"
    b.onclick = () => {
      const text = (k.name || "知识点 " + (idx + 1)) + "：" + (k.summary || "")
      sess.innerHTML = '<div id="empty">已发送 → 填入会话输入框，回车即可发出</div>'
      vscode.postMessage({ type: "kp:input", sessionId: kpSessionId, directory: kpSessionDir, text: text })
      setTimeout(() => { if (getActiveTab() === "kp") renderKp(kpList) }, 2500)
    }
    sess.appendChild(b)
  })
}

function getActiveTab() {
  return activeTab
}

// 只在对应页签处于激活状态时才允许改动 #sess，避免迟到的回包把别的页签内容冲掉
function isTab(which) {
  return activeTab === which
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
  const prevTab = activeTab
  activeTab = which
  const tabSess = document.getElementById("tabSess")
  const tabKp = document.getElementById("tabKp")
  const tabNotes = document.getElementById("tabNotes")
  const tabAgent = document.getElementById("tabAgent")
  tabSess.classList.toggle("act", which === "sess")
  tabKp.classList.toggle("act", which === "kp")
  tabNotes.classList.toggle("act", which === "notes")
  tabAgent.classList.toggle("act", which === "agent")
  sessFlash("", false)
  if (which === "kp") {
    const sid = list.length ? list[0].id : null
    const dir = list.length ? list[0].dir : null
    if (kpSessionId === sid && kpList.length) {
      renderKp(kpList)
    } else {
      sess.innerHTML = '<div id="empty">正在用 AI 提取关键内容…</div>'
      const seq = ++kpSeq
      vscode.postMessage({ type: "kp:load", sessionId: sid, directory: dir, seq })
    }
  } else if (which === "notes") {
    if (noteListLoaded) {
      renderNotes()
    } else {
      sess.innerHTML = '<div id="empty">正在加载用户笔记…</div>'
      const seq = ++notesSeq
      vscode.postMessage({ type: "notes:load", seq })
    }
  } else if (which === "agent") {
    const reclick = prevTab === "agent"
    if (agentLoaded && !reclick) {
      renderAgent(agentList)
    } else {
      sess.innerHTML = '<div id="empty">正在加载 Agent 群组…</div>'
      const seq = ++agentSeq
      vscode.postMessage({ type: "agent:load", seq })
    }
  } else {
    const reclick = prevTab === "sess"
    if (sessionsLoaded && list.length && !reclick) {
      render(list)
    } else {
      sess.innerHTML = '<div id="empty">正在加载历史对话…</div>'
      const seq = ++sessSeq
      vscode.postMessage({ type: "sessions:request", seq })
    }
  }
}

document.getElementById("tabSess").onclick = () => showTab("sess")
document.getElementById("tabKp").onclick = () => showTab("kp")
document.getElementById("tabNotes").onclick = () => showTab("notes")
document.getElementById("tabAgent").onclick = () => showTab("agent")

render(list)
show()
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
    } else if (msg.type === "sessions:request") {
      let ss = []
      try {
        ss = await querySessions()
      } catch {}
      panel.webview.postMessage({ type: "sessions", items: mapSessions(ss), seq: msg.seq })
    } else if (msg.type === "agent:load") {
      let ss = []
      try {
        ss = await queryAgentSessions()
      } catch {}
      panel.webview.postMessage({ type: "agent:data", items: mapSessions(ss), seq: msg.seq })
    } else if (msg.type === "sess:rename") {
      try {
        const title = await renameSession(msg.sessionId, msg.title)
        panel.webview.postMessage({ type: "sess:done", op: "rename", sessionId: msg.sessionId, title, ok: true })
      } catch (e) {
        panel.webview.postMessage({
          type: "sess:done", op: "rename", sessionId: msg.sessionId, ok: false,
          error: ((e && e.message) || "重命名失败").split(/\r?\n/)[0]
        })
      }
    } else if (msg.type === "sess:delete") {
      try {
        await deleteSession(msg.sessionId)
        panel.webview.postMessage({ type: "sess:done", op: "delete", sessionId: msg.sessionId, ok: true })
      } catch (e) {
        panel.webview.postMessage({
          type: "sess:done", op: "delete", sessionId: msg.sessionId, ok: false,
          error: ((e && e.message) || "删除失败").split(/\r?\n/)[0]
        })
      }
    } else if (msg.type === "resume") {
      resumeSession(msg.sessionId, msg.directory)
    } else if (msg.type === "sess:new") {
      try {
        await newSession()
        panel.webview.postMessage({ type: "sess:newed", ok: true })
      } catch (e) {
        panel.webview.postMessage({
          type: "sess:newed", ok: false,
          error: ((e && e.message) || "开启失败").split(/\r?\n/)[0]
        })
      }
    } else if (msg.type === "kp:load") {
      let sessions = []
      try {
        sessions = await querySessions()
      } catch {}
      const cur = sessions && sessions.length ? sessions[0] : null
      if (!cur) {
        panel.webview.postMessage({ type: "kp:err", text: "暂无会话可分析", seq: msg.seq })
        return
      }
      const sid = (msg.sessionId && sessions.some((s) => s.id === msg.sessionId)) ? msg.sessionId : cur.id
      const dir = msg.directory || cur.directory || null
      try {
        const list = await loadKeyPoints(sid, dir)
        panel.webview.postMessage({ type: "kp:data", list, sessionId: sid, directory: dir, seq: msg.seq })
      } catch (e) {
        panel.webview.postMessage({ type: "kp:err", text: "AI 提取失败：" + ((e && e.message) || "未知"), seq: msg.seq })
      }
    } else if (msg.type === "kp:input") {
      inputToSession(msg.sessionId, msg.directory, msg.text)
    } else if (msg.type === "model:list") {
      try {
        const list = await listModels()
        panel.webview.postMessage({ type: "model:data", list })
      } catch (e) {
        panel.webview.postMessage({ type: "model:msg", text: "读取模型列表失败：" + ((e && e.message) || "未知"), isErr: true })
      }
    } else if (msg.type === "notes:load") {
        panel.webview.postMessage({ type: "notes:data", notes: notesLoad(), seq: msg.seq })
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

function detectShell() {
  const s = String(vscode.env.shell || "").toLowerCase()
  if (/pwsh|powershell/.test(s)) return "pwsh"
  if (/cmd(\.exe)?/.test(s)) return "cmd"
  if (/bash|zsh|fish|wsl|sh\.exe/.test(s)) return "other"
  return isWin ? "pwsh" : "other"
}

const shell = detectShell()

function resumeCommand(sessionId, port) {
  const exe = '"' + OPENCODE_EXE.replace(/\\/g, "/") + '"'
  const args = " --session " + sessionId + " --port " + port
  return shell === "pwsh" ? "& " + exe + args : exe + args
}

function newSessionCommand(port) {
  const exe = '"' + OPENCODE_EXE.replace(/\\/g, "/") + '"'
  const args = " --port " + port
  return shell === "pwsh" ? "& " + exe + args : exe + args
}

function parseModelVerbose(stdout) {
  const lines = String(stdout).split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim()
    if (!head || head.startsWith("{") || head === "}") continue
    if (head.indexOf("/") <= 0) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (lines[j] === undefined || lines[j].trim() !== "{") continue
    let depth = 0
    const buf = []
    for (let k = j; k < lines.length; k++) {
    buf.push(lines[k])
    for (const ch of lines[k]) { if (ch === "{") depth++; else if (ch === "}") depth-- }
    if (depth === 0) break
    }
    let obj = null
    try { obj = JSON.parse(buf.join("\n")) } catch (e) { obj = null }
    const s = head.indexOf("/")
    const cap = (obj && obj.capabilities) || {}
    const inp = cap.input || {}
    out.push({
      provider: head.slice(0, s),
      model: head.slice(s + 1),
      label: head,
      name: (obj && obj.name) || "",
      vision: !!(inp.image || inp.video || inp.pdf),
      image: !!inp.image,
      video: !!inp.video,
      pdf: !!inp.pdf,
      reasoning: !!cap.reasoning,
      toolcall: !!(cap.toolcall || cap.attachment),
      context: (obj && obj.limit && obj.limit.context) || 0
    })
    i = j + buf.length - 1
  }
  return out
}

function parseModelPlain(stdout) {
  return String(stdout)
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((line) => {
  const i = line.indexOf("/")
  const provider = i > 0 ? line.slice(0, i) : "opencode"
  const model = i > 0 ? line.slice(i + 1) : line
  return { provider, model, label: line, name: line.slice(line.lastIndexOf("/") + 1), vision: false, image: false, video: false, pdf: false, reasoning: false, toolcall: false, context: 0 }
  })
}

async function listModels() {
  if (modelListCache.t && Date.now() - modelListCache.t < 60e3 && modelListCache.value) {
  return modelListCache.value
  }
  let list = []
  try {
  const { stdout } = await execFileAsync(
  OPENCODE_EXE,
  ["models", "--verbose"],
  { timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  )
  list = parseModelVerbose(stdout)
  } catch (e) {
  list = []
  }
  if (!list.length) {
  try {
  const { stdout } = await execFileAsync(OPENCODE_EXE, ["models"], { timeout: 15000, windowsHide: true })
  list = parseModelPlain(stdout)
  } catch (e2) {
  list = []
  }
  }
  list.sort((a, b) => (b.vision ? 1 : 0) - (a.vision ? 1 : 0) || a.label.localeCompare(b.label))
  modelListCache = { t: Date.now(), value: list }
  return list
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

async function newSession() {
  const port = 30000 + Math.floor(Math.random() * 20000)
  if (!panel) openPanel()
  const cols = vscode.window.tabGroups.all
    .map((g) => g.viewColumn)
    .filter((c) => c && c > 0)
  const panelCol = panel && panel.viewColumn ? panel.viewColumn : null
  const rightMost = cols.length ? Math.max.apply(null, cols) : 1
  const opencodeCol = panelCol != null && panelCol > 1 ? panelCol - 1 : rightMost + 1
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  const term = vscode.window.createTerminal({
    name: "opencode new",
    cwd: ws ? ws.uri.fsPath : undefined,
    location: { viewColumn: opencodeCol }
  })
  term.sendText(newSessionCommand(port))
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
