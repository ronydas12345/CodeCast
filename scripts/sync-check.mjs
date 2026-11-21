import WebSocket from "ws"
import { ChangeSet, Text } from "@codemirror/state"

const room = `zz${Math.random().toString(36).slice(2, 6)}`.padEnd(6, "a").slice(0, 6)
const url = process.argv[2] || "ws://localhost:3000/ws"

function connect(name) {
  const socket = new WebSocket(url)
  const inbox = []
  const waiters = []
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString())
    if (waiters.length) waiters.shift()(msg)
    else inbox.push(msg)
  })
  return new Promise((resolve, reject) => {
    socket.on("error", reject)
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "join", roomId: room, peerId: name, name }))
      resolve({
        socket,
        send(msg) {
          socket.send(JSON.stringify(msg))
        },
        next(timeout = 2000) {
          if (inbox.length) return Promise.resolve(inbox.shift())
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => rejectNext(new Error(`timeout waiting for ${name}`)), timeout)
            waiters.push((msg) => {
              clearTimeout(timer)
              resolveNext(msg)
            })
          })
        },
      })
    })
  })
}

function asText(value) {
  return Text.of(value.split("\n"))
}

function applyAll(doc, updates) {
  let current = asText(doc)
  for (const update of updates) current = ChangeSet.fromJSON(update.changes).apply(current)
  return current.toString()
}

async function until(client, type) {
  for (let i = 0; i < 8; i += 1) {
    const msg = await client.next()
    if (msg.type === type) return msg
  }
  throw new Error(`did not see ${type}`)
}

const a = await connect("Ada")
const helloA = await until(a, "hello")
const b = await connect("Lin")
const helloB = await until(b, "hello")
if (helloB.doc !== helloA.doc) throw new Error("joiners did not see the same document")

const base = asText(helloA.doc)
const changeA = ChangeSet.of([{ from: base.length, insert: "\n// from A" }], base.length)
a.send({
  type: "push",
  version: helloA.version,
  updates: [{ clientID: "ada-client", changes: changeA.toJSON() }],
})

const fromA = await until(b, "updates")
const afterA = applyAll(helloB.doc, fromA.updates)
if (!afterA.endsWith("// from A")) throw new Error(`missing A's edit: ${JSON.stringify(afterA)}`)
const pushed = await until(a, "pushResult")
if (!pushed.ok) throw new Error("A's push was rejected")

const versionB = fromA.version + fromA.updates.length
const changeB = ChangeSet.of([{ from: 0, insert: "// from B\n" }], asText(afterA).length)
b.send({
  type: "push",
  version: versionB,
  updates: [{ clientID: "lin-client", changes: changeB.toJSON() }],
})
const fromB = await until(a, "updates")
const merged = applyAll(afterA, fromB.updates)
if (!merged.startsWith("// from B") || !merged.endsWith("// from A")) {
  throw new Error(`merged doc mismatch: ${JSON.stringify(merged)}`)
}

const late = await connect("Cam")
const helloLate = await until(late, "hello")
if (helloLate.doc !== merged) {
  throw new Error(`late joiner mismatch\n${helloLate.doc}\n---\n${merged}`)
}

a.send({ type: "chat", text: "synced" })
const chat = await until(b, "chat")
if (chat.entry.text !== "synced" || chat.entry.name !== "Ada") throw new Error("chat did not sync")

a.send({ type: "language", language: "python" })
const language = await until(b, "language")
if (language.language !== "python") throw new Error("language did not sync")

const stale = ChangeSet.of([{ from: 0, insert: "X" }], base.length)
a.send({
  type: "push",
  version: helloA.version,
  updates: [{ clientID: "ada-client", changes: stale.toJSON() }],
})
const gap = await until(a, "updates")
if (gap.version !== helloA.version || gap.updates.length < 2) throw new Error("stale client missed the gap")
const rejected = await until(a, "pushResult")
if (rejected.ok !== false) throw new Error("stale push was accepted")
const recovered = applyAll(helloA.doc, gap.updates)
if (recovered !== merged) throw new Error("gap replay did not match the room")

a.socket.close()
b.socket.close()
late.socket.close()
console.log(`sync ok (${room})`)
