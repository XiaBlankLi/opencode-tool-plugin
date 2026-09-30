const path = require("path")
const fs = require("fs")

const COOKIE_FILE = path.join(__dirname, ".ncm-cookie.txt")

function readCookie() {
  try {
    return fs.readFileSync(COOKIE_FILE, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function saveCookie(cookie) {
  if (!cookie) return
  try {
    fs.writeFileSync(COOKIE_FILE, cookie, "utf8")
  } catch {}
}

function clearCookie() {
  try {
    fs.rmSync(COOKIE_FILE, { force: true })
  } catch {}
}

let api = null
try {
  api = require("NeteaseCloudMusicApi")
} catch {
  try {
    api = require(path.join(__dirname, "node_modules", "NeteaseCloudMusicApi"))
  } catch {}
}
if (!api) throw new Error("NeteaseCloudMusicApi 未安装")

let profileCache = null

async function loadProfile() {
  if (profileCache) return profileCache
  const ck = readCookie()
  if (!ck) return null
  try {
    const r = await api.login_status({ cookie: ck })
    const p = r.body && r.body.data && r.body.data.profile
    if (p && p.userId) {
      profileCache = { userId: p.userId, nickname: p.nickname, avatarUrl: p.avatarUrl }
      return profileCache
    }
  } catch {}
  profileCache = null
  return null
}

function logout() {
  clearCookie()
  profileCache = null
}

async function qrKey() {
  const r = await api.login_qr_key()
  return r.body && r.body.data && r.body.data.unikey
}

async function qrCreate(key) {
  const r = await api.login_qr_create({ key, qrimg: true })
  return r.body && r.body.data
}

async function qrCheck(key) {
  const r = await api.login_qr_check({ key })
  const body = r.body || {}
  let cookie = null
  if (body.code === 803 && body.cookie) cookie = body.cookie
  else if (body.code === 803 && body.data && body.data.cookie) cookie = body.data.cookie
  if (cookie) saveCookie(cookie)
  return { code: body.code, message: body.message, cookie: cookie ? true : false }
}

async function loginByPhone(phone, password) {
  const r = await api.login_cellphone({ phone, password, md5_password: false })
  const body = r.body
  if (body.code !== 200) throw new Error(body.message || ("登录失败 code=" + body.code))
  if (body.cookie) saveCookie(body.cookie)
  const p = body.profile
  profileCache = p && p.userId ? { userId: p.userId, nickname: p.nickname, avatarUrl: p.avatarUrl } : null
  return profileCache
}

async function myPlaylists() {
  const p = await loadProfile()
  if (!p) throw new Error("未登录")
  const r = await api.user_playlist({ uid: p.userId, cookie: readCookie(), limit: 100 })
  const playlists = r.body && r.body.playlist
  if (!Array.isArray(playlists)) return []
  return playlists.map((pl) => ({
    id: pl.id,
    name: pl.name,
    trackCount: pl.trackCount,
    creator: (pl.creator && pl.creator.nickname) || ""
  }))
}

async function playlistTracks(playlistId) {
  const r = await api.playlist_detail({ id: playlistId, cookie: readCookie(), limit: 500 })
  const playlist = r.body && r.body.playlist
  const tracks = (playlist && playlist.tracks) || []
  return tracks.map((t) => ({
    id: t.id,
    name: t.name,
    artists: (t.ar || []).map((a) => a.name).join("/"),
    album: (t.al && t.al.name) || "",
    pic: (t.al && t.al.picUrl) || "",
    duration: t.dt || 0,
    getUrl: false
  }))
}

async function songUrl(trackId) {
  const r = await api.song_url_v1({ id: trackId, level: "standard", cookie: readCookie() })
  const list = r.body && r.body.data
  if (!Array.isArray(list) || !list.length) return null
  const d = list[0]
  return d && d.url ? d.url : null
}

module.exports = {
  loadProfile,
  logout,
  qrKey,
  qrCreate,
  qrCheck,
  loginByPhone,
  myPlaylists,
  playlistTracks,
  songUrl,
  isLoggedIn: () => loadProfile().then((p) => !!p)
}