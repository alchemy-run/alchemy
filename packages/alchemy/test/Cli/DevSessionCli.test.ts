import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  assertDead,
  lifecycleFixture,
} from "../Command/fixture/lifecycle-support.ts";

const execPid = (supervisor: number) =>
  ChildProcess.make("ps", ["-Ao", "pid=,ppid=,args="]).pipe(
    Effect.flatMap((child) =>
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
    ),
    Effect.map((table) => {
      for (const line of table.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (
          match &&
          Number(match[2]) === supervisor &&
          match[3]!.includes("/bin/exec.js")
        ) {
          return Number(match[1]);
        }
      }
      return 0;
    }),
    Effect.scoped,
  );

test.live.skipIf(process.platform === "win32")(
  "dev owner survives reload, duplicates do not start children, and Ctrl-C releases ownership after cleanup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = yield* HttpClient.HttpClient;
      const cwd = yield* fs.makeTempDirectoryScoped({
        directory: "/tmp",
        prefix: "dev-session-cli-",
      });
      const home = path.join(cwd, "home");
      const main = path.join(cwd, "alchemy.run.ts");
      const source = `export { default } from ${JSON.stringify(new URL("./fixtures/dev-session-stack.ts", import.meta.url).href)};\n`;
      yield* fs.writeFileString(main, source);
      const bin = yield* path.fromFileUrl(
        new URL("../../bin/cli.js", import.meta.url),
      );
      const first = yield* lifecycleFixture();
      const launch = Effect.fn(function* (
        directory: string,
        extra: string[] = [],
      ) {
        const child = yield* ChildProcess.make(
          "bun",
          [bin, "dev", main, "--stage", "ownership", ...extra],
          {
            cwd,
            env: {
              ALCHEMY_HOME: home,
              LIFECYCLE_DIR: directory,
              ALCHEMY_DEV_ONCE: "",
              CI: "1",
              NO_COLOR: "1",
            },
            extendEnv: true,
            forceKillAfter: "8 seconds",
          },
        );
        let output = "";
        yield* child.all.pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              output += chunk;
            }),
          ),
          Effect.forkScoped,
        );
        return { child, output: () => output };
      });
      const owner = yield* launch(first.directory);
      const ready = (fixture: typeof first) =>
        fixture.ready.pipe(Effect.timeout("30 seconds"));
      const pids = yield* ready(first);
      const url = yield* fs
        .readFileString(path.join(first.directory, "url"))
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 20 }),
        );
      expect((yield* http.get(url)).status).toBe(200);
      const records = path.join(home, "dev-sessions");
      const recordNames = yield* fs.readDirectory(records);
      expect(recordNames).toHaveLength(1);
      const recordFile = path.join(records, recordNames[0]!);
      const record = yield* fs.readFileString(recordFile);
      const stateDirectory = path.join(
        cwd,
        ".alchemy",
        "state",
        "DevSessionCli",
        "ownership",
      );
      expect(
        yield* fs
          .exists(path.join(stateDirectory, "__stack_output__.json"))
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: Boolean,
              times: 200,
            }),
          ),
      ).toBe(true);
      const stateFile = path.join(stateDirectory, "Server.json");
      const state = yield* fs.readFileString(stateFile);

      const duplicate = yield* launch(first.directory);
      expect(
        yield* duplicate.child.exitCode.pipe(Effect.timeout("10 seconds")),
      ).toBe(0);
      expect(duplicate.output()).toContain(
        `owner PID ${JSON.parse(record).pid}`,
      );
      expect(duplicate.output()).toContain("already running or starting");
      expect(yield* fs.readFileString(recordFile)).toBe(record);
      expect(yield* first.ready).toEqual(pids);

      const conflict = yield* launch(first.directory, ["--force"]);
      expect(
        yield* conflict.child.exitCode.pipe(Effect.timeout("10 seconds")),
      ).not.toBe(0);
      expect(conflict.output()).toContain("conflicting options: force");
      expect(yield* fs.readFileString(recordFile)).toBe(record);
      expect(yield* fs.readFileString(stateFile)).toBe(state);
      expect((yield* http.get(url)).status).toBe(200);

      const supervisor = JSON.parse(record).pid as number;
      const oldExec = yield* execPid(supervisor);
      expect(oldExec).toBeGreaterThan(0);
      yield* fs.writeFileString(main, `${source}// reload\n`);
      expect(
        yield* Effect.sync(() =>
          owner.output().includes("Reloading stack:"),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: Boolean,
            times: 150,
          }),
        ),
      ).toBe(true);
      const newExec = yield* execPid(supervisor).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (pid) => pid > 0 && pid !== oldExec,
          times: 200,
        }),
      );
      expect(newExec).toBeGreaterThan(0);
      expect(newExec).not.toBe(oldExec);
      const afterReload = yield* launch(first.directory);
      expect(
        yield* afterReload.child.exitCode.pipe(Effect.timeout("10 seconds")),
      ).toBe(0);
      expect(yield* fs.readFileString(recordFile)).toBe(record);
      expect(yield* first.ready).toEqual(pids);

      yield* owner.child.kill({
        killSignal: "SIGINT",
        forceKillAfter: "8 seconds",
      });
      expect(yield* first.has("wrapper.clean")).toBe(true);
      expect(
        (owner.output().match(/Shutting down/g) ?? []).length,
      ).toBeLessThanOrEqual(1);
      expect(
        (owner.output().match(/Exited\./g) ?? []).length,
      ).toBeLessThanOrEqual(1);
      yield* assertDead(pids.wrapper);
      yield* assertDead(pids.leaf);
      expect(yield* fs.exists(recordFile)).toBe(false);
      const second = yield* lifecycleFixture();
      const replacement = yield* launch(second.directory);
      const nextPids = yield* ready(second);
      expect(nextPids.wrapper).not.toBe(pids.wrapper);
      yield* replacement.child.kill({
        killSignal: "SIGINT",
        forceKillAfter: "8 seconds",
      });
      expect(yield* second.has("wrapper.clean")).toBe(true);
      yield* assertDead(nextPids.wrapper);
      yield* assertDead(nextPids.leaf);
      expect(yield* fs.exists(recordFile)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide([PlatformServices, FetchHttpClient.layer]),
    ),
  { timeout: 90_000 },
);
