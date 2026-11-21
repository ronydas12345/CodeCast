const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
const RECENT_KEY = "codecast:recent"

export function isRoomCode(value) {
  return typeof value === "string" && /^[a-z0-9]{6}$/.test(value)
}

export function makeRoomCode() {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  let code = ""
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return code
}

export function parseRoomInput(value) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const fromText = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (isRoomCode(fromText) && !trimmed.includes("/")) return fromText
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`)
    const parts = url.pathname.split("/").filter(Boolean)
    const last = (parts.at(-1) || "").toLowerCase()
    if (isRoomCode(last)) return last
  } catch {
    // Not a URL. Fall through to the compacted code.
  }
  return isRoomCode(fromText) ? fromText : null
}

export function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && isRoomCode(item.id)).slice(0, 6)
  } catch {
    return []
  }
}

export function rememberRoom(id) {
  if (!isRoomCode(id)) return
  const next = [{ id, at: Date.now() }, ...readRecent().filter((item) => item.id !== id)].slice(0, 6)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Private mode can reject storage. The room still works.
  }
}

let toastTimer = 0

export function toast(message) {
  let el = document.querySelector(".toast")
  if (!el) {
    el = document.createElement("div")
    el.className = "toast"
    el.setAttribute("role", "status")
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.add("show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800)
}
