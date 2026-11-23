import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import EmailLocalWorker from "./fixtures/email-local-worker.ts";
import EmailRemoteWorker, { remoteInbox } from "./fixtures/email-remote-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const FROM = "sender@example.com";
const TO = "inbox@example.com";

const email = (subject: string) =>
  [
    `From: <${FROM}>`,
    `To: <${TO}>`,
    `Subject: ${subject}`,
    "Message-ID: <local-email@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "hello",
  ].join("\n");

/**
 * `Cloudflare.email({ zone }).subscribe(...)` under `alchemy dev`. The local
 * runtime's `/cdn-cgi/handler/email` route hands the message to the Worker's
 * `email()` over JSRPC, which reaches the subscription's handler. The zone
 * does not exist, so the deploy also proves dev provisions no Email Routing.
 */
test.provider(
  "local email() subscription handles the inbound email trigger route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* EmailLocalWorker };
        }),
      );

      // The dev URL is the local proxy, so no cloud deploy ran.
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const client = yield* HttpClient.HttpClient;
      const send = (subject: string) =>
        client.execute(
          HttpClientRequest.post(
            `${worker.url}/cdn-cgi/handler/email?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
          ).pipe(HttpClientRequest.bodyText(email(subject))),
        );

      // Readiness probe for the freshly started workerd.
      yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.void
            : Effect.fail(new WorkerNotReady({ status: res.status })),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
            Schedule.recurs(10),
          ]),
        }),
      );

      const accepted = yield* send("hello");
      expect(yield* accepted.text).toBe("Worker successfully processed email");
      expect(accepted.status).toBe(200);

      const rejected = yield* send("reject-me");
      expect(rejected.status).toBe(400);
      expect(yield* rejected.text).toBe(
        "Worker rejected email with the following reason: not on the list",
      );

      const received = yield* (yield* client.get(`${worker.url}/received`)).json;
      expect(received).toEqual([{ from: FROM, to: TO, subject: "hello" }]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:email",
      "local",
    ],
    timeout: 180_000,
  },
);

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// A freshly minted test token can 403 until it propagates.
const rideOutAuth = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

/** The zone's routing rules that hand mail to `workerName`. */
const rulesFor = (workerName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: ZONE });
    if (!zone) return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
    const rules = yield* rideOutAuth(emailRouting.listRules({ zoneId: zone.id }));
    return (rules.result ?? []).filter((rule) =>
      (rule.actions ?? []).some((a) => a.type === "worker" && (a.value ?? []).includes(workerName)),
    );
  });

/**
 * `Alchemy.remote()` keeps a Worker on Cloudflare during `alchemy dev`, so
 * its subscription still provisions the routing rule that delivers to it,
 * and destroying the stack removes the rule.
 */
test.provider(
  "Alchemy.remote() worker still provisions its Email Routing rule in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* EmailRemoteWorker.pipe(Alchemy.remote()) };
        }),
      );

      // A deployed Worker, not the local proxy.
      expect(worker.url ?? "").not.toMatch(/^http:\/\/localhost/);

      const rules = yield* rulesFor(worker.workerName);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.matchers).toEqual([
        { type: "literal", field: "to", value: remoteInbox(ZONE, stack.stage) },
      ]);

      yield* stack.destroy();

      expect(yield* rulesFor(worker.workerName)).toEqual([]);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:email",
      "live",
    ],
    timeout: 180_000,
  },
);
