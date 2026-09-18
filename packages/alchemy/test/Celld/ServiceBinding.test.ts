import { Fetch, FetchBinding, type ServiceFetch } from "@/Celld/ServiceBinding";
import type { NativeFetcher } from "@/Celld/Fetcher";
import type { CelldWorker, CelldWorkerBindingContract } from "@/Celld/Worker";
import { validateStorageBindings } from "@/Celld/KV/StorageBinding";
import type { Input } from "@/Input";
import * as Output from "@/Output";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { inMemoryState } from "@/State/InMemoryState";
import { WorkerEnvironment } from "@/Workers/Worker";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { pipeArguments } from "effect/Pipeable";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const captureBindings = (bindings: Input<CelldWorkerBindingContract>[]) => {
  function bind(
    sid: Input<string>,
    data: Input<CelldWorkerBindingContract>,
  ): Effect.Effect<void>;
  function bind(
    template: TemplateStringsArray,
    ...args: any[]
  ): (data: Input<CelldWorkerBindingContract>) => Effect.Effect<void>;
  function bind(sid: Input<string> | TemplateStringsArray, ...args: any[]) {
    const capture = (data: Input<CelldWorkerBindingContract>) =>
      Effect.sync(() => {
        bindings.push(data);
      });
    return Array.isArray(sid) ? capture : capture(args[0]);
  }
  return bind;
};

const worker = (FQN = "Services/Api", fleetId = "Cells"): CelldWorker => {
  const attrs: CelldWorker["Attributes"] = {
    workerName: `physical-${FQN}`,
    fleetId,
    fleetUrl: "http://cells:8080",
    url: "http://cells:8080",
    hostState: undefined,
    deploymentId: "candidate",
    versionId: "version",
    prefix: "deploy/candidate",
    stagedManifestKey: "candidate.json",
    exposed: false,
    durableObjectClasses: {},
    migrations: [],
    code: { hash: "hash" },
  };
  const outputs = Output.fromEffect(Effect.succeed(attrs));
  return {
    Type: "Celld.Worker",
    FQN,
    LogicalId: FQN.split("/").at(-1)!,
    Namespace: undefined,
    Props: { main: "fixture.ts" },
    Attributes: attrs,
    Binding: {},
    get Providers(): never {
      throw new Error("Providers is a type-only field");
    },
    RemovalPolicy: "destroy",
    Adopt: undefined,
    Mode: undefined,
    RequiresImplementation: undefined,
    FormerFqns: undefined,
    pipe(): any {
      return pipeArguments(this, arguments);
    },
    bind: captureBindings([]),
    workerName: outputs.workerName,
    fleetId: outputs.fleetId,
    fleetUrl: outputs.fleetUrl,
    url: outputs.url,
    hostState: outputs.hostState,
    deploymentId: outputs.deploymentId,
    versionId: outputs.versionId,
    prefix: outputs.prefix,
    stagedManifestKey: outputs.stagedManifestKey,
    exposed: outputs.exposed,
    preparedContainers: outputs.preparedContainers,
    durableObjectClasses: outputs.durableObjectClasses,
    migrations: outputs.migrations,
    code: outputs.code,
  };
};

const fixture = () => {
  const env: Record<string, unknown> = {};
  const bindings: Input<CelldWorkerBindingContract>[] = [];
  const host = worker("Caller");
  host.bind = captureBindings(bindings);
  const support = Layer.mergeAll(
    Layer.succeed(WorkerEnvironment, env),
    Layer.succeed(Self, host),
    RuntimeContext.phantom,
    inMemoryState(),
  );
  return {
    env,
    bindings,
    layer: FetchBinding.pipe(Layer.provideMerge(support)),
  };
};

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type ServiceContracts = [
  Assert<Equal<Effect.Services<ReturnType<ServiceFetch>>, RuntimeContext>>,
  Assert<Equal<"increment" extends keyof ServiceFetch ? true : false, false>>,
];

const StorageMetadata = Schema.Array(
  Schema.Struct({
    resource: Schema.String,
    fleetId: Schema.String,
    fleetUrl: Schema.String,
  }),
);
const Captured = Schema.Array(
  Schema.Struct({ storageBindings: StorageMetadata }),
);

describe("Celld native service fetch", () => {
  test.effect(
    "registers the physical Worker name and fleet validation metadata",
    () => {
      const { bindings, layer } = fixture();
      return Effect.gen(function* () {
        yield* Fetch(worker());
        expect(yield* Output.evaluate(bindings, {})).toEqual([
          {
            bindings: [
              {
                type: "service",
                name: "Api",
                service: "physical-Services/Api",
              },
            ],
            storageBindings: [
              {
                resource: "Services/Api",
                fleetId: "Cells",
                fleetUrl: "http://cells:8080",
              },
            ],
          },
        ]);
        yield* Fetch(worker("Other/Api", "OtherCells"), {
          bindingName: "OtherApi",
        });
        const captured = yield* Schema.decodeUnknownEffect(Captured)(
          yield* Output.evaluate(bindings, {}),
        );
        yield* validateStorageBindings(
          { fleetId: "Cells", fleetUrl: "http://cells:8080" },
          captured[0].storageBindings,
        );
        const foreign = yield* Effect.result(
          validateStorageBindings(
            { fleetId: "Cells", fleetUrl: "http://cells:8080" },
            captured[1].storageBindings,
          ),
        );
        expect(Result.isFailure(foreign) && foreign.failure._tag).toBe(
          "Celld.StorageFleetMismatch",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "looks up the native fetcher lazily and preserves method, body, query and headers",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        const fetchApi = yield* Fetch(worker());
        let calls = 0;
        env.Api = {
          marker: "native receiver",
          fetch(this: { marker: string }, input: Request | string | URL) {
            expect(this.marker).toBe("native receiver");
            calls++;
            return Effect.runPromise(
              Effect.gen(function* () {
                const request = yield* Effect.sync(() => new Request(input));
                expect(request.method).toBe("POST");
                expect(request.url).toBe("https://service.test/path?key=value");
                expect(request.headers.get("x-example")).toBe("preserved");
                expect(yield* Effect.tryPromise(() => request.text())).toBe(
                  "payload",
                );
                return yield* Effect.sync(
                  () =>
                    new Response("native response", {
                      status: 201,
                      headers: { "x-response": "yes" },
                    }),
                );
              }),
            );
          },
        };
        const response = yield* fetchApi(
          HttpClientRequest.post("https://service.test/path").pipe(
            HttpClientRequest.setUrlParam("key", "value"),
            HttpClientRequest.setHeader("x-example", "preserved"),
            HttpClientRequest.bodyText("payload"),
          ),
        );
        expect(response.status).toBe(201);
        expect(response.headers["x-response"]).toBe("yes");
        expect(yield* response.text).toBe("native response");
        expect(calls).toBe(1);
        expect(Reflect.get(fetchApi, "increment")).toBeUndefined();
        expect(Reflect.get(fetchApi, "connect")).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "forwards Effect server requests without exporting native RPC",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        const native: NativeFetcher = {
          fetch: (input) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const request = yield* Effect.sync(() => new Request(input));
                expect(request.headers.get("authorization")).toBe(
                  "Bearer example",
                );
                return yield* Effect.sync(
                  () => new Response("forwarded", { status: 202 }),
                );
              }),
            ),
        };
        env.Api = native;
        const fetchApi = yield* Fetch(worker());
        const request = yield* Effect.sync(() =>
          HttpServerRequest.fromWeb(
            new Request("https://service.test/forward", {
              headers: { authorization: "Bearer example" },
            }),
          ),
        );
        const response = yield* fetchApi(request);
        expect(response.status).toBe(202);
        const web = HttpServerResponse.toWeb(response);
        expect(yield* Effect.tryPromise(() => web.text())).toBe("forwarded");
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "wraps missing, malformed, synchronous and rejected native fetch failures",
    () => {
      const { env, layer } = fixture();
      return Effect.gen(function* () {
        const fetchApi = yield* Fetch(worker());
        for (const native of [
          undefined,
          { fetch: 1 },
          {
            fetch: () => {
              throw "native failure";
            },
          },
          {
            fetch: () =>
              Effect.runPromise(
                Effect.fail(new Error("rejected native fetch")),
              ),
          },
        ]) {
          env.Api = native;
          const result = yield* Effect.result(
            fetchApi(HttpClientRequest.get("https://service.test/error")),
          );
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "RpcCallError",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  test.effect(
    "does not register infrastructure in the runtime phase",
    () => {
      const { env, bindings, layer } = fixture();
      return Effect.gen(function* () {
        const previous = yield* Effect.sync(
          () => globalThis.__ALCHEMY_RUNTIME__,
        );
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = true;
          });
          env.Api = {
            fetch: () =>
              Effect.runPromise(Effect.sync(() => new Response("runtime"))),
          };
          const fetchApi = yield* Fetch(worker());
          expect(
            yield* (yield* fetchApi(
              HttpClientRequest.get("https://service.test"),
            )).text,
          ).toBe("runtime");
          expect(bindings).toEqual([]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
          ),
        );
      }).pipe(Effect.provide(layer));
    },
    { exclusive: true },
  );
});
