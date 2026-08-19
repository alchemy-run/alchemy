import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

const script = `export default {
  async fetch() {
    return Response.json({ ok: true });
  },
};`;

// One file per worker name under `.alchemy/local/worker-ports/` — the
// persisted port assignment the local Worker provider records (see
// LocalWorkerProvider's `recordPort`).
const portAssignmentFile = (workerName: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(
      process.cwd(),
      ".alchemy",
      "local",
      "worker-ports",
      encodeURIComponent(workerName),
    );
  });

const readAssignment = (workerName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* portAssignmentFile(workerName);
    return yield* fs.readFileString(file).pipe(
      Effect.map((content) => Number(content.trim())),
      Effect.orElseSucceed(() => undefined),
    );
  });

const seedAssignment = (workerName: string, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* portAssignmentFile(workerName);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${port}`);
  });

// An implicit dev port would otherwise be assigned by hunting up from 1337
// in nondeterministic start order, reshuffling every worker's URL between
// dev sessions. The provider records each worker's actual port and prefers
// it on the next start — this test simulates "the next session" by seeding
// the recorded assignment before the worker's first start.
const STICKY_WORKER = "dev-ports-sticky-a";
const FRESH_WORKER = "dev-ports-fresh-b";
// Arbitrary, far outside the 1337-onward hunt range shared with other
// suites' workers.
const SEEDED_PORT = 42871;

test.provider(
  "implicit dev ports are recorded and reused across sessions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* seedAssignment(STICKY_WORKER, SEEDED_PORT);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            sticky: yield* Cloudflare.Worker("sticky-worker", {
              name: STICKY_WORKER,
              script,
            }),
            fresh: yield* Cloudflare.Worker("fresh-worker", {
              name: FRESH_WORKER,
              script,
            }),
          };
        }),
      );

      // The seeded assignment wins over the default-port hunt — proof a
      // recorded port from a previous session pins the worker's URL.
      expect(deployed.sticky.url).toBe(`http://localhost:${SEEDED_PORT}`);
      const body = (yield* getJsonReady(deployed.sticky.url!)) as {
        ok: boolean;
      };
      expect(body.ok).toBe(true);

      // The fresh worker hunted a port and recorded it for the next
      // session.
      expect(deployed.fresh.url).toMatch(/^http:\/\/localhost:\d+$/);
      const freshPort = Number(new URL(deployed.fresh.url!).port);
      expect(yield* readAssignment(FRESH_WORKER)).toBe(freshPort);
      expect(yield* readAssignment(STICKY_WORKER)).toBe(SEEDED_PORT);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
