import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EmailTestWorker from "./fixtures/email-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const ZONE = process.env.CLOUDFLARE_TEST_ZONE;
const INBOX = process.env.CLOUDFLARE_TEST_EMAIL_INBOX;
const FROM = process.env.CLOUDFLARE_TEST_EMAIL_FROM;
const skip = !ZONE || !INBOX || !FROM;

const Stack = Alchemy.Stack(
  "EmailEventSourceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* EmailTestWorker;
    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY || skip)(destroy(Stack));

test.skipIf(skip)(
  "deployed worker receives inbound mail routed by the auto-created EmailRule",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Reset DO state and double as a readiness probe — fresh workers.dev
    // URLs take a few seconds to start serving 200s.
    yield* Effect.gen(function* () {
      const res = yield* client.post(`${url}/reset`);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`Worker not ready: ${res.status}`));
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    const resetAt = Date.now();

    // Send a unique-subject message via the worker's send_email binding.
    const subject = `alchemy email test ${resetAt}`;
    const sendUrl = `${url}/send?subject=${encodeURIComponent(subject)}`;
    yield* Effect.gen(function* () {
      const res = yield* client.post(sendUrl);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`/send failed: ${res.status}`));
      }
      const body = (yield* res.json) as { ok: boolean; message?: string };
      if (!body.ok) {
        return yield* Effect.fail(
          new Error(`send_email failed: ${body.message}`),
        );
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
    );

    // Cloudflare's email pipeline is async — the inbound dispatch typically
    // lands within ~30s but can take longer under load.
    const received = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/received`);
      if (res.status !== 200) return [];
      const body = (yield* res.json) as { received?: unknown };
      if (!Array.isArray(body.received)) return [];
      return body.received.filter(
        (r): r is { subject: string | null; receivedAt: number } =>
          typeof r === "object" &&
          r !== null &&
          (r as { subject?: unknown }).subject === subject,
      );
    }).pipe(
      Effect.catch(() => Effect.succeed([])),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (matches) => matches.length > 0,
        times: 48,
      }),
    );

    expect(received.length).toBeGreaterThan(0);
    for (const msg of received) {
      expect(msg.subject).toBe(subject);
      expect(msg.receivedAt).toBeGreaterThanOrEqual(resetAt);
    }
  }).pipe(logLevel),
  { timeout: 360_000 },
);
