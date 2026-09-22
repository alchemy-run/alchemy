/**
 * Runs every scene in `deck.ts` for real, in order, against one project
 * folder, and writes what the video needs to `out/capture/`:
 *
 *   out/capture/<scene>/scene.json      beats (see shared/types.ts)
 *   out/capture/<scene>/terminal.mp4    terminal-only render of the shell session (tcut)
 *   out/capture/<scene>/browser-<n>.png real page captures
 *
 * The project starts as a copy of `template/` in `work/my-app/` and keeps
 * every change the scenes make. Unless `--keep` is passed, the stack is
 * destroyed at the end.
 *
 *   pnpm capture            # all scenes, then alchemy destroy
 *   pnpm capture --keep     # leave the deployment up
 *
 * Needs Bun >= 1.4.1 (tcut); the package script runs it with `bunx bun@1.4.2`.
 * Deploys use the `ALCHEMY_PROFILE` profile (default `testing`).
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildTimeline, defineVideo, type TerminalSession } from "tcut";
import { deck } from "../deck.ts";
import {
  BROWSER_VIEWPORT,
  TERMINAL,
  VIDEO,
  type AppId,
  type Beat,
  type SceneCapture,
} from "../shared/types.ts";
import type { SceneContext, SceneDefinition } from "./scene.ts";

const { values: args } = parseArgs({
  options: { keep: { type: "boolean", default: false } },
});

const root = path.resolve(import.meta.dir, "..");
const project = "my-app";
const dir = path.join(root, "work", project);
const captureRoot = path.join(root, "out", "capture");
const bin = path.join(root, "node_modules", ".bin");
const profile = process.env.ALCHEMY_PROFILE ?? "testing";

/** Beat markers written into the tcut recording around terminal beats. */
const BEAT = "prezzy-beat:";

/** Files the explorer shows; build output and dependencies are left out. */
const IGNORED = new Set(["node_modules", ".alchemy", "dist", ".DS_Store"]);
const listFiles = async (base: string, rel = ""): Promise<string[]> => {
  const entries = await readdir(path.join(base, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(base, child)));
    else files.push(child);
  }
  return files.sort();
};

const readProjectFile = (file: string) =>
  readFile(path.join(dir, file), "utf8").catch(() => "");

/**
 * Shell setup shared by the recorded session and the off-camera teardown:
 * the workspace `alchemy` bin on PATH, the deploy profile, and the CLI's
 * interactive output even when launched from CI or a coding agent.
 */
const shellEnv = [
  `export PATH="${bin}:$PATH" ALCHEMY_PROFILE=${profile} ALCHEMY_TUI=1 FORCE_HYPERLINK=1`,
  "unset CI CURSOR_AGENT CLAUDECODE CLAUDE_CODE NO_COLOR FORCE_COLOR",
];

/** Poll `url` until it serves a page (fresh workers.dev hosts answer 404/1042 for a few seconds). */
const waitForPage = async (url: string) => {
  for (let attempt = 0; attempt < 90; attempt++) {
    const body = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then(async (r) => (r.ok ? await r.text() : undefined))
      .catch(() => undefined);
    if (body !== undefined && !body.includes("error code:")) return;
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
    for (let attempt = 0; attempt < 60; attempt++) {
      text = String(await view.evaluate("document.body ? document.body.innerText : ''"));
      if (waitFor ? waitFor.test(text) : text.length > 0) break;
      await Bun.sleep(250);
    }
    if (waitFor && !waitFor.test(text)) {
      throw new Error(`${url} never showed ${waitFor}; page text: ${text.slice(0, 500)}`);
    }
    // Let web fonts and transitions settle before the capture.
    await Bun.sleep(800);
    const title = String(await view.evaluate("document.title"));
    const png = (await view.screenshot({ encoding: "buffer" })) as Uint8Array;
    return { title, png };
  } finally {
    view.close();
  }
};

/** Carried from scene to scene. */
const carried = {
  state: {} as Record<string, string>,
  tabs: [] as string[],
  active: undefined as string | undefined,
  browser: undefined as SceneCapture["browser"],
};

const captureScene = async (id: string, scene: SceneDefinition) => {
  const out = path.join(captureRoot, id);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const capture: SceneCapture = {
    id,
    title: scene.title,
    notes: scene.notes ?? "",
    project,
    files: await listFiles(dir),
    editor: {
      tabs: await Promise.all(
        carried.tabs.map(async (file) => ({ file, content: await readProjectFile(file) })),
      ),
      active: carried.active,
    },
    terminal: undefined,
    browser: carried.browser,
    beats: [],
  };
  const beats: Beat[] = capture.beats;
  let terminalBeats = 0;
  let browserShots = 0;

  const openTab = (file: string) => {
    if (!carried.tabs.includes(file)) carried.tabs.push(file);
    carried.active = file;
  };

  const video = defineVideo(
    {
      output: [path.join(out, "terminal.mp4")],
      cast: path.join(out, "terminal.cast"),
      cache: false,
      shell: "zsh",
      prompt: `~/${project} ❯ `,
      cwd: dir,
      width: TERMINAL.width,
      height: TERMINAL.height,
      // WebKit already renders at the display's pixel density (2× on Retina).
      scale: 1,
      fps: VIDEO.fps,
      margin: 0,
      padding: 24,
      windowBar: "none",
      borderRadius: 0,
      theme: "dark-modern",
      font: { family: "JetBrains Mono", size: 19, lineHeight: 1.45 },
      cursor: { blink: false },
      typingSpeed: "45ms",
      typingJitter: 0.4,
      maxPause: "1.2s",
      waitTimeout: "60s",
      endPause: "0ms",
    },
    async (t: TerminalSession) => {
      await t.hide(async () => {
        for (const line of shellEnv) await t.run(line);
        await t.run("clear");
      });

      const context: SceneContext = {
        dir,
        state: carried.state,
        read: readProjectFile,
        editor: {
          async open(file) {
            openTab(file);
            beats.push({ kind: "editor.open", file, content: await readProjectFile(file) });
          },
          async edit(file, next) {
            const before = await readProjectFile(file);
            const after = typeof next === "string" ? next : next(before);
            if (after === before) throw new Error(`editor.edit(${file}) changed nothing`);
            await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
            await writeFile(path.join(dir, file), after);
            openTab(file);
            beats.push({ kind: "editor.edit", file, before, after });
          },
        },
        async terminal(fn) {
          const index = terminalBeats++;
          const beat: Beat = { kind: "terminal", start: 0, end: 0 };
          beats.push(beat);
          await t.marker(`${BEAT}start:${index}`);
          try {
            return await fn(t);
          } finally {
            await t.marker(`${BEAT}end:${index}`);
          }
        },
        browser: {
          async open(url, opts) {
            const { title, png } = await capturePage(url, opts?.waitFor);
            const screenshot = `${id}/browser-${++browserShots}.png`;
            await Bun.write(path.join(captureRoot, screenshot), png);
            carried.browser = { url, title, screenshot };
            beats.push({ kind: "browser", url, title, screenshot });
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
    },
  );

  console.log(`● ${id}: recording`);
  const recording = await video.record({ force: true, log: (m) => console.log(`  ${m}`) });

  if (terminalBeats > 0) {
    // Marker positions on the rendered clip's timeline (after hide/maxPause).
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

  await writeFile(path.join(out, "scene.json"), `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`✔ ${id}: ${beats.length} beats`);
};

await rm(dir, { recursive: true, force: true });
await mkdir(path.dirname(dir), { recursive: true });
await cp(path.join(root, "template"), dir, { recursive: true });

try {
  for (const item of deck) {
    if (item.kind !== "scene") continue;
    const scene = (await import(path.join(root, "scenes", `${item.id}.ts`))).default as SceneDefinition;
    await captureScene(item.id, scene);
  }
} finally {
  if (!args.keep) {
    console.log("● destroying the demo stack (pass --keep to leave it deployed)");
    const destroy = Bun.spawn(
      ["zsh", "-c", `${shellEnv.join("; ")}; alchemy destroy --yes`],
      { cwd: dir, stdout: "inherit", stderr: "inherit" },
    );
    if ((await destroy.exited) !== 0) console.error("✘ alchemy destroy failed; run it by hand in work/my-app");
  }
}
