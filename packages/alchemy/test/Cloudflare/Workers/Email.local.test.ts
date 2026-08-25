import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EmailLocalWorker from "./fixtures/email-local-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
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

const FROM = "someone@example.com";
const TO = "someone-else@example.com";

const incomingEmail = (subject: string) =>
  [
    `From: someone <${FROM}>`,
    `To: someone else <${TO}>`,
    `Subject: ${subject}`,
    `Message-ID: <incoming-${subject}@example.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "This is a random email body.",
  ].join("\n");

/** POST a raw MIME message to the worker's inbound email trigger route. */
const postEmail = (workerUrl: string, raw: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(
      HttpClientRequest.post(
        `${workerUrl}/cdn-cgi/handler/email?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      ).pipe(HttpClientRequest.bodyText(raw)),
    );
  });

/**
 * Under `alchemy dev` the local runtime dispatches
 * `POST {workerUrl}/cdn-cgi/handler/email?from=X&to=Y` (raw MIME body) to
 * the worker's `email()` handler — for an Effect-native worker that means
 * the listeners registered by `Cloudflare.email().subscribe(...)`. This
 * pins the local roundtrip for the event source: envelope + header +
 * size delivery into the subscribe handler, and the Effect-wrapped
 * `setReject` surfacing as a 400 on the trigger route.
 */
test.provider(
  "local email trigger dispatches to the email().subscribe handler",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* EmailLocalWorker;
          return { worker };
        }),
      );

      // The dev URL is the local proxy — proof no cloud deploy ran.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const url = deployed.worker.url!;
      const client = yield* HttpClient.HttpClient;

      // Reset the inbox DO. Doubles as a readiness probe for the first
      // request against a freshly started workerd.
      yield* Effect.gen(function* () {
        const res = yield* client.post(`${url}/reset`);
        if (res.status !== 200) {
          return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      const marker = yield* Effect.sync(() => crypto.randomUUID());

      // 1. Accepted email → 200, and the subscribe handler observed the
      //    envelope addresses, the subject header, and the raw size.
      const subject = `accept-me:${marker}`;
      const raw = incomingEmail(subject);
      const okRes = yield* postEmail(url, raw);
      const okText = yield* okRes.text;
      expect(`${okRes.status}: ${okText}`).toBe(
        "200: Worker successfully processed email",
      );

      const received = yield* Effect.gen(function* () {
        const res = yield* client.get(`${url}/received`);
        if (res.status !== 200) return [];
        const body = (yield* res.json) as { received?: unknown };
        return Array.isArray(body.received) ? body.received : [];
      }).pipe(
        Effect.catch(() => Effect.succeed([] as unknown[])),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (received): boolean => received.length > 0,
          times: 10,
        }),
      );

      expect(received).toHaveLength(1);
      const message = received[0] as {
        from: string;
        to: string;
        subject: string | null;
        bodySize: number;
      };
      expect(message.from).toBe(FROM);
      expect(message.to).toBe(TO);
      expect(message.subject).toBe(subject);
      expect(message.bodySize).toBe(new TextEncoder().encode(raw).byteLength);

      // 2. `setReject(reason)` from inside the subscribe handler → 400
      //    carrying the reject reason.
      const rejectRes = yield* postEmail(url, incomingEmail("reject-me"));
      expect(rejectRes.status).toBe(400);
      expect(yield* rejectRes.text).toBe(
        "Worker rejected email with the following reason: rejected by EmailEventSource test",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
