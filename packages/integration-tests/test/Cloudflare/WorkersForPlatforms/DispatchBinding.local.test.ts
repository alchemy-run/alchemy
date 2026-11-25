import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Alchemy from "alchemy";
import { isResourceState, State } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { testName } from "../../names.ts";
import { type OutboundParams, userWorkerScript } from "./fixtures/shared.ts";

/**
 * Dispatch in `alchemy dev`: a dispatch namespace has no local emulation, so a
 * locally served Worker's dispatch binding reaches the live namespace.
 * Cloudflare's preview refuses a dispatch binding with an outbound Worker, so
 * that binding goes through a deployed shim Worker that holds it, which a dev
 * run creates and its destroy deletes. The namespace, the user Worker in it
 * and the outbound Worker are `Alchemy.remote()`; the dispatcher runs locally. Set `CLOUDFLARE_TEST_WFP=0` to skip on an account without
 * Workers for Platforms.
 */
const WFP_ENABLED = process.env.CLOUDFLARE_TEST_WFP !== "0";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/** Request a URL and read its status and JSON body. */
const getJson = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    return { status: res.status, body: (yield* res.json) as { error?: string } };
  });

/** Request a URL until it answers 200 with JSON. */
const jsonWhenReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const body = yield* res.text;
    if (res.status !== 200) return yield* new NotReady({ status: res.status, body });
    return JSON.parse(body) as unknown;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotReady",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

test.provider.skipIf(!WFP_ENABLED)(
  "alchemy dev forwards outbound to the remote dispatch proxy",
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
          }).pipe(Alchemy.remote());
          const platform = yield* Cloudflare.Worker("WfpDevPlatformWorker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/async-platform-handler.ts"),
            env: {
              DISPATCH: namespace,
              DISPATCH_OUTBOUND: Cloudflare.WorkersForPlatforms.Get<OutboundParams>(namespace, {
                outbound: outbound,
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
      expect(
        yield* jsonWhenReady(`${deployed.url}/outbound/${deployed.userWorkerName}?tenant=acme`),
      ).toEqual({
        seen: "https://example.com/probe",
        tenant: "acme",
      });

      // The dispatched request keeps its own Authorization header: the shim
      // authenticates with a header of its own.
      const client = yield* HttpClient.HttpClient;
      const echoed = yield* client.execute(
        HttpClientRequest.get(
          `${deployed.url}/outbound-headers/${deployed.userWorkerName}?tenant=acme`,
        ).pipe(HttpClientRequest.setHeader("authorization", "Bearer tenant-credential")),
      );
      expect(echoed.status).toBe(200);
      expect(((yield* echoed.json) as { authorization: string | null }).authorization).toBe(
        "Bearer tenant-credential",
      );

      // A dispatch that fails on the shim rejects, as it does on Cloudflare.
      const missing = yield* getJson(
        `${deployed.url}/outbound/this-script-does-not-exist?tenant=acme`,
      );
      expect(missing.status).toBe(500);
      expect(missing.body.error).toContain("Worker not found");

      // Only the shim marks a dispatch as failed: a user Worker that sets the
      // shim's headers still answers platform code with a plain success.
      expect(
        yield* getJson(`${deployed.url}/outbound-marked/${deployed.userWorkerName}?tenant=acme`),
      ).toEqual({ status: 200, body: { status: 200, text: "marked", shim: null, error: null } });

      // The shim is a live Worker this dev run created.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const state = yield* yield* State;
      const rows = yield* Effect.forEach(
        yield* state.list({ stack: stack.name, stage: stack.stage }),
        (fqn) => state.get({ stack: stack.name, stage: stack.stage, fqn }),
      );
      const shim = rows.find((row) => isResourceState(row) && row.logicalId.endsWith("Shim"));
      const shimName = isResourceState(shim)
        ? (shim.attr as { workerName: string }).workerName
        : "";
      expect(shimName).not.toBe("");
      const shimExists = workers
        .getScriptScriptAndVersionSetting({ accountId, scriptName: shimName })
        .pipe(
          Effect.as(true),
          Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
        );
      expect(yield* shimExists).toBe(true);

      // A shim that stops answering fails the dispatch: its workers.dev
      // page is never passed off as the user Worker's answer.
      yield* workers.deleteScript({ accountId, scriptName: shimName, force: true });
      const lost = yield* Effect.gen(function* () {
        const res = yield* client.get(
          `${deployed.url}/outbound/${deployed.userWorkerName}?tenant=acme`,
        );
        return { status: res.status, text: yield* res.text };
      }).pipe(
        // The deleted shim's URL can serve for a few seconds.
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (res) => res.status !== 200,
          times: 12,
        }),
      );
      expect(lost.status).toBe(500);
      expect(lost.text).toContain("dispatch shim");

      yield* stack.destroy();
      expect(yield* shimExists).toBe(false);
      const gone = yield* wfp
        .getDispatchNamespace({ accountId, dispatchNamespace: deployed.namespace })
        .pipe(
          Effect.as(false),
          Effect.catchTag("DispatchNamespaceNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
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

// The shim is a live Worker, so it can only call a live outbound Worker: an
// outbound Worker that runs locally in the dev run gets no shim, the dev run
// still starts, and the binding warns that its dispatches will fail.
test.provider.skipIf(!WFP_ENABLED)(
  "a local outbound Worker gets no dev shim, and dev still starts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const warnings: string[] = [];
      const capture = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      });
      const deployed = yield* stack
        .deploy(
          Effect.gen(function* () {
            const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
              "WfpDevLocalNs",
              {
                name: testName("alchemy-wfp-dev-local-outbound"),
              },
            ).pipe(Alchemy.remote());
            const outbound = yield* Cloudflare.Worker("WfpDevLocalOutboundWorker", {
              main: pathe.resolve(import.meta.dirname, "fixtures/outbound-worker.ts"),
            });
            const platform = yield* Cloudflare.Worker("WfpDevLocalPlatformWorker", {
              main: pathe.resolve(import.meta.dirname, "fixtures/async-platform-handler.ts"),
              env: {
                DISPATCH: namespace,
                DISPATCH_OUTBOUND: Cloudflare.WorkersForPlatforms.Get<OutboundParams>(namespace, {
                  outbound: outbound,
                  parameters: ["tenant"],
                }),
              },
            });
            return { url: platform.url, outboundUrl: outbound.url };
          }),
        )
        .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: true })));
      expect(deployed.url).toMatch(/^http:\/\/localhost/);
      expect(deployed.outboundUrl).toMatch(/^http:\/\/localhost/);
      expect(
        warnings.filter(
          (warning) =>
            warning.includes("WfpDevLocalOutboundWorker") && warning.includes("Alchemy.remote()"),
        ),
      ).toHaveLength(1);

      const state = yield* yield* State;
      const rows = yield* Effect.forEach(
        yield* state.list({ stack: stack.name, stage: stack.stage }),
        (fqn) => state.get({ stack: stack.name, stage: stack.stage, fqn }),
      );
      expect(rows.some((row) => isResourceState(row) && row.logicalId.endsWith("Shim"))).toBe(
        false,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
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
