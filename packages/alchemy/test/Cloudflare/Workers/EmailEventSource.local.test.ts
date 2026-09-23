import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EmailSubscribeLocalWorker from "./fixtures/email-subscribe-local-worker.ts";

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

const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
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
  }).pipe(Effect.orDie);

const FROM = "someone@example.com";
const TO = "inbox@example.com";

const incomingEmail = (subject: string) =>
  [
    `From: someone <${FROM}>`,
    `To: inbox <${TO}>`,
    `Subject: ${subject}`,
    "Message-ID: <local-subscribe@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "hello from the local trigger route",
  ].join("\n");

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
 * `Cloudflare.email().subscribe(...)` against the local simulator.
 *
 * The local entry worker delivers inbound mail as a JSRPC call,
 * `env[USER_WORKER].email(message)` — the same shape Cloudflare's mail
 * pipeline uses against a deployed Worker. workerd resolves JSRPC methods
 * only on the target entrypoint's *prototype chain*, so this is a
 * regression guard for `WorkerBridge` keeping the handler set there: an own
 * instance property of the same name shadows the prototype entry and the
 * call fails with `The RPC receiver does not implement the method "email"`.
 *
 * `fetch`/`scheduled`/`queue` cannot catch that — workerd dispatches those
 * through its built-in event path rather than over RPC — which is why this
 * test earns its keep alongside `CronEventSource.local.test.ts`.
 */
test.provider(
  "the local email trigger dispatches to a subscribe() handler",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Yield the fixture class itself: it is an Effect-native Worker, so
      // its `main: import.meta.filename` and init effect have to come from
      // the class rather than a generic Worker pointed at the same file.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* EmailSubscribeLocalWorker;
          return { worker };
        }),
      );

      // Serving from the local dev proxy — proof nothing was deployed.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* getReady(deployed.worker.url!);

      // 1. Accepted message reaches the subscribe handler.
      const raw = incomingEmail("accept-me");
      const res = yield* postEmail(deployed.worker.url!, raw);
      expect(res.status).toBe(200);

      const snapshot = (yield* (yield* getReady(
        `${deployed.worker.url}/received`,
      )).json) as { received: Array<Record<string, unknown>> };
      expect(snapshot.received).toHaveLength(1);
      const message = snapshot.received[0]!;
      // Envelope addresses come from the trigger route's query parameters.
      expect(message.from).toBe(FROM);
      expect(message.to).toBe(TO);
      expect(message.subject).toBe("accept-me");
      // `bodySize` is the wrapper's name for cf's `rawSize`.
      expect(message.bodySize).toBe(new TextEncoder().encode(raw).byteLength);
      expect(message.body).toBe(raw);

      // 2. `setReject` — an Effect on the wrapper — surfaces as 400 with the
      //    reason, same as the raw-handler path.
      const rejected = yield* postEmail(
        deployed.worker.url!,
        incomingEmail("reject-me"),
      );
      expect(rejected.status).toBe(400);
      expect(yield* rejected.text).toContain("I don't like this email");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
