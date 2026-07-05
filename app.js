/* ========================================================================
   retype — type your own code to actually understand it
   Zero-build. All logic client-side. Prism gives per-token colors; we
   render each character as its own <span> so we can overlay typing state.
   ======================================================================== */

if (window.Prism) Prism.manual = true;
if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {
  Prism.plugins.autoloader.languages_path =
    "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/";
}

/* ---------- language / extension mapping ---------- */
const EXT_LANG = {
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", ts: "typescript", tsx: "tsx",
  java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", go: "go", rs: "rust", rb: "ruby", php: "php",
  swift: "swift", scala: "scala", dart: "dart", lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash",
  css: "css", scss: "scss", sass: "sass", less: "less",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml",
  sql: "sql", md: "markdown", markdown: "markdown", r: "r",
};
// extensions we consider "code"
const CODE_EXT = new Set(Object.keys(EXT_LANG));
// noise we never want to practice
const IGNORE_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|venv|__pycache__|\.venv|vendor|target)(\/|$)/;

/* ---------- DOM refs ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  filelist: $("filelist"), fileCount: $("file-count"),
  typer: $("typer"), typerWrap: $("typer-wrap"), placeholder: $("placeholder"),
  wpm: $("wpm"), acc: $("acc"), prog: $("prog"), hudFile: $("hud-file"),
  results: $("results"), rFile: $("r-file"), rWpm: $("r-wpm"), rAcc: $("r-acc"),
  rTime: $("r-time"), rChars: $("r-chars"), rErrs: $("r-errs"),
  repoStatus: $("repo-status"), repoUrl: $("repo-url"),
  caret: $("caret"), progbarFill: $("progbar-fill"),
};

/* ---------- app state ---------- */
const app = {
  files: [],       // { name, path, lang, code }
  activeIdx: -1,
  run: null,       // active typing run (see startRun)
};

/* ========================================================================
   FILE LOADING
   ======================================================================== */
function extOf(name) {
  const m = /\.([^.\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
function langFor(name) { return EXT_LANG[extOf(name)] || "none"; }

// strip emoji & other pictographs — you shouldn't have to type 🎉, and as
// surrogate pairs they'd otherwise desync the per-character rendering
const EMOJI_RE = new RegExp(
  "\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|[\\u{1F1E6}-\\u{1F1FF}]|[\\u200d\\u20e3\\ufe0e\\ufe0f]",
  "gu"
);
function stripEmoji(s) {
  return s.replace(EMOJI_RE, "").replace(/ +$/gm, ""); // drop emoji, tidy trailing spaces it left
}

// "smart"/typographic characters have no key on a normal keyboard, so map them
// to the ASCII you'd actually type. Applies to em/en dashes, curly quotes, etc.
function normalizeTypography(s) {
  return s
    .replace(/[‐-―−]/g, "-")                  // ‐ ‑ ‒ – — ― minus → -
    .replace(/[‘’‚‛′]/g, "'")       // curly single / prime → '
    .replace(/[“”„‟″]/g, '"')       // curly double / dprime → "
    .replace(/…/g, "...")                               // ellipsis … → ...
    .replace(/•/g, "-")                                 // bullet • → -
    .replace(/[  -   　]/g, " ");// nbsp & unicode spaces → space
}

function addFile(name, path, code) {
  code = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  code = normalizeTypography(stripEmoji(code));
  if (!code.trim()) return; // skip empty
  app.files.push({ name, path: path || name, lang: langFor(name), code });
}

function renderFileList() {
  els.filelist.innerHTML = "";
  els.fileCount.textContent = app.files.length;
  app.files.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = i === app.activeIdx ? "active" : "";
    li.title = f.path;
    li.innerHTML = `<span class="fi-name">${escapeHtml(f.name)}</span>` +
      `<span class="fi-ext">${f.lang === "none" ? "" : f.lang}</span>`;
    li.onclick = () => selectFile(i);
    els.filelist.appendChild(li);
  });
}

/* ========================================================================
   TOKENIZING → per-character [{ch, type}]
   ======================================================================== */
function flattenTokens(tokens, inheritedType, out) {
  for (const t of tokens) {
    if (typeof t === "string") {
      for (const ch of t) out.push({ ch, type: inheritedType });
    } else {
      const type = t.type || inheritedType;
      const content = t.content;
      if (Array.isArray(content)) flattenTokens(content, type, out);
      else for (const ch of String(content)) out.push({ ch, type });
    }
  }
}

function charTypes(code, lang) {
  const grammar = window.Prism && Prism.languages ? Prism.languages[lang] : null;
  if (!grammar) return null; // no highlighting available (yet)
  try {
    const tokens = Prism.tokenize(code, grammar);
    const out = [];
    flattenTokens(tokens, null, out);
    // flatten iterates by code point; compare against code-point length
    return out.length === Array.from(code).length ? out : null;
  } catch (_) { return null; }
}

/* ========================================================================
   BUILD SLOTS
   A "slot" is one target character. NON-typeable (auto-filled, shown dimmed)
   slots are: leading indentation, trailing whitespace, and comments — you
   read comments but never type them. A line break is typed (Enter) only when
   its line actually contains code; blank / comment-only lines flow straight
   through so you jump from real code to the next real code.
   ======================================================================== */
function canonicalTarget(code) {
  // trim trailing whitespace per line; rebuild a canonical target string
  const lines = code.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  return { lines, target: lines.join("\n") };
}

const isCommentType = (t) => !!t && /comment/.test(t);

// In markdown, Prism tags formatting markers with these token types. We skip
// them so you type the prose/code, not the ** ## > - ` [](…) scaffolding.
const MD_SKIP_TYPES = new Set(["punctuation", "url", "code-language", "hr", "blockquote", "list", "operator"]);
function isMdSyntax(type, ch) {
  if (MD_SKIP_TYPES.has(type)) return true;
  if (ch === "`" && type && type.indexOf("code") !== -1) return true; // inline-code backticks
  return false;
}

function buildSlots(lines, types, lang) {
  const isMd = lang === "markdown";
  const typeAt = (i) => (types && types[i] ? types[i].type : null);
  // a char that is shown but never typed: a comment, markdown formatting, or a
  // character that isn't on a normal keyboard (accents, CJK, symbols…). Smart
  // punctuation with an ASCII equivalent was already mapped in normalizeTypography.
  const isMarker = (type, ch) => {
    if (isCommentType(type) || (isMd && isMdSyntax(type, ch))) return true;
    if (ch === " " || ch === "\t") return false;    // whitespace handled separately
    const cp = ch.codePointAt(0);
    return ch.length > 1 || cp < 0x20 || cp > 0x7e;  // outside printable ASCII → skip
  };
  const slots = [];
  let idx = 0;
  for (let li = 0; li < lines.length; li++) {
    const chars = Array.from(lines[li]); // iterate by code point, not code unit
    const base = idx; // global code-point index of chars[0]

    // find the span of "real content" columns (not whitespace, not a marker)
    let first = -1, last = -1;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const isWs = ch === " " || ch === "\t";
      if (!isWs && !isMarker(typeAt(base + i), ch)) { if (first < 0) first = i; last = i; }
    }
    const lineHasCode = first >= 0;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const marker = isMarker(typeAt(idx), ch); // shown but not typed (comment / md / non-keyboard)
      const typeable = lineHasCode && i >= first && i <= last && !marker;
      slots.push({ ch, typeable, kind: "char", idx, marker });
      idx++;
    }
    if (li < lines.length - 1) {
      slots.push({ ch: "\n", typeable: lineHasCode, kind: "newline", idx, marker: false });
      idx++;
    }
  }
  return slots;
}

/* ========================================================================
   START A RUN
   ======================================================================== */
function selectFile(i) {
  app.activeIdx = i;
  renderFileList();
  startRun();
}

function startRun() {
  const file = app.files[app.activeIdx];
  if (!file) return;
  hideResults();
  els.placeholder.hidden = true;
  document.body.classList.add("typing");
  $("btn-restart").hidden = false;
  els.hudFile.textContent = file.path;

  const ensureLangThenBuild = () => {
    const { lines, target } = canonicalTarget(file.code);
    const types = charTypes(target, file.lang); // per-char token types (may be null)
    const slots = buildSlots(lines, types, file.lang); // comments/indent/md-syntax -> non-typeable
    const run = {
      slots, target, types,
      status: new Array(slots.length).fill("pending"),
      spans: [],
      cursor: 0,
      typed: 0, correct: 0, errors: 0,
      started: null, finished: false, lastLine: -1,
    };
    app.run = run;
    renderTyper(run);
    // advance past any leading auto slots. Snap the caret to its first spot
    // (no glide) so it doesn't streak across from the previous file/run.
    els.caret.classList.add("no-anim");
    run.cursor = -1;
    stepForward(run);
    requestAnimationFrame(() => els.caret.classList.remove("no-anim"));
    updateHud(run);
    els.typerWrap.focus();
  };

  // If the language grammar isn't loaded yet, ask the autoloader, then rebuild
  if (file.lang !== "none" && (!Prism.languages || !Prism.languages[file.lang]) &&
      Prism.plugins && Prism.plugins.autoloader) {
    Prism.plugins.autoloader.loadLanguages(file.lang, ensureLangThenBuild, ensureLangThenBuild);
  } else {
    ensureLangThenBuild();
  }
}

function renderTyper(run) {
  const frag = document.createDocumentFragment();
  run.spans = new Array(run.slots.length);
  for (let i = 0; i < run.slots.length; i++) {
    const slot = run.slots[i];
    const span = document.createElement("span");
    let cls = "c pending";
    if (run.types && run.types[slot.idx] && run.types[slot.idx].type) {
      cls += " tok-" + run.types[slot.idx].type;
    }
    if (slot.marker) cls += " cmt"; // comment / markdown syntax: visible, never typed
    if (slot.kind === "newline") cls += " nl";
    span.className = cls;
    span.textContent = slot.ch; // '\n' rendered literally; <pre> preserves it
    run.spans[i] = span;
    frag.appendChild(span);
  }
  els.typer.innerHTML = "";
  els.typer.appendChild(frag);
}

/* set a span's state class while preserving its token color class */
function setState(run, i, state) {
  const span = run.spans[i];
  if (!span) return;
  run.status[i] = state;
  span.className = span.className
    .replace(/\b(pending|ok|err|auto|cur|ws)\b/g, "").trim();
  span.classList.add("c", state);
  if (run.slots[i].kind === "newline" && (state === "err")) span.classList.add("ws");
}

/* ========================================================================
   TYPING LOGIC
   ======================================================================== */
function currentSlot(run) { return run.slots[run.cursor]; }

// move cursor forward from current position, auto-filling non-typeable slots,
// then place caret on the next typeable slot (or finish).
function stepForward(run) {
  // clear caret from current
  if (run.cursor >= 0 && run.spans[run.cursor])
    run.spans[run.cursor].classList.remove("cur");
  let i = run.cursor + 1;
  while (i < run.slots.length && !run.slots[i].typeable) {
    setState(run, i, "auto");
    i++;
  }
  run.cursor = i;
  if (i >= run.slots.length) { finishRun(run); return; }
  const span = run.spans[i];
  span.classList.add("cur");
  ensureVisible(run, i);
  moveCaret(run, i);
}

// glide the floating caret over the current character's span. Using offsets
// (not scroll-relative coords) keeps it glued to the span as the wrap scrolls.
let _lineH = 0;
function lineHeightPx() {
  // size the caret from the typer's line-height, NOT span.offsetHeight — a
  // newline span's box is taller than one line and would stretch the caret.
  if (!_lineH) _lineH = parseFloat(getComputedStyle(els.typer).lineHeight) || 40;
  return _lineH;
}
function moveCaret(run, i) {
  const span = run.spans[i], caret = els.caret;
  if (!span || !caret) return;
  const lh = lineHeightPx();
  const pad = lh * 0.14; // inset a touch top & bottom
  caret.style.opacity = "1";
  caret.style.height = (lh - pad * 2) + "px";
  caret.style.transform = `translate(${span.offsetLeft - 1}px, ${span.offsetTop + pad}px)`;
  // restart the blink so the caret is solid right after it moves
  caret.classList.remove("blink");
  void caret.offsetWidth; // force reflow so the animation actually restarts
  caret.classList.add("blink");
}
function hideCaret() { els.caret.classList.remove("blink"); els.caret.style.opacity = "0"; }

function ensureVisible(run, i) {
  // keep the current line comfortably in view (center-ish)
  const span = run.spans[i];
  if (!span) return;
  const wrap = els.typerWrap;
  const top = span.offsetTop;
  const target = top - wrap.clientHeight * 0.42;
  if (Math.abs(wrap.scrollTop - target) > wrap.clientHeight * 0.18) {
    wrap.scrollTop = target;
  }
}

function handleKey(e) {
  const run = app.run;
  if (!run || run.finished) {
    // results screen: Enter advances to the next file
    if (run && run.finished && e.key === "Enter") { e.preventDefault(); nextFile(); }
    return;
  }
  // global shortcuts
  if (e.key === "Tab" || e.key === "Escape") { e.preventDefault(); startRun(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "Backspace") { e.preventDefault(); backspace(run); return; }

  const slot = currentSlot(run);
  if (!slot) return;

  if (slot.kind === "newline") {
    if (e.key === "Enter") { e.preventDefault(); commit(run, true); }
    else if (e.key.length === 1) { e.preventDefault(); commit(run, false); } // wrong: expected line break
    return;
  }

  // normal character slot
  if (e.key === "Enter") { e.preventDefault(); commit(run, false); return; } // expected a char, got newline
  if (e.key.length !== 1) return; // ignore arrows, shift, etc.
  e.preventDefault();
  commit(run, e.key === slot.ch);
}

function commit(run, correct) {
  if (run.started === null) { run.started = performance.now(); startClock(); }
  const i = run.cursor;
  run.typed++;
  if (correct) { run.correct++; setState(run, i, "ok"); }
  else { run.errors++; setState(run, i, "err"); }
  stepForward(run);
  updateHud(run);
}

function backspace(run) {
  // find previous typeable slot
  let i = run.cursor - 1;
  while (i >= 0 && !run.slots[i].typeable) i--;
  if (i < 0) return;
  // remove caret from current
  if (run.cursor < run.slots.length && run.spans[run.cursor])
    run.spans[run.cursor].classList.remove("cur");
  // undo stats for the slot we're stepping back onto
  if (run.status[i] === "ok") run.correct--;
  else if (run.status[i] === "err") run.errors--;
  if (run.status[i] === "ok" || run.status[i] === "err") run.typed--;
  setState(run, i, "pending");
  run.cursor = i;
  run.spans[i].classList.add("cur");
  ensureVisible(run, i);
  moveCaret(run, i);
  updateHud(run);
}

/* ========================================================================
   STATS / HUD
   ======================================================================== */
let clockTimer = null;
function startClock() {
  stopClock();
  clockTimer = setInterval(() => { if (app.run) updateHud(app.run); }, 250);
}
function stopClock() { if (clockTimer) clearInterval(clockTimer); clockTimer = null; }

function elapsedMin(run) {
  if (run.started === null) return 0;
  const end = run.finished ? run.finishedAt : performance.now();
  return (end - run.started) / 60000;
}
function wpmOf(run) {
  const m = elapsedMin(run);
  return m > 0 ? Math.round((run.correct / 5) / m) : 0;
}
function accOf(run) {
  return run.typed > 0 ? Math.round((run.correct / run.typed) * 100) : 100;
}
function progOf(run) {
  const typeable = run.slots.filter((s) => s.typeable).length || 1;
  const done = run.status.filter((s) => s === "ok" || s === "err").length;
  return Math.round((done / typeable) * 100);
}
function updateHud(run) {
  const prog = progOf(run);
  els.wpm.textContent = wpmOf(run);
  els.acc.textContent = accOf(run) + "%";
  els.prog.textContent = prog + "%";
  els.progbarFill.style.width = prog + "%";
}

/* ========================================================================
   FINISH
   ======================================================================== */
function finishRun(run) {
  run.finished = true;
  run.finishedAt = performance.now();
  stopClock();
  hideCaret();
  const secs = Math.max(0, Math.round((run.finishedAt - (run.started ?? run.finishedAt)) / 1000));
  els.rFile.textContent = app.files[app.activeIdx]?.name || "";
  els.rWpm.textContent = wpmOf(run);
  els.rAcc.textContent = accOf(run) + "%";
  els.rTime.textContent = secs + "s";
  els.rChars.textContent = run.correct;
  els.rErrs.textContent = run.errors;
  els.results.hidden = false;
}
function hideResults() { els.results.hidden = true; }

/* back to the landing screen */
function goHome() {
  app.run = null;
  app.activeIdx = -1;
  stopClock();
  hideResults();
  els.typer.innerHTML = "";
  els.placeholder.hidden = false;
  document.body.classList.remove("typing");
  $("btn-restart").hidden = true;
  els.hudFile.textContent = "";
  els.wpm.textContent = "0";
  els.acc.textContent = "100%";
  els.prog.textContent = "0%";
  els.progbarFill.style.width = "0";
  hideCaret();
  setRepoStatus("");
  renderFileList();
}

/* ========================================================================
   GITHUB REPO LOADING
   1 API call for the default branch + 1 for the recursive tree, then raw
   file contents straight off the CDN (which don't hit the API rate limit).
   ======================================================================== */
function basename(p) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }

function parseRepoUrl(input) {
  let s = (input || "").trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^(www\.)?github\.com\//, "");
  const parts = s.split(/[?#]/)[0].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const info = { owner: parts[0], repo: parts[1], branch: null, subpath: "" };
  if (parts[2] === "tree" && parts[3]) { info.branch = parts[3]; info.subpath = parts.slice(4).join("/"); }
  return info;
}

function setRepoStatus(msg, isError) {
  els.repoStatus.textContent = msg;
  els.repoStatus.classList.toggle("error", !!isError);
}

async function pool(items, size, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function loadRepo(input) {
  const info = parseRepoUrl(input);
  if (!info) { setRepoStatus("enter a url like github.com/owner/repo", true); return; }
  const { owner, repo } = info;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    let branch = info.branch;
    if (!branch) {
      setRepoStatus(`resolving ${owner}/${repo}…`);
      const r = await fetch(api);
      if (r.status === 404) throw new Error("repo not found (is it public?)");
      if (r.status === 403) throw new Error("github rate limit hit — try again in a bit");
      if (!r.ok) throw new Error("github error " + r.status);
      branch = (await r.json()).default_branch;
    }
    setRepoStatus(`reading file tree (${branch})…`);
    const tr = await fetch(`${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tr.status === 403) throw new Error("github rate limit hit — try again in a bit");
    if (!tr.ok) throw new Error("couldn't read file tree (" + tr.status + ")");
    const treeJson = await tr.json();

    let blobs = (treeJson.tree || []).filter((n) =>
      n.type === "blob" && CODE_EXT.has(extOf(n.path)) &&
      !IGNORE_DIR.test("/" + n.path) && (n.size == null || n.size <= 200_000));
    if (info.subpath) blobs = blobs.filter((n) => n.path.startsWith(info.subpath));
    blobs.sort((a, b) => a.path.localeCompare(b.path));
    if (!blobs.length) throw new Error("no code files found in that repo");

    const MAX = 150;
    const capped = blobs.length > MAX;
    if (capped) blobs = blobs.slice(0, MAX);

    // replace whatever was loaded with this repo
    app.files = [];
    app.activeIdx = -1;
    renderFileList();

    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/`;
    let done = 0;
    await pool(blobs, 6, async (n) => {
      try {
        const res = await fetch(rawBase + n.path.split("/").map(encodeURIComponent).join("/"));
        if (res.ok) {
          const text = await res.text();
          if (text.length <= 200_000) addFile(basename(n.path), n.path, text);
        }
      } catch (_) { /* skip unreadable file */ }
      setRepoStatus(`loading files… ${++done}/${blobs.length}`);
    });

    renderFileList();
    if (!app.files.length) throw new Error("files couldn't be loaded");
    setRepoStatus(`loaded ${app.files.length} file${app.files.length > 1 ? "s" : ""}` +
      (capped ? ` (capped at ${MAX})` : ""));
    selectFile(0);
  } catch (e) {
    setRepoStatus(e.message || "failed to load repo", true);
  }
}

/* ========================================================================
   SAMPLE FILE (so it works instantly)
   ======================================================================== */
const SAMPLE = `# quicksort — small enough to read, real enough to learn
def quicksort(items):
    if len(items) <= 1:
        return items
    pivot = items[len(items) // 2]
    left = [x for x in items if x < pivot]
    middle = [x for x in items if x == pivot]
    right = [x for x in items if x > pivot]
    return quicksort(left) + middle + quicksort(right)


if __name__ == "__main__":
    data = [9, 3, 7, 1, 8, 2, 5]
    print("before:", data)
    print("after: ", quicksort(data))
`;
function loadSample() {
  app.files = [];          // replace whatever was loaded (e.g. a repo), like loadRepo does
  app.activeIdx = -1;
  addFile("quicksort.py", "quicksort.py", SAMPLE);
  renderFileList();
  selectFile(0);
}

/* ========================================================================
   WIRING
   ======================================================================== */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.querySelector(".brand").onclick = goHome;
$("btn-sidebar").onclick = () => {
  const hidden = $("sidebar").classList.toggle("collapsed");
  $("btn-sidebar").classList.toggle("active", !hidden); // highlight when list is open
  // move focus off the button, else Space/Enter while typing would re-toggle it
  $("btn-sidebar").blur();
  if (app.run && !app.run.finished) els.typerWrap.focus();
};
$("btn-sidebar").classList.add("active"); // sidebar starts open
$("btn-restart").onclick = startRun;
$("btn-sample").onclick = loadSample;
$("repo-form").onsubmit = (e) => { e.preventDefault(); loadRepo(els.repoUrl.value); };
$("r-again").onclick = startRun;
function nextFile() { if (app.files.length) selectFile((app.activeIdx + 1) % app.files.length); }
$("r-next").onclick = nextFile;

window.addEventListener("keydown", (e) => {
  // don't hijack typing while focused in the repo url input
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
  handleKey(e);
});

renderFileList();
