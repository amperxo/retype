# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**retype** is a typing trainer for reading code: you load a codebase and type through it file by file to actually understand it. Comments, indentation, and non-keyboard characters stay on screen for context but are auto-filled — you only type the real code.

## Running

Zero build, zero dependencies, no package manager. It's three static files (`index.html`, `app.js`, `style.css`). Prism (syntax highlighting) loads from a CDN at runtime.

Serve over HTTP so GitHub `fetch` and Prism's autoloader work (opening `index.html` via `file://` breaks CDN/CORS):

```
python3 -m http.server 8000   # then open http://localhost:8000
```

There is no build, lint, or test setup.

## Architecture

All logic lives in `app.js` and runs client-side. The core pipeline turns source text into typeable "slots":

1. **Load** (`addFile`) — normalize line endings, strip emoji (`stripEmoji`), and map typographic characters to ASCII you can actually type (`normalizeTypography`, e.g. curly quotes → `'`). This is why the target string can differ from the raw file.
2. **Tokenize** (`charTypes` → `flattenTokens`) — run Prism to get a per-character `{ch, type}` array. Everything iterates by **code point** (`Array.from`), not code unit, so multi-byte characters don't desync the rendering. If Prism has no grammar (or output length ≠ code-point length), highlighting is skipped and `types` is `null`.
3. **Build slots** (`buildSlots`) — the heart of the app. Each slot is one target character with a `typeable` flag. Non-typeable ("marker" / auto-filled) slots are: leading indentation, trailing whitespace, comments, markdown formatting syntax, and any non-printable-ASCII character. A newline is typeable only if its line actually contains code, so blank/comment-only lines flow straight through to the next real code.
4. **Render** (`renderTyper`) — one `<span>` per slot inside a `<pre>`, carrying both a token-color class (`tok-<type>`) and a typing-state class.
5. **Type** (`handleKey` → `commit` / `backspace` → `stepForward`) — `stepForward` auto-fills non-typeable slots and parks the caret on the next typeable one. State classes (`pending`/`ok`/`err`/`auto`/`cur`) are swapped by `setState` while preserving the token-color class.

### State

A single global `app` object holds `files`, `activeIdx`, and the active `run`. A "run" is one file's typing session: `slots`, `spans` (parallel DOM array), `status` array, `cursor`, and live counters. Stats (`wpmOf`, `accOf`, `progOf`) are derived from the run on demand, ticked by a 250ms clock.

### GitHub loading (`loadRepo`)

Two API calls only — default branch, then the recursive git tree — to stay under the unauthenticated rate limit. File contents are then fetched from `raw.githubusercontent.com` (the CDN, which is *not* rate-limited) via a 6-way concurrency `pool`. Filtering: code extensions only (`EXT_LANG`/`CODE_EXT`), skip noise dirs (`IGNORE_DIR`), skip files > 200 KB, cap at 150 files.

## Conventions

- Adding language support = add the extension → Prism language mapping in `EXT_LANG` at the top of `app.js`. Prism's autoloader fetches the grammar on demand.
- The `slots` ↔ `spans` ↔ `status` arrays are index-parallel; keep them in sync when touching the typing engine.
- Slot indices (`slot.idx`) are global code-point positions into the canonical target and are used to look up token types — don't confuse them with the position in the `slots` array (they differ because a newline consumes an index too).
