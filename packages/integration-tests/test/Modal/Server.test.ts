import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as app from "@distilled.cloud/modal/app";
import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  doWork,
  OtelCollector,
  waitForRpcLink,
  waitForWorkSpan,
  withCollectorUrl,
} from "../Utils/Telemetry.ts";
import TracedRpcCaller from "./fixtures/traced-rpc-caller.ts";
import TracedRpcFunction from "./fixtures/traced-rpc-function.ts";
import TracedRpcServer from "./fixtures/traced-rpc-server.ts";
import TracedServer from "./fixtures/traced-server.ts";
import { hostIdentity } from "./hostIdentity.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Modal.providers(), Cloudflare.providers(), hostIdentity),
});

const main = new URL("./fixtures/lifecycle-program.ts", import.meta.url).pathname;

const deployServer = (props: Omit<Modal.ServerProps, "main" | "app">) =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("ServerLifecycleEnv", {});
    const target = yield* Modal.App("ServerLifecycleApp", { environment });
    const server = yield* Modal.Server("Lifecycle", { main, app: target, ...props });
    return { server, appId: target.appId };
  });

test.provider(
  "deploy and update a server, then remove it from its App",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(deployServer({ env: { VERSION: "1" } }));
      expect(first.server.url).toMatch(/^https:\/\//);
      const created = yield* functions.functionGetById({ functionId: first.server.functionId });
      expect(created.function?.isServer).toBe(true);
      expect(created.function?.httpConfig?.unauthenticated).toBeFalsy();

      const second = yield* stack.deploy(
        deployServer({ env: { VERSION: "2" }, unauthenticated: true, maxConcurrency: 10 }),
      );
      expect(second.server.functionId).toBe(first.server.functionId);
      const updated = yield* functions.functionGetById({ functionId: second.server.functionId });
      expect(updated.function?.httpConfig?.unauthenticated).toBe(true);

      yield* stack.destroy();
      const { apps } = yield* app.listApp({ environmentName: "" });
      const stopped = (apps ?? []).find((item) => item.appId === second.appId);
      expect(
        stopped === undefined ||
          stopped.state === "APP_STATE_STOPPED" ||
          stopped.state === "APP_STATE_STOPPING",
      ).toBe(true);
    }),
  { tags: ["provider:modal", "provider:modal:server", "live"], timeout: 900_000 },
);

test.provider(
  "a server exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      const server = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedServer;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      expect(yield* doWork(server.url!, "modal")).toBe("did work modal");
      const traces = yield* waitForWorkSpan(collector.url!, "modal");
      expect(traces).toContain("work:modal");
      expect(traces).toContain("modal-server-e2e");

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:modal",
      "provider:modal:server",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 900_000,
  },
);

/** GET `url` until it answers 200: a fresh Server or Function cold-starts its container. */
const getText = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : Effect.flatMap(response.text, (body) =>
            Effect.fail(new Error(`${url} answered ${response.status}: ${body}`)),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 80 }),
  );
});

test.provider(
  "a Server's and a Function's RPC methods join the caller's trace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const collector = yield* stack.deploy(OtelCollector());
      const caller = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            yield* TracedRpcServer;
            yield* TracedRpcFunction;
            return yield* TracedRpcCaller;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      // Over HTTP to a Server, and through Modal's relay to a Function.
      // A tag per attempt, so spans from an earlier attempt can't match.
      const attempt = Date.now().toString(36);
      for (const [path, tag] of [
        ["server", `modal-rpc-server-${attempt}`],
        ["function", `modal-rpc-function-${attempt}`],
      ] as const) {
        expect(yield* getText(`${caller.url}/${path}?tag=${tag}`)).toBe(`traced ${tag}`);
        expect(yield* waitForRpcLink(collector.url!, tag)).toEqual({
          found: true,
          sameTrace: true,
          belowCaller: true,
        });
      }

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:modal",
      "provider:modal:server",
      "provider:modal:function",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 900_000,
  },
);
