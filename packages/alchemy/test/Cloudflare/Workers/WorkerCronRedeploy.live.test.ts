import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import { localState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// Store invocations outside the Worker's isolate so a redeploy cannot erase
// the evidence. The revision is embedded in the scheduled handler's code.
const program = (revision: number) =>
  Alchemy.Stack(
    "WorkerCronRedeploy",
    { providers: Cloudflare.providers(), state: localState() },
    Effect.gen(function* () {
      return yield* Cloudflare.Worker("Worker", {
        crons: ["* * * * *"],
        env: { Counter: Cloudflare.DurableObject("Counter") },
        script: `
          import { DurableObject } from "cloudflare:workers";
          export class Counter extends DurableObject {
            async fetch(request) {
              if (request.method === "POST") {
                const record = await request.json();
                await this.ctx.storage.put(String(record.time), record);
              }
              return Response.json([... (await this.ctx.storage.list()).values()]);
            }
          }
          export default {
            fetch(request, env) {
              return env.Counter.getByName("counter").fetch(request);
            },
            async scheduled(controller, env) {
              await env.Counter.getByName("counter").fetch("https://counter/", {
                method: "POST",
                body: JSON.stringify({ revision: ${revision}, time: controller.scheduledTime }),
              });
            },
          };
        `,
      });
    }),
  );

const waitForRevision = Effect.fn(function* (url: string, revision: number) {
  const client = yield* HttpClient.HttpClient;
  const fired = yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 404 || response.status >= 500
        ? Effect.succeed(undefined)
        : response.json,
    ),
    Effect.map(
      (body) =>
        Array.isArray(body) &&
        body.some((record) => record.revision === revision),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (found) => found,
      times: 8,
    }),
  );
  expect(fired).toBe(true);
});

// Opt-in diagnostic: Cloudflare documents up to 15 minutes of initial cron
// propagation. Keep the probe bounded; an initial-fire timeout is inconclusive
// for the redeploy bug. Enable with CLOUDFLARE_TEST_CRON_REDEPLOY=1.
describe.skipIf(process.env.CLOUDFLARE_TEST_CRON_REDEPLOY !== "1")(
  "live cron redeploy",
  () => {
    const initial = beforeAll(
      Effect.gen(function* () {
        yield* destroy(program(1));
        const worker = yield* deploy(program(1));
        // A failure here is initial trigger propagation, not a redeploy regression.
        yield* waitForRevision(worker.url!, 1);
        return worker;
      }),
      { timeout: 120_000 },
    );

    afterAll(destroy(program(2)));

    test(
      "unchanged cron invokes the new code after a Worker redeploy",
      Effect.gen(function* () {
        const before = yield* initial;
        const after = yield* deploy(program(2));
        expect(after.workerName).toBe(before.workerName);
        expect(after.crons).toEqual(before.crons);
        expect(after.hash).not.toEqual(before.hash);

        const observed = yield* workers
          .getScriptSchedule({
            accountId: after.accountId,
            scriptName: after.workerName,
          })
          .pipe(Effect.provide(Cloudflare.CloudflareApiLive()));
        expect(observed.schedules.map(({ cron }) => cron)).toEqual([
          "* * * * *",
        ]);
        // A schedule still visible in the API is insufficient: the new code must run.
        yield* waitForRevision(after.url!, 2);
      }),
      { timeout: 120_000 },
    );
  },
);
