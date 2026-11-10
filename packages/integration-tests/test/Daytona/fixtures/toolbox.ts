import type { ConnectedSandbox, DaytonaSandbox } from "@alchemy.run/daytona/SandboxClient";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/** Every toolbox call works the same on either handle. */
type Box = DaytonaSandbox | ConnectedSandbox;

/** Files: folders, uploads, search, replace, download, move, permissions, delete. */
export const files = Effect.fn(function* (box: Box, prefix: string) {
  const dir = `/tmp/alchemy-fs-${prefix}`;
  yield* box.fs.deleteFile({ path: dir, recursive: true }).pipe(Effect.ignore);
  yield* box.fs.createFolder({ path: dir, mode: "755" });
  yield* box.fs.uploadFile({ path: `${dir}/a.txt`, body: "hello world\n" });
  yield* box.fs.uploadFile({ path: `${dir}/b.bin`, body: new Uint8Array([0, 1, 2, 255]) });
  const listed = yield* box.fs.listFiles({ path: dir });
  const found = yield* box.fs.findInFiles({ path: dir, pattern: "hello" });
  const searched = yield* box.fs.searchFiles({ path: dir, pattern: "*.txt" });
  yield* box.fs.replaceInFiles({ files: [`${dir}/a.txt`], pattern: "world", newValue: "daytona" });
  const text = new TextDecoder().decode(yield* box.fs.downloadFile({ path: `${dir}/a.txt` }));
  const bytes = Array.from(yield* box.fs.downloadFile({ path: `${dir}/b.bin` }));
  yield* box.fs.moveFile({ source: `${dir}/a.txt`, destination: `${dir}/c.txt` });
  yield* box.fs.setFilePermissions({ path: `${dir}/c.txt`, mode: "600" });
  const moved = yield* box.fs.getFileInfo({ path: `${dir}/c.txt` });
  yield* box.fs.deleteFile({ path: dir, recursive: true });
  const gone = yield* box.exec(`test -e ${dir} && echo present || echo gone`);
  return {
    listed: listed.map((f) => f.name).sort(),
    found: found.map((m) => ({ file: m.file.split("/").pop(), line: m.line })),
    searched: searched.files.map((f) => f.split("/").pop()),
    text,
    bytes,
    moved: { name: moved.name, permissions: moved.permissions },
    gone: gone.result.trim(),
  };
});

/** Processes: a stateful session, an async command and its logs, code runs, PTYs. */
export const processes = Effect.fn(function* (box: Box, prefix: string) {
  const sessionId = `alchemy-${prefix}`;
  yield* box.process.deleteSession({ sessionId }).pipe(Effect.ignore);
  yield* box.process.createSession({ sessionId });
  yield* box.process.sessionExecuteCommand({ sessionId, command: "export GREETING=hi" });
  const echoed = yield* box.process.sessionExecuteCommand({
    sessionId,
    command: "echo $GREETING",
  });
  const started = yield* box.process.sessionExecuteCommand({
    sessionId,
    command: "sleep 1 && echo done",
    runAsync: true,
  });
  const logs = yield* box.process
    .getSessionCommandLogs({ sessionId, commandId: started.cmdId })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (l) => l.stdout.includes("done"),
        times: 15,
      }),
    );
  const listed = yield* box.process.listSessions();
  const session = yield* box.process.getSession({ sessionId });
  yield* box.process.deleteSession({ sessionId });

  const code = yield* box.process.runCode({ language: "python", code: "print(6 * 7)" });

  const ptyId = `alchemy-pty-${prefix}`;
  yield* box.process.deletePtySession({ sessionId: ptyId }).pipe(Effect.ignore);
  yield* box.process.createPtySession({ id: ptyId, cols: 80, rows: 24 });
  const ptys = yield* box.process.listPtySessions();
  yield* box.process.resizePtySession({ sessionId: ptyId, cols: 120, rows: 40 });
  const resized = yield* box.process.getPtySession({ sessionId: ptyId });
  yield* box.process.deletePtySession({ sessionId: ptyId });

  return {
    echoed: (echoed.stdout ?? "").trim(),
    asyncLogs: logs.stdout.trim(),
    listed: listed.some((s) => s.sessionId === sessionId),
    commands: session.commands?.length ?? 0,
    code: (code.result ?? "").trim(),
    pty: ptys.sessions.some((p) => p.id === ptyId),
    resized: { cols: resized.cols, rows: resized.rows },
  };
});

/** Git: init, commit, branch, history, status, and a clone. */
export const git = Effect.fn(function* (box: Box, prefix: string) {
  const path = `/tmp/alchemy-git-${prefix}`;
  yield* box.exec(`rm -rf ${path} ${path}-clone`);
  yield* box.git.initRepository({ path, initial_branch: "main" });
  // Before the first commit HEAD names nothing, so status has no branch.
  const empty = yield* box.git.getStatus({ path }).pipe(Effect.flip);
  yield* box.fs.uploadFile({ path: `${path}/README.md`, body: "# alchemy\n" });
  yield* box.git.addFiles({ path, files: ["README.md"] });
  const commit = yield* box.git.commitChanges({
    path,
    message: "first",
    author: "Alchemy",
    email: "test@alchemy.run",
  });
  const status = yield* box.git.getStatus({ path });
  yield* box.git.createBranch({ path, name: "feature" });
  yield* box.git.checkoutBranch({ path, branch: "feature" });
  const branches = yield* box.git.listBranches({ path });
  const history = yield* box.git.getCommitHistory({ path });
  yield* box.git.cloneRepository({
    url: "https://github.com/octocat/Hello-World.git",
    path: `${path}-clone`,
    depth: 1,
  });
  const cloned = yield* box.fs.listFiles({ path: `${path}-clone` });
  yield* box.exec(`rm -rf ${path} ${path}-clone`);
  return {
    empty: empty._tag,
    status: { branch: status.currentBranch, clean: status.fileStatus.length === 0 },
    hash: commit.hash.length,
    branches: [...branches.branches].sort(),
    current: branches.current,
    history: history.map((c) => c.message.trim()),
    cloned: cloned.some((f) => f.name === "README"),
  };
});

/** Language servers: open a TypeScript file, list its symbols, complete. */
export const lsp = Effect.fn(function* (box: Box, prefix: string) {
  const pathToProject = `/tmp/alchemy-lsp-${prefix}`;
  const uri = `file://${pathToProject}/index.ts`;
  yield* box.exec(`rm -rf ${pathToProject} && mkdir -p ${pathToProject}`);
  yield* box.fs.uploadFile({
    path: `${pathToProject}/index.ts`,
    body: "export function greet(name: string) {\n  return name.toUpperCase();\n}\n",
  });
  const languageId = "typescript";
  yield* box.lsp.start({ languageId, pathToProject });
  yield* box.lsp.didOpen({ languageId, pathToProject, uri });
  const symbols = yield* box.lsp.documentSymbols({ languageId, pathToProject, uri });
  const completions = yield* box.lsp.completions({
    languageId,
    pathToProject,
    uri,
    position: { line: 1, character: 14 },
  });
  yield* box.lsp.stop({ languageId, pathToProject });
  return {
    symbols: symbols.map((s) => s.name),
    completes: completions.items.some((i) => i.label === "toUpperCase"),
  };
});

/** Interpreter contexts, ports, versions, home directory and system metrics. */
export const system = Effect.fn(function* (box: Box, prefix: string) {
  const context = yield* box.interpreter.createInterpreterContext({ language: "python" });
  const contexts = yield* box.interpreter.listInterpreterContexts();
  yield* box.interpreter.deleteInterpreterContext({ id: context.id });

  const sessionId = `alchemy-http-${prefix}`;
  yield* box.process.deleteSession({ sessionId }).pipe(Effect.ignore);
  yield* box.process.createSession({ sessionId });
  yield* box.process.sessionExecuteCommand({
    sessionId,
    command: "python3 -m http.server 8123",
    runAsync: true,
  });
  const inUse = yield* box.ports.isPortInUse({ port: 8123 }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (r) => r.isInUse === true,
      times: 15,
    }),
  );
  const ports = yield* box.ports.getPorts();
  yield* box.process.deleteSession({ sessionId });

  const home = yield* box.info.getUserHomeDir();
  const version = yield* box.info.getVersion();
  const metrics = yield* box.system.getSystemMetrics();
  return {
    context: context.language,
    listed: contexts.contexts.some((c) => c.id === context.id),
    inUse: inUse.isInUse,
    ports: (ports.ports ?? []).includes(8123),
    home: home.dir,
    version: Object.keys(version).length > 0,
    cpus: metrics.cpuCount,
    memory: (metrics.memTotal ?? 0) > 0,
  };
});

/**
 * A smart-HTTP git server over `git http-backend`, run inside the sandbox.
 * The daemon's git client always sends basic auth, which `git://` refuses,
 * and its `file://` transport fails reaping git's child processes, so a
 * remote it can push to and pull from has to be HTTP.
 */
const GIT_HTTP_SERVER = String.raw`import os, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1]
PORT = int(sys.argv[2])


class Git(BaseHTTPRequestHandler):
    def handle_one(self):
        path, _, query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        env = dict(
            os.environ,
            GIT_PROJECT_ROOT=ROOT,
            GIT_HTTP_EXPORT_ALL="1",
            PATH_INFO=path,
            QUERY_STRING=query,
            REQUEST_METHOD=self.command,
            CONTENT_TYPE=self.headers.get("Content-Type") or "",
            CONTENT_LENGTH=str(len(body)),
            REMOTE_USER="alchemy",
            REMOTE_ADDR="127.0.0.1",
        )
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True).stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        status = 200
        headers = []
        for line in head.split(b"\r\n"):
            if not line:
                continue
            k, _, v = line.decode().partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            else:
                headers.append((k, v.strip()))
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = handle_one
    do_POST = handle_one

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Git).serve_forever()
`;

/** Git against a remote: config, remotes, push, clone, pull, restore, reset, branches. */
export const gitRemote = Effect.fn(function* (box: Box, prefix: string) {
  const root = `/tmp/alchemy-remote-${prefix}`;
  const path = `${root}/work`;
  const other = `${root}/other`;
  const port = 8765;
  const url = `http://127.0.0.1:${port}/origin.git`;
  const sessionId = `alchemy-git-http-${prefix}`;
  yield* box.process.deleteSession({ sessionId }).pipe(Effect.ignore);
  yield* box.exec(
    `rm -rf ${root} && mkdir -p ${root} && git init -q --bare -b main ${root}/origin.git && ` +
      `git -C ${root}/origin.git config http.receivepack true`,
  );
  yield* box.fs.uploadFile({ path: `${root}/server.py`, body: GIT_HTTP_SERVER });
  yield* box.process.createSession({ sessionId });
  yield* box.process.sessionExecuteCommand({
    sessionId,
    command: `python3 ${root}/server.py ${root} ${port}`,
    runAsync: true,
  });
  yield* box.ports.isPortInUse({ port }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (r) => r.isInUse === true,
      times: 15,
    }),
  );

  const commit = (repo: string, file: string, message: string) =>
    Effect.gen(function* () {
      yield* box.fs.uploadFile({ path: `${repo}/${file}`, body: `${message}\n` });
      yield* box.git.addFiles({ path: repo, files: [file] });
      return yield* box.git.commitChanges({
        path: repo,
        message,
        author: "Alchemy",
        email: "test@alchemy.run",
      });
    });

  yield* box.git.initRepository({ path, initial_branch: "main" });
  yield* box.git.configureUser({ path, name: "Alchemy", email: "test@alchemy.run" });
  yield* box.git.setGitConfig({ path, key: "alchemy.test", value: "yes", scope: "local" });
  const config = yield* box.git.getGitConfig({ path, key: "alchemy.test", scope: "local" });
  yield* box.git.addRemote({ path, name: "origin", url });
  const remotes = yield* box.git.listRemotes({ path });
  yield* commit(path, "one.txt", "one");
  yield* box.git.pushChanges({ path, remote: "origin", branch: "main", set_upstream: true });

  // A second clone pushes a commit; the first pulls it.
  yield* box.git.cloneRepository({ url, path: other });
  yield* box.git.configureUser({ path: other, name: "Alchemy", email: "test@alchemy.run" });
  yield* commit(other, "two.txt", "two");
  yield* box.git.pushChanges({ path: other });
  yield* box.git.pullChanges({ path, remote: "origin", branch: "main" });
  const pulled = yield* box.fs.listFiles({ path });

  // Restore an edited file, delete a branch, then reset to the first commit
  // (reset takes a commit, not a relative ref like HEAD~1).
  yield* box.fs.uploadFile({ path: `${path}/one.txt`, body: "edited\n" });
  yield* box.git.restoreFiles({ path, files: ["one.txt"], worktree: true });
  const restored = new TextDecoder().decode(
    yield* box.fs.downloadFile({ path: `${path}/one.txt` }),
  );
  // Creating a branch also checks it out, and the daemon will delete the
  // branch HEAD is on, so switch back before deleting it.
  yield* box.git.createBranch({ path, name: "scratch" });
  const created = yield* box.git.listBranches({ path });
  yield* box.git.checkoutBranch({ path, branch: "main" });
  yield* box.git.deleteBranch({ path, name: "scratch" });
  const branches = yield* box.git.listBranches({ path });
  const before = yield* box.git.getCommitHistory({ path });
  const first = before.find((c) => c.message.trim() === "one");
  yield* box.git.resetChanges({ path, mode: "hard", target: first?.hash ?? "HEAD" });
  const history = yield* box.git.getCommitHistory({ path });
  yield* box.git.authenticate({ host: "git.example.com", username: "alchemy", password: "x" });
  yield* box.process.deleteSession({ sessionId });
  yield* box.exec(`rm -rf ${root}`);
  return {
    config: config.value,
    remotes: remotes.remotes.map((r) => r.name),
    pulled: pulled
      .map((f) => f.name)
      .filter((n) => !n.startsWith("."))
      .sort(),
    restored: restored.trim(),
    createdOn: created.current,
    branches: [...branches.branches].sort(),
    history: history.map((c) => c.message.trim()),
  };
});

/** Interactive input, a single command, the entrypoint, daemon env, LSP workspace symbols. */
export const sessions = Effect.fn(function* (box: Box, prefix: string) {
  const sessionId = `alchemy-input-${prefix}`;
  yield* box.process.deleteSession({ sessionId }).pipe(Effect.ignore);
  yield* box.process.createSession({ sessionId });
  const started = yield* box.process.sessionExecuteCommand({
    sessionId,
    command: "read line && echo got:$line",
    runAsync: true,
  });
  yield* box.process.sendInput({ sessionId, commandId: started.cmdId, data: "alchemy\n" });
  const logs = yield* box.process
    .getSessionCommandLogs({ sessionId, commandId: started.cmdId })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (l) => l.stdout.includes("got:alchemy"),
        times: 15,
      }),
    );
  const command = yield* box.process.getSessionCommand({ sessionId, commandId: started.cmdId });
  yield* box.process.deleteSession({ sessionId });
  const entrypoint = yield* box.process.getEntrypointSession();
  const entrypointLogs = yield* box.process.getEntrypointLogs();

  yield* box.server.updateEnv({ set: { ALCHEMY_DAEMON_ENV: "on" } });
  const withEnv = yield* box.exec("echo ${ALCHEMY_DAEMON_ENV:-off}");
  yield* box.server.updateEnv({ unset: ["ALCHEMY_DAEMON_ENV"] });
  const withoutEnv = yield* box.exec("echo ${ALCHEMY_DAEMON_ENV:-off}");

  const pathToProject = `/tmp/alchemy-ws-${prefix}`;
  const uri = `file://${pathToProject}/index.ts`;
  yield* box.exec(`rm -rf ${pathToProject} && mkdir -p ${pathToProject}`);
  yield* box.fs.uploadFile({
    path: `${pathToProject}/index.ts`,
    body: "export const alchemyGreeting = () => 'hi';\n",
  });
  const languageId = "typescript";
  yield* box.lsp.start({ languageId, pathToProject });
  yield* box.lsp.didOpen({ languageId, pathToProject, uri });
  const symbols = yield* box.lsp
    .workspaceSymbols({ languageId, pathToProject, query: "alchemyGreeting" })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (s) => s.length > 0,
        times: 10,
      }),
    );
  yield* box.lsp.didClose({ languageId, pathToProject, uri });
  yield* box.lsp.stop({ languageId, pathToProject });
  return {
    logs: logs.stdout.trim().split("\n").pop(),
    command: command.command,
    entrypoint: entrypoint.sessionId,
    entrypointLogs: typeof entrypointLogs.output,
    env: [withEnv.result.trim(), withoutEnv.result.trim()],
    symbols: symbols.map((s) => s.name),
  };
});

/** The desktop: input, windows, screenshots, recordings, accessibility, its processes. */
export const desktop = Effect.fn(function* (box: DaytonaSandbox) {
  const cu = box.computerUse;
  // The desktop plugin loads in the background after the sandbox starts.
  yield* cu.startComputerUse().pipe(
    Effect.retry({
      while: (e) => e._tag === "ComputerUseNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 20,
    }),
  );
  const status = yield* cu.getComputerUseStatus().pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (s) => s.status === "active",
      times: 20,
    }),
  );
  const system = yield* cu.getComputerUseSystemStatus();
  const display = yield* cu.getDisplayInfo();

  // Keyboard and mouse.
  yield* cu.typeText({ text: "alchemy" });
  yield* cu.pressKey({ key: "Return" });
  yield* cu.pressHotkey({ keys: "ctrl+a" });
  yield* cu.keyDown({ key: "shift" });
  yield* cu.keyUp({ key: "shift" });
  yield* cu.moveMouse({ x: 100, y: 120 });
  const mouse = yield* cu.getMousePosition();
  const clicked = yield* cu.click({ x: 50, y: 60 });
  yield* cu.mouseDown({ x: 50, y: 60 });
  const released = yield* cu.mouseUp({ x: 70, y: 80 });
  const dragged = yield* cu.drag({ startX: 10, startY: 10, endX: 40, endY: 40 });
  const scrolled = yield* cu.scroll({ x: 100, y: 100, direction: "down", amount: 2 });

  // Screenshots: full, region, and compressed.
  const full = yield* cu.takeScreenshot({ showCursor: true });
  const region = yield* cu.takeRegionScreenshot({ x: 0, y: 0, width: 100, height: 100 });
  const jpeg = yield* cu.takeCompressedScreenshot({ format: "jpeg", quality: 50, scale: 0.5 });
  const pngRegion = yield* cu.takeCompressedRegionScreenshot({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    format: "png",
  });

  // A recording: start, stop, list, read, download, delete.
  const recording = yield* cu.startRecording({ label: "alchemy" });
  yield* Effect.sleep("2 seconds");
  const stopped = yield* cu.stopRecording({ id: recording.id });
  const recordings = yield* cu.listRecordings();
  const fetched = yield* cu.getRecording({ id: recording.id });
  const video = yield* cu.downloadRecording({ id: recording.id });
  yield* cu.deleteRecording({ id: recording.id });
  const afterDelete = yield* cu.listRecordings();

  // Accessibility: open a terminal window, find the panel's button, act on it.
  yield* box.process.createSession({ sessionId: "desktop-app" });
  yield* box.process.sessionExecuteCommand({
    sessionId: "desktop-app",
    command: "DISPLAY=:0 xfce4-terminal --title=AlchemyDesktop",
    runAsync: true,
  });
  const windows = yield* cu.getWindows().pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (w) => (w.windows ?? []).some((x) => x.title === "AlchemyDesktop"),
      times: 15,
    }),
  );
  const tree = yield* cu.getAccessibilityTree({ maxDepth: 2 });
  const found = yield* cu.findAccessibilityNodes({
    name: "Show Desktop",
    scope: "all",
    limit: 1,
  });
  const node = found.matches?.[0];
  const nodeId = node?.id ?? "";
  // A toggle button can be invoked, but not focused or given a value.
  yield* cu.invokeAccessibilityNode({ id: nodeId });
  const focus = yield* cu.focusAccessibilityNode({ id: nodeId }).pipe(
    Effect.flip,
    Effect.map((e) => e._tag),
  );
  const setValue = yield* cu.setAccessibilityNodeValue({ id: nodeId, value: "x" }).pipe(
    Effect.flip,
    Effect.map((e) => e._tag),
  );

  // The desktop's own processes.
  const xfce = yield* cu.getProcessStatus({ processName: "xfce4" });
  const logs = yield* cu.getProcessLogs({ processName: "xfce4" });
  const errors = yield* cu.getProcessErrors({ processName: "xfce4" });
  const restarted = yield* cu.restartProcess({ processName: "novnc" });
  yield* cu.stopComputerUse();
  return {
    status: status.status,
    system: system.status,
    displays: display.displays?.length ?? 0,
    mouse: { x: mouse.x, y: mouse.y },
    clicked: { x: clicked.x, y: clicked.y },
    released: { x: released.x, y: released.y },
    dragged: { x: dragged.x, y: dragged.y },
    scrolled: scrolled.success,
    screenshots: [full, region, jpeg, pngRegion].map((s) => (s.screenshot?.length ?? 0) > 1000),
    recording: {
      stopped: stopped.status,
      listed: recordings.recordings.some((r) => r.id === recording.id),
      fetched: fetched.id === recording.id,
      mp4: video.length > 1000 && new TextDecoder().decode(video.slice(4, 8)) === "ftyp",
      deleted: !afterDelete.recordings.some((r) => r.id === recording.id),
    },
    window: (windows.windows ?? []).some((w) => w.title === "AlchemyDesktop"),
    tree: tree.root !== undefined,
    node: node?.name,
    focus,
    setValue,
    process: { running: xfce.running, logs: typeof logs.logs, errors: typeof errors.errors },
    restarted: restarted.processName,
  };
});

/**
 * What streams over the toolbox's WebSockets: code interpreter runs,
 * terminals (create-and-connect, connect to an existing one), and
 * followed command and entrypoint logs. Also splits session logs into
 * stdout and stderr over HTTP.
 */
export const streams = Effect.fn(function* (box: Box, prefix: string) {
  const run = yield* box.interpreter.executeInterpreterCode({
    code: "import sys\nprint('hi')\nsys.stderr.write('err')\n1/0",
  });
  const chunks = yield* box.interpreter
    .streamInterpreterCode({
      code: "import time\nfor i in range(3):\n    print(i, flush=True)\n    time.sleep(0.5)",
    })
    .pipe(Stream.runCollect);
  const timedOut = yield* box.interpreter
    .executeInterpreterCode({ code: "import time\ntime.sleep(10)", timeout: 1 })
    .pipe(
      Effect.map(() => "completed"),
      Effect.catchTag("InterpreterTimeout", (e) => Effect.succeed(e._tag)),
    );

  const decode = (chunks: Iterable<Uint8Array>) => {
    const decoder = new TextDecoder();
    return Array.from(chunks, (c) => decoder.decode(c, { stream: true })).join("");
  };

  // Create a terminal and connect in one round trip; its env comes along.
  const created = yield* Effect.scoped(
    Effect.gen(function* () {
      const pty = yield* box.process.createPty({
        id: `alchemy-ws-pty-${prefix}`,
        envs: { ALCHEMY_PTY: "env-ok" },
      });
      yield* pty.write("echo marker-$ALCHEMY_PTY; exit 3\n");
      const output = decode(yield* Stream.runCollect(pty.output));
      return { output: output.includes("marker-env-ok"), exit: yield* pty.exit };
    }),
  );

  // Connect to a terminal created over HTTP, resize it, then leave it.
  const ptyId = `alchemy-ws-pty2-${prefix}`;
  yield* box.process.deletePtySession({ sessionId: ptyId }).pipe(Effect.ignore);
  yield* box.process.createPtySession({ id: ptyId, cols: 80, rows: 24 });
  const connected = yield* Effect.scoped(
    Effect.gen(function* () {
      const pty = yield* box.process.connectPty({ sessionId: ptyId });
      yield* pty.resize(100, 30);
      yield* pty.write("stty size; exit\n");
      const output = decode(yield* Stream.runCollect(pty.output));
      return { size: output.includes("30 100"), exit: yield* pty.exit };
    }),
  );
  const missing = yield* Effect.scoped(
    box.process.connectPty({ sessionId: "alchemy-no-such-pty" }),
  ).pipe(
    Effect.map(() => "connected"),
    Effect.catchTag(["PtyConnectionRefused", "ToolboxSocketError"], (e) => Effect.succeed(e._tag)),
  );

  // Follow a command's output while it runs.
  const sessionId = `alchemy-follow-${prefix}`;
  yield* box.process.deleteSession({ sessionId }).pipe(Effect.ignore);
  yield* box.process.createSession({ sessionId });
  const started = yield* box.process.sessionExecuteCommand({
    sessionId,
    command: "for i in 1 2 3; do echo out$i; echo err$i >&2; sleep 1; done",
    runAsync: true,
  });
  const followed = yield* box.process
    .followSessionCommandLogs({ sessionId, commandId: started.cmdId })
    .pipe(Stream.runCollect);
  const joined = (stream: "stdout" | "stderr") =>
    Array.from(followed)
      .filter((p) => p.stream === stream)
      .map((p) => p.text)
      .join("");
  const logs = yield* box.process.getSessionCommandLogs({ sessionId, commandId: started.cmdId });
  yield* box.process.deleteSession({ sessionId });

  // The entrypoint runs for the sandbox's life: follow it briefly.
  const entrypoint = yield* box.process
    .followEntrypointLogs()
    .pipe(Stream.interruptWhen(Effect.sleep("3 seconds")), Stream.runCollect);

  return {
    run: {
      stdout: run.stdout,
      stderr: run.stderr,
      error: run.error?.name,
    },
    chunks: Array.from(chunks)
      .filter((c) => c.type === "stdout")
      .map((c) => (c.type === "stdout" ? c.text : ""))
      .join(""),
    timedOut,
    created,
    connected,
    missing,
    followed: { stdout: joined("stdout"), stderr: joined("stderr") },
    logs: { stdout: logs.stdout, stderr: logs.stderr },
    entrypoint: Array.isArray(Array.from(entrypoint)),
  };
});

/** Several files up and down in one request each, with a per-path failure. */
export const bulk = Effect.fn(function* (box: Box, prefix: string) {
  const dir = `/tmp/alchemy-bulk-${prefix}`;
  yield* box.fs.deleteFile({ path: dir, recursive: true }).pipe(Effect.ignore);
  const uploaded = yield* box.fs.uploadFiles({
    files: [
      { path: `${dir}/a.txt`, content: "alpha\n" },
      { path: `${dir}/nested/b.bin`, content: new Uint8Array([0, 1, 2, 255]) },
    ],
  });
  const downloaded = yield* box.fs.downloadFiles({
    paths: [`${dir}/a.txt`, `${dir}/nested/b.bin`, `${dir}/missing.txt`],
  });
  yield* box.fs.deleteFile({ path: dir, recursive: true });
  const name = (path: string) => path.slice(dir.length + 1);
  return {
    uploaded: uploaded.files.map((f) => ({ path: name(f.path), bytes: f.bytes })),
    files: downloaded.files.map((f) => ({
      path: name(f.path),
      content: name(f.path).endsWith(".txt")
        ? new TextDecoder().decode(f.content)
        : Array.from(f.content),
    })),
    errors: downloaded.errors.map((e) => ({
      path: name(e.path),
      code: e.code,
      statusCode: e.statusCode,
    })),
  };
});

/**
 * The shared handle vocabulary: exec (shell and argv forms), start (a
 * process with stdin, output and exit), files and pty.open. Ports are
 * covered by the getTcpPort tests.
 */
export const vocabulary = Effect.fn(function* (box: Box, prefix: string) {
  // Each part is bounded and named, so a hang reports where it is.
  const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "45 seconds",
        orElse: () => Effect.die(`vocabulary step "${name}" timed out`),
      }),
    );
  const shell = yield* box.exec("echo $GREETING from $(pwd)", {
    cwd: "/tmp",
    env: { GREETING: "hi" },
  });
  const argv = yield* box.exec(["printf", "%s|", "two words", "it's", "$HOME"]);
  const failed = yield* box.exec("exit 7");

  const decode = (chunks: Iterable<Uint8Array>) => {
    const decoder = new TextDecoder();
    return Array.from(chunks, (c) => decoder.decode(c, { stream: true })).join("");
  };

  // A started process: stdin, streamed output, and its exit code.
  const started = yield* step(
    "start",
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* box.start(
          ["sh", "-c", "read line; echo got:$line; echo oops >&2; exit 3"],
          {
            env: { UNUSED: "x" },
          },
        );
        yield* proc.write("alchemy\n");
        const output = Array.from(yield* Stream.runCollect(proc.output));
        const join = (fd: "stdout" | "stderr") =>
          decode(output.filter((p) => p.fd === fd).map((p) => p.data));
        return { stdout: join("stdout"), stderr: join("stderr"), exit: yield* proc.wait };
      }),
    ),
  );

  // Files.
  const dir = `/tmp/alchemy-files-${prefix}`;
  yield* box.files.remove(dir).pipe(Effect.ignore);
  yield* box.files.makeDir(dir);
  yield* box.files.write(`${dir}/a.txt`, "alpha");
  yield* box.files.write(`${dir}/b.bin`, new Uint8Array([0, 255]));
  const text = yield* box.files.readText(`${dir}/a.txt`);
  const bytes = Array.from(yield* box.files.read(`${dir}/b.bin`));
  const listed = (yield* box.files.list(dir)).map((f) => f.name).sort();
  const stat = yield* box.files.stat(`${dir}/a.txt`);
  yield* box.files.remove(dir);
  const gone = yield* box.files.stat(dir).pipe(
    Effect.map(() => "present"),
    Effect.catch(() => Effect.succeed("gone")),
  );

  // A terminal.
  const pty = yield* step(
    "pty",
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* box.pty.open({ cols: 100, rows: 30, env: { PTY_VAR: "pty-ok" } });
        yield* connection.resize({ cols: 120, rows: 40 });
        yield* connection.write("echo marker-$PTY_VAR; exit 2\n");
        const output = decode(yield* Stream.runCollect(connection.output));
        return { output: output.includes("marker-pty-ok"), exit: yield* connection.exit };
      }),
    ),
  );

  return {
    shell: { exitCode: shell.exitCode, result: shell.result.trim() },
    argv: argv.result,
    failed: failed.exitCode,
    started,
    files: { text, bytes, listed, isDir: stat.isDir, gone },
    pty,
  };
});

/** Port the echo server listens on in the dev box. */
export const ECHO_PORT = 8091;

/**
 * An HTTP server that answers every request with what it received (method,
 * path, query, the `X-Echo` header and the body) as JSON, with status 201
 * and an `X-Sandbox: echo` header, so a test can check both directions.
 */
const ECHO_SERVER = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

class Echo(BaseHTTPRequestHandler):
    def handle_any(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        out = json.dumps({
            "method": self.command,
            "path": url.path,
            "query": url.query,
            "header": self.headers.get("X-Echo"),
            "body": body,
        }).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Sandbox", "echo")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any

ThreadingHTTPServer(("0.0.0.0", ${ECHO_PORT}), Echo).serve_forever()
`;

/**
 * Start the echo server in the box unless it already runs, and wait until
 * its port listens. It keeps running in its own session between requests.
 */
export const ensureEchoServer = Effect.fn(function* (box: Box) {
  const listening = (yield* box.ports.isPortInUse({ port: ECHO_PORT })).isInUse === true;
  if (!listening) {
    yield* box.files.write("/tmp/alchemy-echo.py", ECHO_SERVER);
    yield* box.process.createSession({ sessionId: "alchemy-echo" }).pipe(Effect.ignore);
    yield* box.process.sessionExecuteCommand({
      sessionId: "alchemy-echo",
      command: "python3 /tmp/alchemy-echo.py",
      runAsync: true,
    });
    yield* box.ports.isPortInUse({ port: ECHO_PORT }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (r) => r.isInUse === true,
        times: 15,
      }),
    );
  }
  return yield* box.getTcpPort(ECHO_PORT);
});

/**
 * getTcpPort's client form: send a POST with a query, a header and a body
 * to the echo server, and return what it saw and what came back.
 */
export const portClient = Effect.fn(function* (box: Box) {
  const port = yield* ensureEchoServer(box);
  const response = yield* port
    .fetch(
      HttpClientRequest.post("/client/path?a=1&b=two").pipe(
        HttpClientRequest.setHeader("X-Echo", "client"),
        HttpClientRequest.bodyText("hello from the client"),
      ),
    )
    .pipe(
      // The preview proxy can take a moment to route a fresh port.
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (r) => r.status === 201,
        times: 10,
      }),
    );
  return {
    status: response.status,
    header: response.headers["x-sandbox"],
    received: yield* response.json,
    port: {
      port: port.port,
      url: port.url.startsWith("https://"),
      token: Redacted.value(port.token).length > 0,
    },
  };
});
