import type { Application, ApplicationAttributes } from "@/Celld/Application";
import {
  bindWorker,
  WorkerUnreachable,
  type CelldWorker,
} from "@/Celld/Worker";
import * as Output from "@/Output";
import { Resource } from "@/Resource";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { Stack } from "@/Stack";
import { inMemoryState } from "@/State/InMemoryState";
import { describe, expect, test } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const WorkerResource = Resource<CelldWorker>("Celld.Worker");
const AppResource = Resource<Application>("Celld.Application");
const worker = WorkerResource("Api", { main: import.meta.url });
const app = AppResource("App", {
  entrypoint: {
    workerName: "root",
    fleetId: "Cells",
    stagedManifestKey: "staged/root",
    exposed: false,
    url: "https://public.example",
  },
  workers: [],
});

const activated: ApplicationAttributes = {
  workerName: "root",
  fleetId: "Cells",
  fleetUrl: "http://activated-cells:8080",
  hostState: { subnetIds: ["subnet-app"], securityGroupIds: ["sg-app"] },
  bucket: { uri: "s3://cells" },
  url: "https://public.example",
  revision: "publication-1",
  candidates: ["candidate/root"],
};
interface Counter {
  increment: () => Effect.Effect<number, unknown>;
}

const fixture = (
  options: {
    application?: Partial<ApplicationAttributes>;
    absent?: boolean;
    workerName?: string;
    fleetId?: string;
    status?: number;
    disconnect?: boolean;
    malformed?: boolean;
    unbound?: boolean;
  } = {},
) => {
  const outputs: Record<string, Output.Output> = {};
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const bindings: unknown[] = [];
  const host = {
    Type: "AWS.Lambda.Function",
    LogicalId: "Caller",
    FQN: "Caller",
    bind: () => (data: unknown) =>
      Effect.sync(() => {
        bindings.push(data);
      }),
  };
  const values: Record<string, unknown> = {
    Api: {
      workerName: options.workerName ?? "root",
      fleetId: options.fleetId ?? "Cells",
      fleetUrl: "http://staged-only:8080",
    },
    "Api-GatewaySecret": { text: Redacted.make("root-secret") },
    ...(!options.absent
      ? { App: { ...activated, ...options.application } }
      : {}),
  };
  const state = inMemoryState();
  return {
    outputs,
    requests,
    bindings,
    values,
    layer: Layer.mergeAll(
      state,
      Layer.succeed(Self, host),
      Layer.succeed(Stack, {
        name: "bind-worker-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Layer.succeed(RuntimeContext, {
        Type: "Test.Caller",
        id: "Caller",
        env: {},
        set: (key, output) =>
          Effect.sync(() => {
            outputs[key] = output;
            return key;
          }),
        get: <T>(key: string) =>
          options.unbound
            ? Effect.succeed(undefined)
            : Output.evaluate(
                outputs[key] as Output.Output<T, never>,
                values,
              ).pipe(Effect.orDie, Effect.provide(state)),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push(request);
            if (options.disconnect) {
              return yield* Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("response lost after mutation"),
                  }),
                }),
              );
            }
            return yield* Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                new Response(options.malformed ? "not-json" : "1", {
                  status: options.status ?? 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }),
        ),
      ),
    ),
  };
};

describe("Celld external Worker binding", () => {
  test.effect(
    "depends on Application activation rather than staged Worker connectivity",
    () => {
      const f = fixture({ absent: true });
      return Effect.gen(function* () {
        const client = yield* bindWorker(app, worker);
        expect(f.requests).toHaveLength(0);
        const connection = Object.values(f.outputs).find(
          (output) => "App" in Output.resolveUpstream(output),
        );
        expect(connection).toBeDefined();
        const pending = yield* Effect.result(
          Output.evaluate(connection!, f.values),
        );
        expect(Result.isFailure(pending) && pending.failure._tag).toBe(
          "MissingSourceError",
        );
        f.values.App = activated;
        expect(yield* client.fleetUrl).toBe(activated.fleetUrl);
        expect(yield* Output.evaluate(f.bindings, f.values)).toEqual([
          { vpc: { subnetIds: ["subnet-app"], securityGroupIds: ["sg-app"] } },
        ]);
        expect(f.requests).toHaveLength(0);
      }).pipe(Effect.provide(f.layer));
    },
  );

  test.effect(
    "routes root HTTP, Worker RPC and Durable Object RPC through the activated private endpoint",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* bindWorker(app, worker);
        const application = (yield* Stack).resources.App as Application;
        const client = yield* bindWorker<Counter>(application, worker);
        yield* client.fetch(
          HttpClientRequest.post("https://ignored.example/hello?q=1").pipe(
            HttpClientRequest.bodyText("payload"),
            HttpClientRequest.setHeader("x-custom", "kept"),
          ),
        );
        expect(yield* client.increment()).toBe(1);
        expect(
          yield* client
            .durableObject<Counter>("Counter")
            .getByName("a/b")
            .increment(),
        ).toBe(1);
        yield* client
          .durableObject<Counter>("Counter")
          .getByName("a/b")
          .fetch(HttpClientRequest.get("/state?key=value"));
        expect(f.requests.map((request) => request.url)).toEqual([
          `${activated.fleetUrl}/hello?q=1`,
          `${activated.fleetUrl}/__rpc__/increment`,
          `${activated.fleetUrl}/Counter/a%2Fb/__rpc__/increment`,
          `${activated.fleetUrl}/Counter/a%2Fb/state?key=value`,
        ]);
        expect(f.requests[0].method).toBe("POST");
        expect(f.requests[0].headers["x-custom"]).toBe("kept");
        expect(f.requests[0].body._tag).toBe("Uint8Array");
        for (const request of f.requests)
          expect(request.headers["x-alchemy-fleet-secret"]).toBe("root-secret");
      }).pipe(Effect.provide(f.layer));
    },
  );

  for (const [name, options] of [
    ["non-root Worker", { workerName: "background" }],
    ["same-named Worker in another fleet", { fleetId: "OtherCells" }],
    ["Application without a revision", { application: { revision: "" } }],
    [
      "Application without a root identity",
      { application: { workerName: "" } },
    ],
  ] as const) {
    test.effect(`rejects ${name} before dispatch`, () => {
      const f = fixture(options);
      return Effect.gen(function* () {
        const client = yield* bindWorker(app, worker);
        const result = yield* Effect.exit(
          client.fetch(HttpClientRequest.get("/")),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toBeInstanceOf(WorkerUnreachable);
        expect(f.requests).toHaveLength(0);
      }).pipe(Effect.provide(f.layer));
    });
  }

  test.effect("refuses calls outside a bound runtime", () => {
    const f = fixture({ unbound: true });
    return Effect.gen(function* () {
      const client = yield* bindWorker(app, worker);
      const result = yield* Effect.result(
        client.fetch(HttpClientRequest.get("/")),
      );
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
        WorkerUnreachable,
      );
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  });

  for (const [name, options] of [
    ["connection loss after mutation", { disconnect: true }],
    ["429 response", { status: 429 }],
    ["500 response", { status: 500 }],
    ["503 response", { status: 503 }],
    ["malformed success response", { malformed: true }],
  ] as const) {
    test.effect(
      `never replays Worker or Durable Object mutations after ${name}`,
      () => {
        const f = fixture(options);
        return Effect.gen(function* () {
          const client = yield* bindWorker<Counter>(app, worker);
          const own = yield* Effect.result(client.increment());
          expect(Result.isFailure(own)).toBe(true);
          expect(f.requests).toHaveLength(1);
          const cell = yield* Effect.result(
            client
              .durableObject<Counter>("Counter")
              .getByName("one")
              .increment(),
          );
          expect(Result.isFailure(cell)).toBe(true);
          expect(f.requests).toHaveLength(2);
          yield* Effect.result(client.fetch(HttpClientRequest.post("/mutate")));
          expect(f.requests).toHaveLength(3);
        }).pipe(Effect.provide(f.layer));
      },
    );
  }
});
