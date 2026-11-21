import { rememberRoom, toast } from "./codes.js"
import { createEditor } from "./editor.js"
import { LANGUAGES, extensionFor } from "./languages.js"

const ADJECTIVES = ["Keen", "Bright", "Calm", "Bold", "Swift", "Quiet", "Warm", "Lucky", "Brisk", "Noble", "Merry", "Wild"]
const NOUNS = ["Otter", "Falcon", "Maple", "Quartz", "Cedar", "Lynx", "Heron", "Pebble", "Robin", "Comet", "Badger", "Willow"]

export function mountRoom(root, roomId) {
  const selfId = loadPeerId()
  let name = loadName()
  let language = "javascript"
  let peers = []
  let editor = null
  let socket = null
  let pushing = false
  let closed = false
  let fatal = false
  let sawHello = false
  let retry = 0
  let reconnectTimer = 0
  let cursorTimer = 0
  let lastCursor = ""

  root.replaceChildren()
  const room = el("section", "room")
  const title = el("h1", "sr-only", `Room ${roomId}`)

  const top = el("header", "topbar")
  const brand = document.createElement("a")
  brand.href = "/"
  brand.className = "brand"
  const brandDot = el("span", "live-dot")
  brandDot.setAttribute("aria-hidden", "true")
  brand.append(brandDot, el("span", "brand-name", "CodeCast"))

  const codeButton = el("button", "room-code")
  codeButton.type = "button"
  codeButton.title = "Copy room link"
  codeButton.append(el("span", null, roomId), el("span", "copy-hint", "Copy"))

  const conn = el("span", "conn")
  conn.dataset.state = "connecting"
  const connDot = el("span", "live-dot")
  connDot.setAttribute("aria-hidden", "true")
  const connLabel = el("span", "label", "Connecting")
  conn.append(connDot, connLabel)
  conn.setAttribute("role", "status")

  const langWrap = el("label", "lang-wrap")
  const langText = el("span", "sr-only", "Language")
  const langSelect = document.createElement("select")
  langSelect.setAttribute("aria-label", "Language")
  for (const [id, label] of LANGUAGES) {
    const option = document.createElement("option")
    option.value = id
    option.textContent = label
    langSelect.append(option)
  }
  langWrap.append(langText, langSelect)

  const avatars = el("div", "avatar-stack")
  const spacer = el("div", "top-spacer")

  const peopleButton = el("button", "btn panel-toggle", "Chat")
  peopleButton.type = "button"
  peopleButton.setAttribute("aria-expanded", "false")

  const download = el("button", "btn download", "Download")
  download.type = "button"

  const shareWrap = el("div", "share-wrap")
  const shareButton = el("button", "btn btn-primary", "Share")
  shareButton.type = "button"
  shareButton.setAttribute("aria-expanded", "false")
  const popover = el("div", "popover")
  popover.hidden = true
  popover.append(el("p", null, "Anyone with this link can edit the file."))
  const shareRow = el("div", "share-link")
  const shareInput = document.createElement("input")
  shareInput.readOnly = true
  shareInput.value = `${location.origin}/${roomId}`
  shareInput.setAttribute("aria-label", "Room link")
  const copyButton = el("button", "btn", "Copy")
  copyButton.type = "button"
  shareRow.append(shareInput, copyButton)
  popover.append(shareRow)
  shareWrap.append(shareButton, popover)

  top.append(brand, codeButton, conn, langWrap, avatars, spacer, peopleButton, download, shareWrap)

  const workspace = el("div", "workspace")
  const pane = el("div", "editor-pane")
  const banner = el("p", "banner")
  banner.hidden = true
  const host = el("div", "editor-host")
  host.append(el("p", "editor-wait", "Opening room…"))
  pane.append(banner, host)

  const sidebar = el("aside", "sidebar")
  sidebar.setAttribute("aria-label", "People and chat")

  const nameBlock = el("div", "side-block name-row")
  const nameLabel = el("label", "side-label", "Your name")
  nameLabel.htmlFor = "your-name"
  const nameInput = document.createElement("input")
  nameInput.id = "your-name"
  nameInput.maxLength = 24
  nameInput.value = name
  nameInput.autocomplete = "nickname"
  nameInput.spellcheck = false
  nameBlock.append(nameLabel, nameInput)

  const peerList = el("ul", "peer-list")
  const chat = el("section", "chat")
  chat.append(el("h2", "side-label", "Chat"))
  const chatEmpty = el("p", "chat-empty", "Say hello. Everyone on this link will see it.")
  const chatLog = el("ol", "chat-log")
  const chatForm = el("form", "chat-form")
  const chatInput = document.createElement("input")
  chatInput.maxLength = 1000
  chatInput.placeholder = "Message"
  chatInput.setAttribute("aria-label", "Message")
  chatInput.autocomplete = "off"
  const chatSend = el("button", "btn", "Send")
  chatSend.type = "submit"
  chatForm.append(chatInput, chatSend)
  chat.append(chatEmpty, chatLog, chatForm)
  sidebar.append(nameBlock, peerList, chat, el("p", "side-hint", "Tab indents · Ctrl or Cmd F finds"))
  workspace.append(pane, sidebar)
  room.append(title, top, workspace)
  root.append(room)

  codeButton.addEventListener("click", () => copyLink())
  copyButton.addEventListener("click", () => copyLink())
  shareButton.addEventListener("click", () => {
    const open = popover.hidden
    popover.hidden = !open
    shareButton.setAttribute("aria-expanded", String(open))
    if (open) {
      shareInput.focus()
      shareInput.select()
    }
  })
  peopleButton.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open")
    peopleButton.setAttribute("aria-expanded", String(open))
  })
  download.addEventListener("click", downloadFile)
  langSelect.addEventListener("change", () => {
    language = langSelect.value
    editor?.setLanguage(language)
    send({ type: "language", language })
  })
  nameInput.addEventListener("change", commitName)
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") nameInput.blur()
  })
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const text = chatInput.value.trim()
    if (!text) return
    if (!send({ type: "chat", text })) {
      showBanner("Still connecting. Try that message again in a moment.")
      return
    }
    chatInput.value = ""
  })

  document.addEventListener("keydown", onKey)
  document.addEventListener("pointerdown", onPointer)
  window.addEventListener("pagehide", shutdown)
  connect()

  function connect() {
    if (closed || fatal) return
    window.clearTimeout(reconnectTimer)
    const protocol = location.protocol === "https:" ? "wss" : "ws"
    const current = new WebSocket(`${protocol}://${location.host}/ws`)
    socket = current
    current.addEventListener("open", () => {
      if (socket !== current) return
      retry = 0
      send({ type: "join", roomId, peerId: selfId, name })
    })
    current.addEventListener("message", (event) => {
      if (socket !== current) return
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      handle(msg)
    })
    current.addEventListener("close", () => {
      if (socket !== current || closed || fatal) return
      pushing = false
      setStatus("reconnecting")
      const delay = Math.min(8000, 400 * 2 ** retry)
      retry += 1
      reconnectTimer = window.setTimeout(connect, delay)
    })
  }

  function handle(msg) {
    if (msg.type === "error") {
      fatal = true
      showBanner(msg.message || "Couldn't join this room.")
      setStatus("reconnecting", "Offline")
      socket?.close()
      return
    }
    if (msg.type === "hello" || msg.type === "reset") {
      const first = !sawHello
      sawHello = true
      if (msg.you?.name) {
        name = msg.you.name
        if (document.activeElement !== nameInput) nameInput.value = name
        try { localStorage.setItem("codecast:name", name) } catch { /* ignore */ }
      }
      if (Array.isArray(msg.peers)) peers = msg.peers
      if (Array.isArray(msg.chat)) replaceChat(msg.chat)
      openDocument(msg)
      renderPeers()
      if (msg.reason) showBanner(msg.reason)
      else showBanner("")
      if (!first) toast("Reconnected")
      rememberRoom(roomId)
      return
    }
    if (msg.type === "updates") {
      if (!editor || !Array.isArray(msg.updates)) return
      const synced = editor.version()
      if (msg.version < synced) return
      if (msg.version > synced) {
        send({ type: "pull", version: synced })
        return
      }
      if (!msg.updates.length) return
      try {
        editor.applyUpdates(msg.updates)
      } catch (error) {
        console.error(error)
        send({ type: "resync" })
        return
      }
      schedulePush()
      return
    }
    if (msg.type === "pushResult") {
      pushing = false
      lastCursor = ""
      sendCursor()
      schedulePush()
      return
    }
    if (msg.type === "presence" && Array.isArray(msg.peers)) {
      peers = msg.peers
      const you = peers.find((peer) => peer.id === selfId)
      if (you && document.activeElement !== nameInput) nameInput.value = you.name
      renderPeers()
      editor?.setPeers(peers.filter((peer) => peer.id !== selfId))
      return
    }
    if (msg.type === "language" && msg.language && msg.language !== language) {
      language = msg.language
      langSelect.value = language
      editor?.setLanguage(language)
      return
    }
    if (msg.type === "chat" && msg.entry) appendChat(msg.entry)
  }

  function openDocument(msg) {
    pushing = false
    lastCursor = ""
    language = msg.language || language
    langSelect.value = language
    editor?.destroy()
    editor = null
    host.replaceChildren()
    editor = createEditor(host, {
      doc: msg.doc ?? "",
      version: Number(msg.version) || 0,
      language,
      hooks: {
        onEdit: schedulePush,
        onSelect: queueCursor,
        onPeers: renderPeers,
      },
    })
    editor.setPeers(peers.filter((peer) => peer.id !== selfId))
    editor.focus()
    queueCursor()
    setStatus("live")
  }

  function schedulePush() {
    if (!editor || pushing || fatal) return
    const updates = editor.sendable()
    if (!updates.length) return
    const version = editor.version()
    pushing = true
    if (!send({ type: "push", version, updates })) pushing = false
  }

  function queueCursor() {
    window.clearTimeout(cursorTimer)
    cursorTimer = window.setTimeout(sendCursor, 40)
  }

  function sendCursor() {
    if (!editor) return
    const selection = editor.selection()
    const key = `${selection.anchor}:${selection.head}`
    if (key === lastCursor) return
    if (!send({ type: "cursor", ...selection })) return
    lastCursor = key
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  function renderPeers() {
    peerList.replaceChildren()
    const source = peers.length ? peers : []
    if (!source.length) {
      peerList.append(el("li", null, "Waiting for the room…"))
      avatars.replaceChildren()
      return
    }
    for (const peer of source) {
      const item = document.createElement("li")
      const swatch = el("span", "peer-swatch")
      swatch.style.background = peer.color || "#e4ff4a"
      const label = peer.id === selfId ? `${peer.name} (you)` : peer.name
      const who = el("span", "peer-name", label)
      let pos = peer.head
      if (editor && peer.id === selfId) pos = editor.localHead()
      else if (editor) {
        const mapped = editor.peerHead(peer.id)
        if (typeof mapped === "number") pos = mapped
      }
      const where = el("span", "peer-line", typeof pos === "number" && editor ? `Ln ${editor.lineOf(pos)}` : "Here")
      item.append(swatch, who, where)
      peerList.append(item)
    }
    avatars.replaceChildren()
    for (const peer of source.slice(0, 4)) {
      const avatar = el("span", "avatar", initials(peer.name))
      avatar.style.background = peer.color || "#e4ff4a"
      avatar.title = peer.name
      avatars.append(avatar)
    }
    if (source.length > 4) {
      const more = el("span", "avatar more", `+${source.length - 4}`)
      more.title = `${source.length} people`
      avatars.append(more)
    }
  }

  function replaceChat(entries) {
    chatLog.replaceChildren()
    chatEmpty.hidden = entries.length > 0
    for (const entry of entries) appendChat(entry, false)
    chatLog.scrollTop = chatLog.scrollHeight
  }

  function appendChat(entry, scroll = true) {
    chatEmpty.hidden = true
    const item = document.createElement("li")
    const who = el("span", "chat-who")
    const person = el("span", null, entry.name || "Guest")
    person.style.color = entry.color || "inherit"
    who.append(person, el("time", "chat-time", formatTime(entry.ts)))
    const body = el("p", null, entry.text || "")
    item.append(who, body)
    chatLog.append(item)
    if (scroll) chatLog.scrollTop = chatLog.scrollHeight
  }

  function commitName() {
    const next = nameInput.value.trim().slice(0, 24)
    if (!next) {
      nameInput.value = name
      return
    }
    name = next
    try { localStorage.setItem("codecast:name", name) } catch { /* ignore */ }
    send({ type: "rename", name })
  }

  async function copyLink() {
    const url = `${location.origin}/${roomId}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      shareInput.focus()
      shareInput.select()
      document.execCommand("copy")
    }
    toast("Link copied")
  }

  function downloadFile() {
    if (!editor) return
    const blob = new Blob([editor.text()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `codecast-${roomId}.${extensionFor(language)}`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function showBanner(text) {
    banner.hidden = !text
    banner.textContent = text || ""
  }

  function setStatus(state, text) {
    conn.dataset.state = state
    const labels = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting" }
    connLabel.textContent = text || labels[state] || "Connecting"
  }

  function onKey(event) {
    if (event.key !== "Escape") return
    popover.hidden = true
    shareButton.setAttribute("aria-expanded", "false")
    sidebar.classList.remove("open")
    peopleButton.setAttribute("aria-expanded", "false")
  }

  function onPointer(event) {
    if (!shareWrap.contains(event.target)) {
      popover.hidden = true
      shareButton.setAttribute("aria-expanded", "false")
    }
  }

  function shutdown() {
    closed = true
    window.clearTimeout(reconnectTimer)
    window.clearTimeout(cursorTimer)
    socket?.close()
    editor?.destroy()
    document.removeEventListener("keydown", onKey)
    document.removeEventListener("pointerdown", onPointer)
    window.removeEventListener("pagehide", shutdown)
  }
}

function loadName() {
  try {
    const saved = localStorage.getItem("codecast:name")
    if (saved && saved.trim()) return saved.trim().slice(0, 24)
  } catch { /* ignore */ }
  const picked = `${pick(ADJECTIVES)} ${pick(NOUNS)}`
  try { localStorage.setItem("codecast:name", picked) } catch { /* ignore */ }
  return picked
}

function loadPeerId() {
  try {
    const saved = sessionStorage.getItem("codecast:peer")
    if (saved) return saved
  } catch { /* ignore */ }
  const id = crypto.randomUUID()
  try { sessionStorage.setItem("codecast:peer", id) } catch { /* ignore */ }
  return id
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function initials(value) {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?"
}

function formatTime(ts) {
  const date = new Date(ts || Date.now())
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}
