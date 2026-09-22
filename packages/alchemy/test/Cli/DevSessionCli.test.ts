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
const pidAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return false;
      throw error;
    }
  });

const assertDead = (pid: number) =>
  pidAlive(pid).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (alive) => !alive,
      times: 120,
    }),
    Effect.tap((alive) => Effect.sync(() => expect(alive).toBe(false))),
  );

const serverFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "dev-session-server-",
  });
  const file = path.join(directory, "pid");
  const read = fs.readFileString(file).pipe(
    Effect.map(Number),
    Effect.filterOrFail(
      (pid) => Number.isSafeInteger(pid) && pid > 0,
      () => new Error("Invalid fixture PID"),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return;
      const pid = yield* read;
      if (yield* pidAlive(pid))
        yield* Effect.sync(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        });
    }).pipe(Effect.orDie),
  );
  return {
    directory,
    ready: fs
      .exists(file)
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          until: Boolean,
          times: 300,
        }),
        Effect.andThen(read),
      ),
    closed: fs.exists(path.join(directory, "server.closed")),
  };
});

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

for (const runtime of ["bun", "node"] as const) {
  test.live.skipIf(process.platform === "win32")(
    `dev owner survives reload and releases ownership after cleanup (${runtime})`,
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
        yield* fs.writeFileString(
          path.join(cwd, ".env"),
          "ALCHEMY_PROFILE=dotenv-profile\n",
        );
        const bin = yield* path.fromFileUrl(
          new URL("../../bin/cli.js", import.meta.url),
        );
        const first = yield* serverFixture();
        const launch = Effect.fn(function* (
          directory: string,
          extra: string[] = [],
          childRuntime: "bun" | "node" = runtime,
        ) {
          const child = yield* ChildProcess.make(
            childRuntime,
            [bin, "dev", main, "--stage", "ownership", ...extra],
            {
              cwd,
              env: {
                ALCHEMY_HOME: home,
                ALCHEMY_PROFILE: "",
                DEV_SESSION_DIR: directory,
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
        expect(
          yield* fs.readFileString(path.join(first.directory, "profile")),
        ).toBe("unset");
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

        const duplicate = yield* launch(
          first.directory,
          [],
          runtime === "bun" ? "node" : "bun",
        );
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
        if (runtime === "bun") {
          const newExec = yield* execPid(supervisor).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (pid) => pid > 0 && pid !== oldExec,
              times: 200,
            }),
          );
          expect(newExec).toBeGreaterThan(0);
          expect(newExec).not.toBe(oldExec);
        } else {
          expect(yield* execPid(supervisor)).toBe(oldExec);
        }
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
        expect(yield* first.closed).toBe(true);
        expect(
          (owner.output().match(/Shutting down/g) ?? []).length,
        ).toBeLessThanOrEqual(1);
        expect(
          (owner.output().match(/Exited\./g) ?? []).length,
        ).toBeLessThanOrEqual(1);
        yield* assertDead(pids);
        expect(yield* fs.exists(recordFile)).toBe(false);
        const second = yield* serverFixture();
        const replacement = yield* launch(second.directory, [
          "--profile",
          "explicit-profile",
        ]);
        const nextPids = yield* ready(second);
        expect(
          yield* fs.readFileString(path.join(second.directory, "profile")),
        ).toBe("explicit-profile");
        expect(nextPids).not.toBe(pids);
        yield* replacement.child.kill({
          killSignal: "SIGINT",
          forceKillAfter: "8 seconds",
        });
        expect(yield* second.closed).toBe(true);
        yield* assertDead(nextPids);
        expect(yield* fs.exists(recordFile)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide([PlatformServices, FetchHttpClient.layer]),
      ),
    { tags: ["local"], timeout: 90_000 },
  );
}
