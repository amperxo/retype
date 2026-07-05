# retype

**Type your own code to actually understand it.**

retype is a typing trainer for reading code. Load a codebase, then type through it file by file. Comments, indentation, and non-keyboard characters stay on screen for context — you only type the real code.

## Features

- **Load any public GitHub repo** — paste a URL and every code file is pulled in so you can type the whole project.
- **Comments & scaffolding auto-fill** — you read comments but never type them; leading indentation, trailing whitespace, and non-keyboard characters (accents, CJK, smart quotes) are filled in for you.
- **Per-character syntax highlighting** via [Prism](https://prismjs.com/), with language grammars loaded on demand.
- **Live stats** — words per minute, accuracy, and progress, plus a per-file results screen.
- **Zero build, zero dependencies** — three static files and a CDN script tag.

## Running

There's nothing to build. Serve the folder over HTTP so the GitHub `fetch` calls and Prism's CDN autoloader work (opening `index.html` directly via `file://` breaks CORS):

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Or click **Load sample →** to try it instantly with a small quicksort in Python.

## How to use

1. Paste a public repo URL (`github.com/owner/repo`) and hit **Load →**, or load the sample.
2. Pick a file from the sidebar and start typing the highlighted code.
3. Dimmed characters (comments, indentation) are filled in automatically — just type the real code.
4. `Tab` or `Esc` restarts the current file; `Enter` on the results screen advances to the next file.

## How it works

Source text is normalized (line endings, emoji stripped, smart punctuation mapped to ASCII), tokenized with Prism into per-character types, then split into "slots" — one target character each, marked typeable or auto-filled. See [CLAUDE.md](CLAUDE.md) for the full architecture.

GitHub loading uses just two API calls (default branch + recursive tree) to stay under the unauthenticated rate limit, then fetches file contents from `raw.githubusercontent.com`, which isn't rate-limited.

## Tech

Vanilla HTML/CSS/JS. No framework, no bundler, no package manager. Prism is the only external dependency, loaded from a CDN.
