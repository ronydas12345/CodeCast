import { EditorState, Compartment, StateEffect, StateField, ChangeSet, Transaction } from "@codemirror/state"
import {
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  Decoration,
  WidgetType,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentUnit,
} from "@codemirror/language"
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete"
import { highlightSelectionMatches, searchKeymap, search } from "@codemirror/search"
import { collab, receiveUpdates, sendableUpdates, getSyncedVersion } from "@codemirror/collab"
import { tags as t } from "@lezer/highlight"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { cpp } from "@codemirror/lang-cpp"
import { java } from "@codemirror/lang-java"
import { go } from "@codemirror/lang-go"
import { rust } from "@codemirror/lang-rust"
import { php } from "@codemirror/lang-php"
import { sql } from "@codemirror/lang-sql"
import { xml } from "@codemirror/lang-xml"

const languageFor = {
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  python: () => python(),
  html: () => html(),
  css: () => css(),
  json: () => json(),
  markdown: () => markdown(),
  cpp: () => cpp(),
  java: () => java(),
  go: () => go(),
  rust: () => rust(),
  php: () => php(),
  sql: () => sql(),
  xml: () => xml(),
  plaintext: () => [],
}

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8d887c", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#e4ff4a" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#ffb48a" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#9fd4ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#fffaf0" },
  { tag: [t.className, t.typeName, t.namespace], color: "#d7b8ff" },
  { tag: [t.propertyName, t.attributeName], color: "#9fd4ff" },
  { tag: [t.tagName, t.heading], color: "#e4ff4a" },
  { tag: [t.operator, t.punctuation], color: "#c9c3b6" },
  { tag: [t.meta, t.processingInstruction], color: "#8d887c" },
])

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "#16150f",
    color: "#f4f0e6",
  },
  ".cm-scroller": {
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    lineHeight: "1.6",
  },
  ".cm-content": {
    caretColor: "#e4ff4a",
    fontSize: "14px",
    padding: "26px 0 72px",
  },
  ".cm-line": { padding: "0 16px 0 2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e4ff4a", borderLeftWidth: "2px" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "#e4ff4a" },
  ".cm-gutters": {
    backgroundColor: "#16150f",
    color: "#8a8478",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 16px", minWidth: "44px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#f4f0e6" },
  ".cm-activeLine": { backgroundColor: "rgba(244, 240, 230, 0.045)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(228, 255, 74, 0.22) !important" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "rgba(228, 255, 74, 0.28)",
  },
  ".cm-panels": {
    backgroundColor: "#1f1e18",
    color: "#f4f0e6",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid rgba(244, 240, 230, 0.12)" },
  ".cm-search input, .cm-textfield": {
    background: "#12110e",
    color: "#f4f0e6",
    border: "1px solid rgba(244, 240, 230, 0.2)",
    borderRadius: "6px",
  },
  ".cm-button": {
    background: "#2a2922",
    color: "#f4f0e6",
    border: "1px solid rgba(244, 240, 230, 0.16)",
    borderRadius: "6px",
  },
  ".cm-tooltip": {
    background: "#24231c",
    color: "#f4f0e6",
    border: "1px solid rgba(244, 240, 230, 0.14)",
    borderRadius: "8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "rgba(228, 255, 74, 0.16)",
    color: "#f4f0e6",
  },
  ".cm-foldGutter span": { color: "#8a8478" },
  "&.cm-focused": { outline: "none" },
}, { dark: true })

const setPeersEffect = StateEffect.define()

class PeerCaret extends WidgetType {
  constructor(peer) {
    super()
    this.peer = peer
  }

  eq(other) {
    return other instanceof PeerCaret
      && other.peer.name === this.peer.name
      && other.peer.color === this.peer.color
      && other.peer.head === this.peer.head
  }

  toDOM() {
    const wrap = document.createElement("span")
    wrap.className = "peer-caret"
    wrap.style.setProperty("--c", this.peer.color)
    wrap.setAttribute("aria-hidden", "true")
    const flag = document.createElement("span")
    flag.className = "peer-flag"
    flag.textContent = this.peer.name
    wrap.append(flag)
    return wrap
  }

  ignoreEvent() {
    return false
  }
}

function peerDecorations(peers, doc) {
  const marks = []
  const widgets = []
  let side = 1
  for (const peer of peers.values()) {
    if (typeof peer.head !== "number") continue
    const head = clamp(peer.head, doc.length)
    const anchor = clamp(peer.anchor ?? head, doc.length)
    const from = Math.min(anchor, head)
    const to = Math.max(anchor, head)
    if (from < to) {
      marks.push(Decoration.mark({
        class: "cm-peer-selection",
        attributes: { style: `--peer:${peer.color}` },
      }).range(from, to))
    }
    widgets.push(Decoration.widget({
      widget: new PeerCaret({ ...peer, head }),
      side: side++,
    }).range(head))
  }
  return { marks, widgets }
}

const peersField = StateField.define({
  create() {
    return new Map()
  },
  update(peers, tr) {
    let next = peers
    if (tr.docChanged && peers.size) {
      next = new Map()
      const limit = tr.startState.doc.length
      for (const [id, peer] of peers) {
        const head = Math.max(0, Math.min(peer.head, limit))
        const anchor = Math.max(0, Math.min(peer.anchor ?? peer.head, limit))
        next.set(id, {
          ...peer,
          head: tr.changes.mapPos(head, 1),
          anchor: tr.changes.mapPos(anchor, 1),
        })
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(setPeersEffect)) next = effect.value
    }
    return next
  },
})

const peerMarks = EditorView.decorations.compute([peersField], (state) => {
  return safeSet(peerDecorations(state.field(peersField), state.doc).marks)
})

const peerCarets = EditorView.decorations.compute([peersField], (state) => {
  return safeSet(peerDecorations(state.field(peersField), state.doc).widgets)
})

function safeSet(ranges) {
  if (!ranges.length) return Decoration.none
  try {
    return Decoration.set(ranges, true)
  } catch {
    return Decoration.none
  }
}

function clamp(pos, length) {
  if (typeof pos !== "number" || Number.isNaN(pos)) return 0
  return Math.max(0, Math.min(pos, length))
}

function supportFor(language) {
  return (languageFor[language] || languageFor.plaintext)()
}

function mapThroughUnconfirmed(state, pos) {
  let next = Math.max(0, pos)
  for (const update of sendableUpdates(state)) {
    if (next > update.changes.length) next = update.changes.length
    next = update.changes.mapPos(next, 1)
  }
  return clamp(next, state.doc.length)
}

function toSyncedPos(state, pos) {
  let next = clamp(pos, state.doc.length)
  const updates = sendableUpdates(state)
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const inverse = updates[index].changes.invertedDesc
    if (next > inverse.length) next = inverse.length
    next = inverse.mapPos(next, 1)
  }
  return Math.max(0, next)
}

export function createEditor(parent, { doc, version, language, hooks }) {
  const languageConf = new Compartment()
  let view

  const activity = ViewPlugin.fromClass(class {
    update(update) {
      const localChange = update.transactions.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))
      const peerPaint = update.transactions.length > 0 && update.transactions.every((tr) => (
        !tr.docChanged && !tr.selection && tr.effects.some((effect) => effect.is(setPeersEffect))
      ))
      if (localChange) hooks.onEdit(update.view)
      if (!peerPaint && (update.docChanged || update.selectionSet)) hooks.onSelect(update.view)
      if (update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setPeersEffect)))) {
        hooks.onPeers(update.view)
      }
    }
  })

  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      syntaxHighlighting(highlight),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
      ]),
      languageConf.of(supportFor(language)),
      theme,
      EditorView.contentAttributes.of({
        spellcheck: "false",
        "aria-label": "Shared code",
      }),
      collab({ startVersion: version }),
      peersField,
      peerMarks,
      peerCarets,
      activity,
    ],
  })

  view = new EditorView({ state, parent })

  return {
    view,
    destroy() {
      view.destroy()
    },
    focus() {
      view.focus()
    },
    version() {
      return getSyncedVersion(view.state)
    },
    sendable() {
      return sendableUpdates(view.state).map((update) => ({
        clientID: update.clientID,
        changes: update.changes.toJSON(),
      }))
    },
    applyUpdates(updates) {
      const decoded = updates.map((update) => ({
        clientID: String(update.clientID),
        changes: ChangeSet.fromJSON(update.changes),
      }))
      view.dispatch(receiveUpdates(view.state, decoded))
    },
    setLanguage(next) {
      view.dispatch({ effects: languageConf.reconfigure(supportFor(next)) })
    },
    setPeers(list) {
      const map = new Map()
      for (const peer of list) {
        if (typeof peer.head !== "number") continue
        map.set(peer.id, {
          ...peer,
          head: mapThroughUnconfirmed(view.state, peer.head),
          anchor: mapThroughUnconfirmed(view.state, peer.anchor ?? peer.head),
        })
      }
      view.dispatch({ effects: setPeersEffect.of(map) })
    },
    peerHead(id) {
      const peer = view.state.field(peersField).get(id)
      return peer ? peer.head : null
    },
    selection() {
      const range = view.state.selection.main
      return {
        anchor: toSyncedPos(view.state, range.anchor),
        head: toSyncedPos(view.state, range.head),
      }
    },
    localHead() {
      return view.state.selection.main.head
    },
    text() {
      return view.state.doc.toString()
    },
    lineOf(pos) {
      if (typeof pos !== "number") return null
      const clamped = clamp(pos, view.state.doc.length)
      return view.state.doc.lineAt(clamped).number
    },
  }
}
