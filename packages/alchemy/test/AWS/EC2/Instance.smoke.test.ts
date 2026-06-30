import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestInstance from "./fixtures/instance.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Full end-to-end: bundle the hosted program, launch a real EC2 instance into a
// public subnet, and prove over HTTP (directly against the instance's public
// IP) that (a) the `{ fetch }` handler is served by the instance's Bun HTTP
// server and (b) the `ServerHost.run` background loop is executing on the
// instance (`/ticks` keeps climbing).
//
// Heavy (instance boot + bun install + S3 sync + systemd), so skipped under
// `FAST=1`.
test.provider.skipIf(!!process.env.FAST)(
  "deploys a real EC2 instance that serves HTTP and runs a background loop",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { publicIpAddress } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* TestInstance;
          return { publicIpAddress: instance.publicIpAddress };
        }),
      );

      expect(publicIpAddress).toBeTruthy();
      const base = `http://${publicIpAddress}:3000`;

      // Wait for the instance to boot, install bun, sync the bundle from S3,
      // and start the systemd unit serving on :3000.
      const health = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 60 }),
      );
      expect(health.status).toBe(200);
      expect(yield* health.json).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing on the instance:
      // the tick counter climbs between two reads.
      const readTicks = HttpClient.get(`${base}/ticks`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      yield* Effect.sleep("3 seconds");
      const second = yield* readTicks;
      expect(second).toBeGreaterThan(first);

      yield* stack.destroy();
    }),
  { timeout: 1_200_000 },
);
