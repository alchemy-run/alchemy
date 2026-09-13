import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Path from "node:path";
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });
class RestartPending extends Data.TaggedError("RestartPending") {}

test.provider(
  "local Analytics Engine retains points, queries them and survives Worker replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (revision: string) =>
        Effect.gen(function* () {
          const events = yield* Cloudflare.AnalyticsEngine.Dataset("Events", {
            dataset: "local_analytics_fixture",
          });
          return yield* Cloudflare.Worker("analytics-local", {
            main: Path.resolve(import.meta.dirname, "fixtures/local-worker.ts"),
            env: { EVENTS: events, REVISION: revision },
          });
        });
      let worker = yield* stack.deploy(program("1"));
      const read = (path: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${worker.url}${path}`);
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<any>;
        });
      const before = (yield* read("/query")).data[0];
      const after = (yield* read("/write")).data[0];
      expect(after.count).toBe(before.count + 2);
      expect(after.total).toBe((before.total ?? 0) + 10);
      expect((yield* read("/invalid")).rejected).toBe(4);
      expect((yield* read("/query")).data[0].count).toBe(after.count);
      const point = (yield* read("/points")).data[0];
      expect(point.blobs).toEqual(["signup", { base64: "AP8=" }]);
      worker = yield* stack.deploy(program("2"));
      yield* Effect.promise(() =>
        fetch(`${worker.url}/revision`).then((r) => r.text()),
      ).pipe(
        Effect.flatMap((version) =>
          version === "2" ? Effect.void : Effect.fail(new RestartPending()),
        ),
        Effect.retry({
          while: (error) => error._tag === "RestartPending",
          times: 8,
          schedule: Schedule.spaced("500 millis"),
        }),
      );
      expect((yield* read("/query")).data[0]).toEqual(after);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
