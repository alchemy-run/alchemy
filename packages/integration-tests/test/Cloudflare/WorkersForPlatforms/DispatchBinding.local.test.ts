import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { testName } from "../../names.ts";
import { type OutboundParams, userWorkerScript } from "./fixtures/shared.ts";

/**
 * Dispatch in `alchemy dev`: a dispatch namespace has no local emulation, so a
 * locally served Worker's dispatch binding reaches the live namespace through
 * Cloudflare's preview. The preview refuses a binding with an outbound Worker,
 * so in dev the binding has none: dispatches work, and a user Worker's
 * `fetch()` reaches the internet. Set `CLOUDFLARE_TEST_WFP=0` to skip on an
 * account without Workers for Platforms.
 */
const WFP_ENABLED = process.env.CLOUDFLARE_TEST_WFP !== "0";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/** Request a URL until it answers, and read its status and body. */
const whenReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const body = yield* res.text;
    // The preview session answers 5xx until it is up.
    if (res.status >= 500) return yield* new NotReady({ status: res.status, body });
    return { status: res.status, body };
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotReady",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

test.provider.skipIf(!WFP_ENABLED)(
  "alchemy dev dispatches through a binding with an outbound Worker, without it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("WfpDevNs", {
            name: testName("alchemy-wfp-dev-outbound"),
          }).pipe(Alchemy.remote());
          const user = yield* Cloudflare.Worker("WfpDevUserWorker", {
            namespace: namespace.name,
            script: userWorkerScript,
          }).pipe(Alchemy.remote());
          const outbound = yield* Cloudflare.Worker("WfpDevOutboundWorker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/outbound-worker.ts"),
            env: { VIA: "dev" },
          }).pipe(Alchemy.remote());
          const platform = yield* Cloudflare.Worker("WfpDevPlatformWorker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/async-platform-handler.ts"),
            env: {
              DISPATCH: namespace,
              DISPATCH_OUTBOUND: Cloudflare.WorkersForPlatforms.Get<OutboundParams>(namespace, {
                outbound,
                parameters: ["tenant"],
              }),
            },
          });
          return {
            url: platform.url,
            userWorkerName: user.workerName,
            namespace: namespace.name,
          };
        }),
      );

      // The dispatcher is served locally; the user Worker is live.
      expect(deployed.url).toMatch(/^http:\/\/localhost/);
      const plain = yield* whenReady(`${deployed.url}/dispatch/${deployed.userWorkerName}/hello`);
      expect(JSON.parse(plain.body)).toMatchObject({ handledBy: "user-worker", path: "/hello" });

      // The dispatch reaches the user Worker with its outbound values, and
      // the user Worker's fetch is answered by the origin (HTML), not by the
      // outbound Worker (JSON naming itself in `via`).
      const egress = yield* whenReady(
        `${deployed.url}/outbound/${deployed.userWorkerName}?tenant=acme`,
      );
      expect(egress.body).toContain("Example Domain");
      expect(egress.body).not.toContain('"via"');

      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const gone = yield* wfp
        .getDispatchNamespace({ accountId, dispatchNamespace: deployed.namespace })
        .pipe(
          Effect.as(false),
          Effect.catchTag("DispatchNamespaceNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workersforplatforms",
      "local",
      "live",
    ],
    timeout: 300_000,
  },
);
