import * as Archil from "@/Archil";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ArchilExecWorker from "./fixtures/exec-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
});

const hasArchil = !!process.env.ARCHIL_API_KEY;

class NotReady extends Data.TaggedError("NotReady")<{ body: string }> {}

/**
 * Fetch a route and parse it as an ExecResult, retrying through workers.dev
 * placeholder responses (which serve 200 HTML before the deploy propagates)
 * by asserting on the parsed shape rather than the status code.
 */
const fetchExecResult = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const text = yield* res.text;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as Archil.ExecResult,
      catch: () => new NotReady({ body: text.slice(0, 200) }),
    });
    if (typeof parsed.exitCode !== "number") {
      return yield* new NotReady({ body: text.slice(0, 200) });
    }
    return parsed;
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second", 1.5),
      times: 10,
    }),
  );

test.provider.skipIf(!hasArchil)(
  "deployed Worker manages and executes disks via the Client binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ArchilExecWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      // Static: exec on the deploy-time disk pinned through its accessor.
      const exec = yield* fetchExecResult(`${url}/static`);
      expect(exec.exitCode).toBe(0);
      expect(exec.stdout.trim()).toBe("worker-was-here");
      expect(exec.timing.executeMs).toBeGreaterThanOrEqual(0);

      // Dynamic: the Worker provisions a disk at request time, runs bash on
      // it, and deletes it — no disk reference existed at deploy time.
      const dynamic = (yield* fetchExecResult(
        `${url}/dynamic`,
      )) as Archil.ExecResult & { diskId: string };
      expect(dynamic.exitCode).toBe(0);
      expect(dynamic.stdout.trim()).toBe("dynamic-was-here");
      expect(dynamic.diskId).toMatch(/^dsk-[0-9a-f]{16}$/);

      // MultiExec: same pinned disk mounted at a named relative path.
      const multi = yield* fetchExecResult(`${url}/multi`);
      expect(multi.exitCode).toBe(0);
      expect(multi.stdout.trim()).toBe("worker-was-here");

      // Grep: the Worker searches for the marker it wrote (retry through
      // listing consistency).
      const client = yield* HttpClient.HttpClient;
      const grep = yield* client.get(`${url}/grep`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => body as unknown as Archil.GrepResult),
        Effect.repeat({
          until: (r: Archil.GrepResult): boolean =>
            Array.isArray(r.matches) && r.matches.length > 0,
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
      expect(grep.matches.some((m) => m.file.includes("from-worker.txt"))).toBe(
        true,
      );

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
