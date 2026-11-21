import { isRoomCode, makeRoomCode, parseRoomInput, readRecent } from "./codes.js"

const app = document.querySelector("#app")
const match = location.pathname.match(/^\/([a-z0-9]{6})\/?$/)

boot()

async function boot() {
  if (location.pathname === "/") {
    document.title = "CodeCast"
    mountHome(app)
    return
  }
  if (match && isRoomCode(match[1])) {
    document.body.classList.add("is-room")
    document.title = `${match[1]} · CodeCast`
    const { mountRoom } = await import("./room.js")
    mountRoom(app, match[1])
    return
  }
  document.title = "Not found · CodeCast"
  mountMissing(app)
}

function mountHome(root) {
  root.replaceChildren()
  const page = el("main", "home")

  const bar = el("header", "home-bar")
  bar.append(brandLink(), el("span", "kicker", "Real-time code share"))
  page.append(bar)

  const hero = el("section", "hero")
  const copy = el("div", "hero-copy")
  copy.append(
    el("h1", "headline", "One link. One editor. Two cursors."),
    el(
      "p",
      "lede",
      "CodeCast is a codeshare-style room that runs on this machine. Create a link, send it across the table, and edit the same file together.",
    ),
  )

  const actions = el("div", "actions")
  const create = el("button", "btn btn-primary btn-large", "New room")
  create.type = "button"
  create.addEventListener("click", () => {
    location.assign(`/${makeRoomCode()}`)
  })
  actions.append(create)

  const join = el("form", "join")
  join.autocomplete = "off"
  const joinLabel = el("label", "join-label")
  joinLabel.append(el("span", "join-host", location.host), el("span", "join-slash", "/"))
  const input = document.createElement("input")
  input.name = "code"
  input.placeholder = "room code"
  input.spellcheck = false
  input.autocapitalize = "off"
  input.maxLength = 80
  input.setAttribute("aria-label", "Room code or link")
  input.required = true
  const submit = el("button", "btn", "Join")
  submit.type = "submit"
  joinLabel.append(input)
  join.append(joinLabel, submit)
  const joinError = el("p", "join-error")
  joinError.hidden = true
  joinError.setAttribute("role", "alert")
  join.addEventListener("submit", (event) => {
    event.preventDefault()
    const code = parseRoomInput(input.value)
    if (!code) {
      joinError.hidden = false
      joinError.textContent = "Enter a 6-character room code, or paste the whole link."
      input.focus()
      return
    }
    location.assign(`/${code}`)
  })
  actions.append(join, joinError)
  copy.append(actions)
  hero.append(copy, preview())
  page.append(hero)

  const steps = el("ol", "steps")
  for (const step of [
    ["01", "New room", "You get a short link and a file that's already open."],
    ["02", "Send it", "Anyone who opens the link lands in the same document."],
    ["03", "Type", "Edits, carets, language, and chat all stay in sync."],
  ]) {
    const item = el("li", "step")
    item.append(el("span", "step-index", step[0]), el("h2", "step-title", step[1]), el("p", "step-body", step[2]))
    steps.append(item)
  }
  page.append(steps)

  const recent = readRecent()
  if (recent.length) {
    const block = el("section", "recent")
    block.append(el("h2", "recent-title", "Recent rooms"))
    const list = el("ul", "recent-list")
    for (const item of recent) {
      const li = document.createElement("li")
      const link = document.createElement("a")
      link.href = `/${item.id}`
      link.textContent = item.id
      li.append(link)
      list.append(li)
    }
    block.append(list)
    page.append(block)
  }

  page.append(el("p", "fineprint", "Rooms stay in this server's memory for an hour after the last person leaves."))
  root.append(page)
}

function preview() {
  const frame = el("figure", "preview")
  frame.setAttribute("aria-hidden", "true")
  const chrome = el("div", "preview-chrome")
  chrome.append(el("span", "preview-dots"), el("span", "preview-code", "k7m2qp"), el("span", "preview-lang", "JavaScript"))
  const body = el("div", "preview-body")
  const lines = [
    ["1", "function greet(name) {"],
    ["2", '  return "Hello, " + name'],
    ["3", "}"],
    ["4", ""],
    ["5", 'console.log(greet("CodeCast"))'],
  ]
  for (const [n, text] of lines) {
    const row = el("div", "preview-line")
    const code = el("span", "preview-text", text)
    if (n === "1") code.append(caret("Ada", "#ff8a5b"))
    if (n === "5") code.append(caret("Lin", "#7eb6ff"))
    row.append(el("span", "preview-gutter", n), code)
    body.append(row)
  }
  frame.append(chrome, body)
  return frame
}

function caret(name, color) {
  const node = el("span", "preview-caret")
  node.style.setProperty("--c", color)
  node.append(el("span", "preview-flag", name))
  return node
}

function mountMissing(root) {
  root.replaceChildren()
  const page = el("main", "missing")
  page.append(
    brandLink(),
    el("h1", "headline", "That link doesn't go anywhere."),
    el("p", "lede", "Room codes are six letters or numbers. Start a new one from the home page."),
    Object.assign(document.createElement("a"), {
      href: "/",
      className: "btn btn-primary",
      textContent: "Back home",
    }),
  )
  root.append(page)
}

function brandLink() {
  const link = document.createElement("a")
  link.href = "/"
  link.className = "brand"
  const dot = el("span", "live-dot")
  dot.setAttribute("aria-hidden", "true")
  link.append(dot, Object.assign(document.createElement("span"), { className: "brand-name", textContent: "CodeCast" }))
  return link
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

