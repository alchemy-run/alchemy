import { DevServer, DevServerProvider } from "@/Build/DevServer.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({
  // DevServer is provider-agnostic — register it directly without dragging
  // in a cloud provider's auth chain.
  providers: DevServerProvider(),
  dev: true,
});

const fixtureDir = pathe.resolve(import.meta.dirname, "fixture");
const fixtureScript = pathe.join(fixtureDir, "long-running.cjs");
const urlServerScript = pathe.join(fixtureDir, "url-server.cjs");

// The provider runs `command.split(" ")` and uses `shell: false`, so the
// fixture path must not contain spaces. The in-repo path doesn't, but a CI
// clone under e.g. `C:\Program Files\...` would. Fail loudly with a clear
// message instead of letting the test hang on a misparsed argv.
if (fixtureScript.includes(" ") || urlServerScript.includes(" ")) {
  throw new Error(
    `DevServer test fixture path contains a space, which the provider's ` +
      `argv split cannot represent: ${fixtureScript} / ${urlServerScript}`,
  );
}

const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const readPidFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path);
    return JSON.parse(content) as { pid: number; marker: string };
  });

const waitForPidFile = (path: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    if (!exists) {
      return yield* Effect.fail(new Error("pid file not yet present"));
    }
    const parsed = yield* readPidFile(path);
    if (parsed.marker !== marker) {
      return yield* Effect.fail(
        new Error(`pid file marker ${parsed.marker} !== ${marker}`),
      );
    }
    return parsed;
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 100,
    }),
  );

const waitForDeath = (pid: number) =>
  isAlive(pid).pipe(
    Effect.flatMap((alive) =>
      alive
        ? Effect.fail(new Error(`pid ${pid} still alive`))
        : Effect.succeed(undefined),
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 50,
    }),
  );

test.provider(
  "starts the process",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "start" },
        }),
      );

      const { pid } = yield* waitForPidFile(pidFile, "start");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "keeps the process running across an unchanged update",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const program = DevServer("Dev", {
        command: `node ${fixtureScript}`,
        env: { PID_FILE: pidFile, MARKER: "stable" },
      });

      yield* stack.deploy(program);
      const first = yield* waitForPidFile(pidFile, "stable");

      // Re-deploy the same props. Provider hashes match → keep running.
      yield* stack.deploy(program);
      // Give the provider a moment in case it would (incorrectly) respawn.
      yield* Effect.sleep("500 millis");

      const second = yield* readPidFile(pidFile);
      expect(second.pid).toBe(first.pid);
      expect(second.marker).toBe("stable");
      expect(yield* isAlive(first.pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(first.pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "restarts the process when props change",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "v1" },
        }),
      );
      const first = yield* waitForPidFile(pidFile, "v1");
      expect(yield* isAlive(first.pid)).toBe(true);

      // Change the env (and therefore the hash) — provider should kill the
      // running process and spawn a fresh one with the new marker.
      yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "v2" },
        }),
      );
      const second = yield* waitForPidFile(pidFile, "v2");

      expect(second.pid).not.toBe(first.pid);
      expect(yield* isAlive(second.pid)).toBe(true);
      yield* waitForDeath(first.pid);

      yield* stack.destroy();
      yield* waitForDeath(second.pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "extracts the first URL printed to stdout",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-stdout",
            URL_LINE: "Local: http://localhost:5173/",
          },
        }),
      );

      expect(output.url).toBe("http://localhost:5173/");

      const { pid } = yield* waitForPidFile(pidFile, "url-stdout");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "extracts a URL printed to stderr",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-stderr",
            URL_LINE: "ready - started server on http://127.0.0.1:3000",
            URL_STREAM: "stderr",
          },
        }),
      );

      expect(output.url).toBe("http://127.0.0.1:3000");

      const { pid } = yield* waitForPidFile(pidFile, "url-stderr");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "strips ANSI escapes before matching",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      // Vite-style colored output: "  ➜  Local:   http://localhost:5173/"
      // with green + cyan SGR sequences around the URL.
      const ansi = (open: string, body: string) =>
        `\x1b[${open}m${body}\x1b[0m`;
      const line = `  ➜  ${ansi("32", "Local:")}   ${ansi("36", "http://localhost:5173/")}`;

      const output = yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "url-ansi",
            URL_LINE: line,
          },
        }),
      );

      expect(output.url).toBe("http://localhost:5173/");

      const { pid } = yield* waitForPidFile(pidFile, "url-ansi");
      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "returns undefined when no URL is printed within the timeout",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      const output = yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${urlServerScript}`,
          env: {
            PID_FILE: pidFile,
            MARKER: "no-url",
            // URL_LINE intentionally unset — process stays silent so
            // reconcile waits the full URL_EXTRACT_TIMEOUT and falls back.
          },
        }),
      );

      expect(output.url).toBeUndefined();

      const { pid } = yield* waitForPidFile(pidFile, "no-url");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
    }),
  { timeout: 30_000 },
);

test.provider(
  "stops the process on destroy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "devcmd-" });
      const pidFile = pathe.join(tmp, "pid.json");

      yield* stack.deploy(
        DevServer("Dev", {
          command: `node ${fixtureScript}`,
          env: { PID_FILE: pidFile, MARKER: "stop" },
        }),
      );
      const { pid } = yield* waitForPidFile(pidFile, "stop");
      expect(yield* isAlive(pid)).toBe(true);

      yield* stack.destroy();
      yield* waitForDeath(pid);
      expect(yield* isAlive(pid)).toBe(false);
    }),
  { timeout: 30_000 },
);
