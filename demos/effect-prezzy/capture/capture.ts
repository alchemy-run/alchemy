/**
 * Runs every scene in `deck.ts` for real, in order, against one project
 * folder (`work/shorty`), and writes what the video needs to `out/capture/`:
 *
 *   out/capture/<scene>/scene.json      beats (see shared/types.ts)
 *   out/capture/<scene>/terminal.mp4    the terminal, rendered by tcut
 *   out/capture/<scene>/browser-<n>.png real page captures
 *
 * The project starts empty and each scene brings it to the matching
 * `chapters/<chapter>` folder: files typed on screen are written as they
 * are typed, the rest are synced silently. The terminal is one tmux
 * session for the whole talk: `alchemy dev` runs in the top pane from
 * chapter 1 on, commands and tests run in the bottom pane.
 *
 *   pnpm capture                 # all scenes, then tear everything down
 *   pnpm capture --keep          # leave dev/live deployments up
 *   pnpm capture --only 03-tests # re-capture one scene (needs the previous ones' project state)
 *
 * Needs Bun >= 1.4.1 (tcut); the package script runs it with `bunx bun@1.4.2`.
 * Deploys use the `ALCHEMY_PROFILE` profile (default `testing`).
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildTimeline, defineVideo, type TerminalSession } from "tcut";
import { deck } from "../deck.ts";
import {
  BROWSER_VIEWPORT,
  TERMINAL,
  VIDEO,
  type Beat,
  type Desk,
  type Graph,
  type SceneCapture,
} from "../shared/types.ts";
import { readGraph } from "./graph.ts";
import type { Pane, SceneContext, SceneDefinition, Term } from "./scene.ts";

const { values: args } = parseArgs({
  options: {
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});

const root = path.resolve(import.meta.dir, "..");
const project = "shorty";
const dir = path.join(root, "work", project);
const chaptersDir = path.join(root, "chapters");
const captureRoot = path.join(root, "out", "capture");
const bin = path.join(root, "node_modules", ".bin");
const profile = process.env.ALCHEMY_PROFILE ?? "testing";
const tmuxConf = path.join(root, "capture", "tmux.conf");
const zdot = path.join(root, "work", ".zdot");
const SOCKET = "shorty-demo";
const SESSION = "shorty";
const PANES: Record<Pane, string> = { dev: `${SESSION}:0.0`, shell: `${SESSION}:0.1` };

/** Beat markers written into the tcut recording around terminal beats. */
const BEAT = "prezzy-beat:";

/** Never copied into the project or shown in the explorer. */
const IGNORED = new Set(["node_modules", ".alchemy", "dist", ".DS_Store", "tsconfig.tsbuildinfo"]);

const listFiles = async (base: string, rel = ""): Promise<string[]> => {
  const entries = await readdir(path.join(base, rel), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(base, child)));
    else files.push(child);
  }
  return files.sort();
};

const readText = (file: string) => readFile(file, "utf8").catch(() => "");
const exists = (file: string) => stat(file).then(() => true, () => false);

const sh = async (cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  const code = await proc.exited;
  if (code !== 0 && !opts.quiet) throw new Error(`${cmd.join(" ")} failed (${code}): ${err || out}`);
  return out;
};
const tmux = (...rest: string[]) => sh(["tmux", "-L", SOCKET, ...rest], { quiet: true });

const paneText = async (pane: Pane) =>
  tmux("capture-pane", "-p", "-J", "-S", "-", "-t", PANES[pane]);

const waitFor = async (pane: Pane, pattern: RegExp, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await paneText(pane);
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pattern} in the ${pane} pane:\n${text.slice(-3000)}`);
    }
    await Bun.sleep(300);
  }
};

/** A fresh tmux session with a clean zsh in each pane, sized for the terminal clip. */
const startTmux = async (cols: number, rows: number) => {
  await mkdir(zdot, { recursive: true });
  await writeFile(
    path.join(zdot, ".zshrc"),
    [
      `PROMPT='%F{green}~/${project}%f %F{8}❯%f '`,
      "PROMPT_EOL_MARK=''",
      `export PATH="${bin}:$PATH" ALCHEMY_PROFILE=${profile} FORCE_HYPERLINK=1`,
      "unset CI CURSOR_AGENT CLAUDECODE CLAUDE_CODE NO_COLOR FORCE_COLOR",
      "",
    ].join("\n"),
  );
  await tmux("kill-server");
  const shell = `ZDOTDIR=${zdot} zsh -i`;
  await sh(["tmux", "-f", tmuxConf, "-L", SOCKET, "new-session", "-d", "-s", SESSION,
    "-x", String(cols), "-y", String(rows), "-c", dir, shell]);
  await tmux("split-window", "-v", "-l", "55%", "-t", `${SESSION}:0`, "-c", dir, shell);
  await Bun.sleep(800);
};

/** Poll until `alchemy dev` is ready and its output has been still for a moment. */
const waitDev = async (timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  let last = "";
  let stableSince = Date.now();
  for (;;) {
    const text = await paneText("dev");
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    }
    const ready = /Dev stack ready \((\d+)\/\1\)/.test(text.trimEnd().split("\n").slice(-3).join("\n"));
    if (ready && Date.now() - stableSince > 2500) return;
    if (Date.now() > deadline) throw new Error(`alchemy dev did not settle:\n${text.slice(-3000)}`);
    await Bun.sleep(300);
  }
};

/** Poll until `url` serves a page (fresh workers.dev hosts answer 404 for a few seconds). */
const waitForPage = async (url: string) => {
  for (let attempt = 0; attempt < 90; attempt++) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`${url} did not serve a page after 90s`);
};

/** Load `url` in a headless WebKit view sized like the video's browser viewport and screenshot it. */
const capturePage = async (url: string, waitFor?: RegExp) => {
  await waitForPage(url);
  const view = new Bun.WebView({ ...BROWSER_VIEWPORT, backend: "webkit" });
  try {
    await view.navigate(url);
    let text = "";
    for (let attempt = 0; attempt < 120; attempt++) {
      text = String(await view.evaluate("document.body ? document.body.innerText : ''"));
      if (waitFor ? waitFor.test(text) : text.length > 0) break;
      await Bun.sleep(250);
    }
    if (waitFor && !waitFor.test(text)) {
      throw new Error(`${url} never showed ${waitFor}; page text: ${text.slice(0, 500)}`);
    }
    await Bun.sleep(600);
    const title = String(await view.evaluate("document.title"));
    const png = (await view.screenshot({ encoding: "buffer" })) as Uint8Array;
    return { title, png };
  } finally {
    view.close();
  }
};

/** Window contents carried from scene to scene. */
let desk: Desk = { files: [], tabs: [], active: undefined };
const state: Record<string, string> = {};

const captureScene = async (id: string, scene: SceneDefinition) => {
  const out = path.join(captureRoot, id);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const chapter = path.join(chaptersDir, scene.chapter);

  const beats: Beat[] = [];
  const start: Desk = structuredClone({ ...desk, files: await listFiles(dir) });
  const tabs = new Map(desk.tabs.map((tab) => [tab.file, tab.content]));
  let active = desk.active;
  let browser = desk.browser;
  let diagram = desk.diagram;
  let terminalBeats = 0;
  let shots = 0;

  const openTab = (file: string, content: string) => {
    tabs.set(file, content);
    active = file;
  };

  const writeProjectFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  };

  const video = defineVideo(
    {
      output: [path.join(out, "terminal.mp4")],
      cast: path.join(out, "terminal.cast"),
      cache: false,
      shell: "zsh",
      cwd: dir,
      width: TERMINAL.width,
      height: TERMINAL.height,
      scale: 1,
      fps: VIDEO.fps,
      margin: 0,
      padding: 20,
      windowBar: "none",
      borderRadius: 0,
      theme: "dark-modern",
      font: { family: "JetBrains Mono", size: 16, lineHeight: 1.4 },
      cursor: { blink: false },
      typingSpeed: "40ms",
      typingJitter: 0.4,
      maxPause: "1.5s",
      waitTimeout: "300s",
      endPause: "0ms",
    },
    async (t: TerminalSession) => {
      await t.hide(async () => {
        await t.run("clear");
        await t.type(`tmux -L ${SOCKET} attach -t ${SESSION}`);
        await t.enter();
        await t.sleep("1500ms");
      });

      const term: Term = {
        async type(pane, command) {
          await tmux("select-pane", "-t", PANES[pane]);
          await t.sleep("300ms");
          await t.type(command);
          await t.sleep("250ms");
          await t.enter();
        },
        async key(pane, key) {
          await tmux("send-keys", "-t", PANES[pane], key);
        },
        async run(command, opts) {
          const prompts = (text: string) => text.split("\n").filter((line) => /❯/.test(line)).length;
          const before = prompts(await paneText("shell"));
          await term.type("shell", command);
          const deadline = Date.now() + (opts?.timeout ?? 120_000);
          for (;;) {
            const text = await paneText("shell");
            const lines = text.trimEnd().split("\n");
            // Finished once a fresh, empty prompt follows the command.
            const finished = opts?.until
              ? opts.until.test(text)
              : prompts(text) > before && /❯\s*$/.test(lines.at(-1) ?? "");
            if (finished) break;
            if (Date.now() > deadline) throw new Error(`\`${command}\` did not finish:\n${text.slice(-3000)}`);
            await Bun.sleep(300);
          }
          await t.sleep("1200ms");
          return paneText("shell");
        },
        waitDev: (opts) => waitDev(opts?.timeout),
        waitFor: (pane, pattern, opts) => waitFor(pane, pattern, opts?.timeout),
        text: paneText,
        sleep: (ms) => t.sleep(`${ms}ms`),
      };

      const context: SceneContext = {
        dir,
        state,
        async sync(opts) {
          const keep = new Set(opts?.except ?? []);
          const want = await listFiles(chapter);
          for (const file of await listFiles(dir)) {
            if (!want.includes(file) && !keep.has(file)) await rm(path.join(dir, file));
          }
          for (const file of want) {
            if (keep.has(file)) continue;
            await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
            await cp(path.join(chapter, file), path.join(dir, file));
            if (tabs.has(file)) tabs.set(file, await readText(path.join(dir, file)));
          }
        },
        editor: {
          async open(file) {
            const content = await readText(path.join(dir, file));
            openTab(file, content);
            beats.push({ kind: "editor.open", file, content });
          },
          async show(file) {
            const before = await readText(path.join(dir, file));
            const after = await readText(path.join(chapter, file));
            if (!(await exists(path.join(chapter, file)))) throw new Error(`${scene.chapter} has no ${file}`);
            if (before === after) throw new Error(`${file} is unchanged in ${scene.chapter}`);
            await writeProjectFile(file, after);
            openTab(file, after);
            beats.push({ kind: "editor.edit", file, before, after });
          },
          async remove(file) {
            await rm(path.join(dir, file), { force: true });
            tabs.delete(file);
            if (active === file) active = [...tabs.keys()].pop();
            beats.push({ kind: "editor.delete", file });
          },
        },
        async terminal(fn) {
          const index = terminalBeats++;
          beats.push({ kind: "terminal", start: 0, end: 0 });
          await t.marker(`${BEAT}start:${index}`);
          try {
            return await fn(term);
          } finally {
            await t.marker(`${BEAT}end:${index}`);
          }
        },
        async diagram(opts) {
          const stateDir = path.join(dir, ".alchemy", "state", "Shorty");
          const deadline = Date.now() + 120_000;
          let graph: Graph;
          for (;;) {
            graph = await readGraph(stateDir, opts.stage);
            const ids = new Set(graph.nodes.map((n) => n.id));
            const edges = new Set(graph.edges.map((e) => e.id));
            const missing = [
              ...(opts.nodes ?? []).filter((n) => !ids.has(n)),
              ...(opts.edges ?? []).filter((e) => !edges.has(e)),
            ];
            if (missing.length === 0) break;
            if (Date.now() > deadline) throw new Error(`diagram never showed ${missing.join(", ")}`);
            await Bun.sleep(500);
          }
          const previous = diagram;
          const oldNodes = new Set(previous?.nodes.map((n) => n.id) ?? []);
          const oldEdges = new Set(previous?.edges.map((e) => e.id) ?? []);
          beats.push({
            kind: "diagram",
            graph,
            addedNodes: graph.nodes.filter((n) => !oldNodes.has(n.id)).map((n) => n.id),
            addedEdges: graph.edges.filter((e) => !oldEdges.has(e.id)).map((e) => e.id),
          });
          diagram = graph;
        },
        browser: {
          async open(url, opts) {
            const { title, png } = await capturePage(url, opts?.waitFor);
            const screenshot = `${id}/browser-${++shots}.png`;
            await Bun.write(path.join(captureRoot, screenshot), png);
            browser = { url, title, screenshot };
            beats.push({ kind: "browser", url, title, screenshot });
          },
          async update(opts) {
            if (!browser) throw new Error("browser.update before browser.open");
            const { title, png } = await capturePage(browser.url, opts.waitFor);
            const screenshot = `${id}/browser-${++shots}.png`;
            await Bun.write(path.join(captureRoot, screenshot), png);
            browser = { ...browser, title, screenshot };
            beats.push({ kind: "browser.update", title, screenshot });
          },
        },
        focus(app) {
          beats.push({ kind: "focus", app });
        },
        pause(seconds) {
          beats.push({ kind: "pause", seconds });
        },
      };

      await scene.run(context);

      await t.hide(async () => {
        await tmux("detach-client", "-s", SESSION);
        await t.sleep("500ms");
      });
    },
  );

  // tmux resizes the window to the recording's terminal when it attaches.
  if (!(await hasSession())) await startTmux(150, 40);

  console.log(`● ${id}: recording`);
  const recording = await video.record({ force: true, log: (m) => console.log(`  ${m}`) });

  const capture: SceneCapture = {
    id,
    title: scene.title,
    notes: scene.notes ?? "",
    project,
    start,
    end: {
      files: await listFiles(dir),
      tabs: [...tabs].map(([file, content]) => ({ file, content })),
      active,
      browser,
      diagram,
    },
    terminal: undefined,
    beats,
  };

  if (terminalBeats > 0) {
    const timeline = buildTimeline(recording.events, video.config.playbackSpeed, {
      maxPause: video.config.maxPause,
    });
    const at = new Map<string, number>();
    for (const e of timeline.events) {
      if (e.type === "m" && e.data.startsWith(BEAT)) at.set(e.data.slice(BEAT.length), e.vt);
    }
    let index = 0;
    for (const beat of beats) {
      if (beat.kind !== "terminal") continue;
      beat.start = at.get(`start:${index}`) ?? 0;
      beat.end = at.get(`end:${index}`) ?? beat.start;
      index++;
    }
    console.log(`● ${id}: rendering the terminal`);
    const result = await video.render(recording);
    capture.terminal = { clip: `${id}/terminal.mp4`, duration: result.durationSeconds };
  }

  desk = capture.end;
  await writeFile(path.join(out, "scene.json"), `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`✔ ${id}: ${beats.length} beats`);
};

const hasSession = async () =>
  (await Bun.spawn(["tmux", "-L", SOCKET, "has-session", "-t", SESSION], { stdout: "ignore", stderr: "ignore" }).exited) === 0;

const teardown = async () => {
  await tmux("kill-server");
  if (args.keep) return;
  // Give `alchemy dev` a moment to exit, then remove what the talk created.
  await Bun.sleep(2_000);
  for (const stage of [`dev_${process.env.USER}`, undefined]) {
    console.log(`● destroying ${stage ?? "the live"} stage`);
    const cmd = ["alchemy", "destroy", "--yes", "--profile", profile, ...(stage ? ["--stage", stage] : [])];
    const proc = Bun.spawn(cmd, {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: "" },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) console.error(`✘ ${cmd.join(" ")} failed; run it by hand in work/${project}`);
  }
};

const scenes = deck.filter((item) => item.kind === "scene");
const selected = args.only ? scenes.filter((item) => item.id === args.only) : scenes;
if (selected.length === 0) throw new Error(`no scene ${args.only}`);

if (!args.only) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
} else {
  // Resume from the desk the previous scene left behind.
  const index = scenes.findIndex((item) => item.id === args.only);
  const previous = scenes[index - 1];
  if (previous) {
    const prev = JSON.parse(await readText(path.join(captureRoot, previous.id, "scene.json"))) as SceneCapture;
    desk = prev.end;
  }
}

try {
  for (const item of selected) {
    const scene = (await import(path.join(root, "scenes", `${item.id}.ts`))).default as SceneDefinition;
    await captureScene(item.id, scene);
  }
} finally {
  if (!args.only) await teardown();
  else await tmux("detach-client", "-s", SESSION);
}
