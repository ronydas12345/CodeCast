import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import express from "express"
import { WebSocketServer } from "ws"
import { ChangeSet, Text } from "@codemirror/state"

const nodeMajor = Number(process.versions.node.split(".")[0])
if (nodeMajor < 20) {
  console.error("CodeCast needs Node.js 20 or newer.")
  process.exit(1)
}

const root = path.dirname(fileURLToPath(import.meta.url))
const MAX_DOC = 200_000
const MAX_MESSAGE = 600_000
const ROOM_TTL_MS = 60 * 60 * 1000
const MAX_PEERS = 12

const LANGUAGES = new Set([
  "javascript",
  "typescript",
  "python",
  "html",
  "css",
  "json",
  "markdown",
  "cpp",
  "java",
  "go",
  "rust",
  "php",
  "sql",
  "xml",
  "plaintext",
])

const PALETTE = ["#ff8a5b", "#7eb6ff", "#d2a6ff", "#5ee0b5", "#ffd166", "#ff7ab2", "#9ad1d4", "#e4ff4a"]

const STARTER = Text.of([
  "// This room is live.",
  "// Send the link to someone and type together.",
  "",
  "function greet(name) {",
  '  return "Hello, " + name',
  "}",
  "",
  'console.log(greet("CodeCast"))',
])

/** @type {Map<string, Room>} */
const rooms = new Map()

/**
 * The server is the authority for one document per room.
 * Clients send CodeMirror change sets tagged with the version they
 * were based on. Matching versions are appended and broadcast.
 * A stale sender receives the gap and retries its rebased edits.
 */

function createRoom(id) {
  return {
    id,
    doc: STARTER,
    updates: [],
    language: "javascript",
    chat: [],
    peers: new Map(),
    seq: 1,
    cleanup: null,
  }
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message))
}

function broadcast(room, message, except) {
  const data = JSON.stringify(message)
  for (const peer of room.peers.values()) {
    if (peer === except) continue
    if (peer.socket.readyState === 1) peer.socket.send(data)
  }
}

function cleanName(name) {
  const text = String(name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24)
  return text || "Guest"
}

function cleanId(id) {
  const text = String(id ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)
  return text || randomUUID()
}

function pickColor(room, id) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  for (let offset = 0; offset < PALETTE.length; offset += 1) {
    const color = PALETTE[(hash + offset) % PALETTE.length]
    const taken = [...room.peers.values()].some((peer) => peer.color === color)
    if (!taken) return color
  }
  return PALETTE[hash % PALETTE.length]
}

function publicPeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    color: peer.color,
    head: peer.head,
    anchor: peer.anchor,
  }
}

function presence(room) {
  return {
    type: "presence",
    peers: [...room.peers.values()].map(publicPeer),
  }
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanup)
  if (room.peers.size > 0) return
  room.cleanup = setTimeout(() => {
    if (room.peers.size === 0) rooms.delete(room.id)
  }, ROOM_TTL_MS)
}

function clampPos(doc, pos) {
  const value = Number(pos)
  if (!Number.isInteger(value)) return null
  return Math.max(0, Math.min(value, doc.length))
}

function applyBatch(room, batch) {
  let doc = room.doc
  const accepted = []
  for (const update of batch) {
    if (!update || typeof update.clientID !== "string" || update.clientID.length > 80) {
      throw new Error("bad update")
    }
    const changes = ChangeSet.fromJSON(update.changes)
    doc = changes.apply(doc)
    if (doc.length > MAX_DOC) throw new Error("too large")
    accepted.push({ clientID: update.clientID, changes: update.changes })
  }
  room.doc = doc
  room.updates.push(...accepted)
  return accepted
}

function hello(room, peer) {
  return {
    type: "hello",
    roomId: room.id,
    doc: room.doc.toString(),
    version: room.updates.length,
    language: room.language,
    chat: room.chat,
    you: publicPeer(peer),
    peers: [...room.peers.values()].map(publicPeer),
  }
}

function reset(room, reason) {
  return {
    type: "reset",
    doc: room.doc.toString(),
    version: room.updates.length,
    language: room.language,
    reason,
  }
}

function allowChat(peer) {
  const now = Date.now()
  peer.chatTimes = (peer.chatTimes || []).filter((time) => now - time < 5000)
  if (peer.chatTimes.length >= 8) return false
  peer.chatTimes.push(now)
  return true
}

function onRoomMessage(room, peer, msg) {
  if (msg.type === "push") {
    const version = Number(msg.version)
    if (!Number.isInteger(version) || version < 0 || version > room.updates.length) {
      send(peer.socket, reset(room, "Resynced with the room."))
      send(peer.socket, { type: "pushResult", ok: false })
      return
    }
    if (version !== room.updates.length) {
      send(peer.socket, {
        type: "updates",
        version,
        updates: room.updates.slice(version),
      })
      send(peer.socket, { type: "pushResult", ok: false })
      return
    }
    const batch = Array.isArray(msg.updates) ? msg.updates.slice(0, 100) : []
    if (!batch.length) {
      send(peer.socket, { type: "pushResult", ok: true })
      return
    }
    try {
      const accepted = applyBatch(room, batch)
      broadcast(room, { type: "updates", version, updates: accepted })
      send(peer.socket, { type: "pushResult", ok: true })
    } catch (error) {
      const reason = error.message === "too large"
        ? "This demo keeps each room under 200,000 characters."
        : "Couldn't apply that edit. Reloaded the room copy."
      send(peer.socket, reset(room, reason))
      send(peer.socket, { type: "pushResult", ok: false, reason })
    }
    return
  }

  if (msg.type === "pull" || msg.type === "resync") {
    if (msg.type === "resync" || !Number.isInteger(msg.version)) {
      send(peer.socket, reset(room))
      return
    }
    const version = msg.version
    if (version < 0 || version > room.updates.length) {
      send(peer.socket, reset(room))
      return
    }
    send(peer.socket, {
      type: "updates",
      version,
      updates: room.updates.slice(version),
    })
    return
  }

  if (msg.type === "cursor") {
    const head = clampPos(room.doc, msg.head)
    const anchor = clampPos(room.doc, msg.anchor)
    if (head == null) return
    peer.head = head
    peer.anchor = anchor ?? head
    broadcast(room, presence(room), peer)
    return
  }

  if (msg.type === "language") {
    if (!LANGUAGES.has(msg.language) || msg.language === room.language) return
    room.language = msg.language
    broadcast(room, { type: "language", language: room.language })
    return
  }

  if (msg.type === "rename") {
    peer.name = cleanName(msg.name)
    broadcast(room, presence(room))
    return
  }

  if (msg.type === "chat") {
    const text = String(msg.text ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 1000)
    if (!text || !allowChat(peer)) return
    const entry = {
      id: room.seq++,
      name: peer.name,
      color: peer.color,
      text,
      ts: Date.now(),
    }
    room.chat.push(entry)
    if (room.chat.length > 80) room.chat.splice(0, room.chat.length - 80)
    broadcast(room, { type: "chat", entry })
  }
}

function attachSocket(socket) {
  let peer = null
  let room = null

  const leave = () => {
    if (!room || !peer) return
    const current = room.peers.get(peer.id)
    if (current && current.socket === socket) {
      room.peers.delete(peer.id)
      broadcast(room, presence(room))
      scheduleCleanup(room)
    }
    peer = null
  }

  socket.once("message", (raw) => {
    let msg
    try {
      if (raw.length > MAX_MESSAGE) throw new Error("large")
      msg = JSON.parse(raw.toString())
    } catch {
      socket.close()
      return
    }
    if (!msg || msg.type !== "join" || !/^[a-z0-9]{6}$/.test(msg.roomId)) {
      send(socket, { type: "error", message: "Room codes are 6 letters or numbers." })
      socket.close()
      return
    }

    const created = !rooms.has(msg.roomId)
    room = rooms.get(msg.roomId) ?? createRoom(msg.roomId)
    rooms.set(room.id, room)
    if (created) console.log(`room ${room.id} open`)
    clearTimeout(room.cleanup)

    const id = cleanId(msg.peerId)
    const previous = room.peers.get(id)
    if (!previous && room.peers.size >= MAX_PEERS) {
      send(socket, { type: "error", message: "This room is full (12 people)." })
      socket.close()
      room = null
      return
    }
    if (previous && previous.socket !== socket) previous.socket.close()

    peer = {
      id,
      name: cleanName(msg.name),
      color: previous?.color || pickColor(room, id),
      head: null,
      anchor: null,
      socket,
      chatTimes: [],
    }
    room.peers.set(id, peer)
    send(socket, hello(room, peer))
    broadcast(room, presence(room), peer)

    socket.on("message", (next) => {
      if (!room || !peer || room.peers.get(peer.id)?.socket !== socket) return
      let incoming
      try {
        if (next.length > MAX_MESSAGE) throw new Error("large")
        incoming = JSON.parse(next.toString())
      } catch {
        return
      }
      if (!incoming || typeof incoming.type !== "string") return
      try {
        onRoomMessage(room, peer, incoming)
      } catch (error) {
        console.error("room message failed", error)
      }
    })
  })

  socket.on("close", leave)
  socket.on("error", leave)
}

const app = express()
const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: "/ws" })
wss.on("connection", attachSocket)

const onVercel = Boolean(process.env.VERCEL)
const distDir = path.join(root, "dist")
const useViteDev = !onVercel && process.env.NODE_ENV !== "production"

async function sendPage(req, res, next, vite) {
  if (req.method !== "GET" && req.method !== "HEAD") return next()
  const pathname = decodeURIComponent(req.path).replace(/\/+$/, "") || "/"
  if (pathname !== "/" && !/^\/[a-z0-9]{6}$/.test(pathname)) return next()
  try {
    if (vite) {
      const templatePath = path.join(root, "index.html")
      let html = await fs.readFile(templatePath, "utf8")
      html = await vite.transformIndexHtml(req.originalUrl, html)
      res.status(200).set({ "Content-Type": "text/html" }).end(html)
      return
    }
    res.sendFile(path.join(distDir, "index.html"))
  } catch (error) {
    if (vite) vite.ssrFixStacktrace(error)
    next(error)
  }
}

async function boot() {
  if (useViteDev) {
    const { createServer: createViteServer } = await import("vite")
    const vite = await createViteServer({
      root,
      appType: "custom",
      clearScreen: false,
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    })
    app.use(vite.middlewares)
    app.use((req, res, next) => sendPage(req, res, next, vite))
  } else {
    app.use(express.static(distDir, { index: false, fallthrough: true }))
    app.use((req, res, next) => sendPage(req, res, next, null))
  }

  app.use((req, res) => {
    res.status(404).type("text/plain").send("Not found")
  })

  if (!onVercel) {
    const port = Number(process.env.PORT) || 3000
    httpServer.listen(port, () => {
      console.log(`CodeCast demo at http://localhost:${port}`)
    })
  }
}

await boot()

export default httpServer
