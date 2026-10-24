import { REPO_A, REPO_B } from "./gateway.ts";

/** A command the playground offers, and what it should do in the sandbox. */
export interface Preset {
  readonly label: string;
  readonly cmd: string;
  /** `allowed`: exits 0. `refused`: the proxy answers 403. */
  readonly expect: "allowed" | "refused";
  /** Text the output contains when it behaves. */
  readonly shows: string;
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    label: "Clone (granted)",
    cmd: `cd /tmp && rm -rf repo && git clone -q --depth 1 https://github.com/${REPO_B} repo && ls repo`,
    expect: "allowed",
    shows: "package.json",
  },
  {
    label: "ls-remote (granted)",
    cmd: `git ls-remote https://github.com/${REPO_A} HEAD`,
    expect: "allowed",
    shows: "HEAD",
  },
  {
    label: "gh api (real token added)",
    cmd: `gh api repos/${REPO_A} --jq .full_name`,
    expect: "allowed",
    shows: REPO_A,
  },
  {
    label: "Placeholder token",
    cmd: `echo "GH_TOKEN=$GH_TOKEN"`,
    expect: "allowed",
    shows: "GH_TOKEN=alchemy-egress",
  },
  {
    label: "Repo outside the grant (403)",
    cmd: "git ls-remote https://github.com/cli/cli HEAD",
    expect: "refused",
    shows: "403",
  },
  {
    label: "Host without a route (403)",
    cmd: "curl -sS -o /dev/null -w '%{http_connect}\\n' https://example.com",
    expect: "refused",
    shows: "403",
  },
  {
    label: "MicroVM info",
    cmd: "uname -a; nproc; grep MemTotal /proc/meminfo",
    expect: "allowed",
    shows: "MemTotal",
  },
];

/** GET / — a page to drive the sandbox from a browser. */
export const PLAYGROUND = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MicroVM sandbox playground</title>
<style>
  :root { color-scheme: light dark; --bg: #0f1115; --panel: #171a21; --line: #2a2f3a; --fg: #e6e8ee; --dim: #8b93a5; --ok: #4ade80; --bad: #f87171; --accent: #7aa2f7; }
  @media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --panel: #fff; --line: #dde1e8; --fg: #1b1f27; --dim: #5b6475; --accent: #2f5bd3; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.lede { margin: 0 0 20px; color: var(--dim); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: progress; }
  #status { margin-left: auto; color: var(--dim); font-size: 13px; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
  .presets button { font-size: 12px; padding: 4px 8px; }
  textarea { width: 100%; min-height: 96px; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  .run { display: flex; gap: 8px; align-items: center; margin: 8px 0 20px; }
  .run span { color: var(--dim); font-size: 12px; }
  .entry { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 12px; overflow: hidden; }
  .entry header { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); font: 12px ui-monospace, Menlo, monospace; color: var(--dim); }
  .entry header code { color: var(--fg); white-space: pre-wrap; word-break: break-all; flex: 1; }
  .code.ok { color: var(--ok); } .code.bad { color: var(--bad); }
  pre { margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 ui-monospace, Menlo, monospace; }
  pre.err { color: var(--bad); border-top: 1px dashed var(--line); }
</style>
</head>
<body>
<main>
  <h1>MicroVM sandbox playground</h1>
  <p class="lede">A Lambda MicroVM owned by a Durable Object. Its GitHub egress goes through a gateway on a multi-Region Lambda Web Function, which adds the real token. The sandbox holds only a placeholder, and can read ${REPO_A} and ${REPO_B}; everything else is refused.</p>
  <div class="bar">
    <button class="primary" data-action="start">Start</button>
    <button data-action="start?size=large">Start (large)</button>
    <button data-action="narrow">Narrow to ${REPO_A}</button>
    <button data-action="stop">Stop</button>
    <button data-action="debug" data-get>Debug</button>
    <span id="status">checking…</span>
  </div>
  <div class="presets">${PRESETS.map(({ label, cmd }) => `<button data-cmd="${cmd.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${label}</button>`).join("")}</div>
  <textarea id="cmd" spellcheck="false">git ls-remote https://github.com/${REPO_A} HEAD</textarea>
  <div class="run"><button class="primary" id="run">Run</button><span>⌘/Ctrl + Enter</span></div>
  <div id="log"></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const log = $("#log");
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const entry = (title, body, code, err) => {
  const el = document.createElement("div");
  el.className = "entry";
  const codeHtml = code === undefined ? "" : '<span class="code ' + (code === 0 ? "ok" : "bad") + '">exit ' + code + "</span>";
  el.innerHTML = "<header><code>" + esc(title) + "</code>" + codeHtml + "</header>" +
    (body ? "<pre>" + esc(body) + "</pre>" : "") + (err ? '<pre class="err">' + esc(err) + "</pre>" : "");
  log.prepend(el);
};
const busy = (on) => document.querySelectorAll("button").forEach((b) => (b.disabled = on));
const refresh = async () => {
  try {
    const running = await (await fetch("/running")).json();
    const debug = await (await fetch("/debug")).json();
    $("#status").textContent = running
      ? "running · " + (debug.microvm?.size ?? "?") + " · " + (debug.microvm?.id ?? "")
      : "stopped";
  } catch { $("#status").textContent = "unknown"; }
};
const call = async (action, get) => {
  busy(true);
  const started = performance.now();
  $("#status").textContent = action + "…";
  try {
    const res = await fetch("/" + action, { method: get ? "GET" : "POST" });
    const text = await res.text();
    entry("/" + action + " (" + Math.round(performance.now() - started) + " ms)", text, res.ok ? 0 : res.status);
  } catch (e) { entry("/" + action, "", 1, String(e)); }
  busy(false);
  refresh();
};
const run = async () => {
  const cmd = $("#cmd").value;
  busy(true);
  const started = performance.now();
  try {
    const res = await fetch("/sh", { method: "POST", body: cmd });
    const text = await res.text();
    let out;
    try { out = JSON.parse(text); } catch { out = { stdout: "", stderr: text, exitCode: res.status }; }
    entry("$ " + cmd + "   (" + ((performance.now() - started) / 1000).toFixed(1) + " s)", out.stdout, out.exitCode, out.stderr);
  } catch (e) { entry("$ " + cmd, "", 1, String(e)); }
  busy(false);
};
document.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => call(b.dataset.action, b.hasAttribute("data-get"))));
document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => { $("#cmd").value = b.dataset.cmd; run(); }));
$("#run").addEventListener("click", run);
$("#cmd").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
refresh();
</script>
</body>
</html>`;
