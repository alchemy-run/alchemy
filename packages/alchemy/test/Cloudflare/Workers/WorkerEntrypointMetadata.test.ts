import { AlchemyContext } from "@/AlchemyContext.ts";
import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "@/Artifacts.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { type Worker, type WorkerProps } from "@/Cloudflare/Workers/Worker.ts";
import { makeEffectVirtualEntry } from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import {
  validateWorkerEntrypoints,
  workerEntrypointMetadata,
} from "@/Cloudflare/Workers/WorkerEntrypointMetadata.ts";
import {
  LiveWorkerProvider,
  resolveWorkerMetadataHash,
} from "@/Cloudflare/Workers/WorkerProvider.ts";
import { Provider } from "@/Provider.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { InstanceId } from "@/InstanceId.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { sha256 } from "@/Util/sha256.ts";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const script = `export default class Gateway {}; export class CachedPublishedRead {}; export class CachedDocumentList {}; export class UncachedRead {};`;
const entrypoints = {
  CachedPublishedRead: { cache: { enabled: true, crossVersionCache: false } },
  CachedDocumentList: { cache: { enabled: true, crossVersionCache: false } },
};
const props: WorkerProps = {
  name: "worker",
  script,
  cache: { enabled: false },
  entrypoints,
  workersDev: false,
};
const stack = {
  name: "test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};
const identity = {
  id: "Worker",
  fqn: "Worker",
  instanceId: "0123456789abcdef0123456789abcdef",
};
const base = Layer.mergeAll(
  PlatformServices,
  Layer.succeed(Stack, stack),
  Layer.succeed(Stage, stack.stage),
  Layer.succeed(InstanceId, identity.instanceId),
  Layer.succeed(AlchemyContext, {
    dotAlchemy: "/tmp/.alchemy-entrypoint-test",
    dev: false,
    adopt: false,
  }),
  Layer.sync(Artifacts, () =>
    makeScopedArtifacts(createArtifactStore(), "Worker"),
  ),
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("test-token"),
      accountId: "test-account",
      source: { type: "stored" },
    }),
  ),
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
  ),
);
const noNetwork = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Unexpected HTTP request")),
);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LiveWorkerProvider()),
    Effect.provide(base),
    Effect.provide(noNetwork),
    Effect.scoped,
  );
const validate = (
  config: Parameters<typeof validateWorkerEntrypoints>[0],
  content = script,
) =>
  validateWorkerEntrypoints(config, [{ path: "main.js", content }]).pipe(
    Effect.provide(PlatformServices),
  );

describe("Worker entrypoint metadata", () => {
  it("lowers the DX shape without changing worker-wide cache", () => {
    expect(workerEntrypointMetadata(entrypoints)).toEqual({
      CachedPublishedRead: {
        type: "worker",
        cache: { enabled: true, crossVersionCache: false },
      },
      CachedDocumentList: {
        type: "worker",
        cache: { enabled: true, crossVersionCache: false },
      },
    });
    expect(props.cache).toEqual({ enabled: false });
    expect(workerEntrypointMetadata(undefined)).toBeUndefined();
    expect(workerEntrypointMetadata({})).toBeUndefined();
  });
  it("preserves default, omitted cache, and special export names verbatim", () => {
    const metadata = workerEntrypointMetadata(
      Object.fromEntries([
        ["default", { cache: { enabled: false } }],
        ["__proto__", {}],
        ["some-name", {}],
      ]),
    );
    expect(metadata?.default).toEqual({
      type: "worker",
      cache: { enabled: false },
    });
    expect(Object.hasOwn(metadata!, "__proto__")).toBe(true);
    expect(metadata?.["some-name"]).toEqual({
      type: "worker",
      cache: undefined,
    });
  });
  it.effect("accepts the default and named exports", () =>
    validate({ entrypoints: { default: {}, ...entrypoints } }),
  );
  it.effect(
    "keeps internal DO and Workflow exports intact and rejects cache collisions",
    () =>
      Effect.gen(function* () {
        const exports: NonNullable<WorkerProps["exports"]> = {
          Counter: {
            kind: "durableObject",
            constructor: Effect.succeed(Effect.succeed({})),
            services: Context.empty(),
          },
          Job: {
            kind: "workflow",
            make: () => Effect.succeed(() => Effect.void),
          },
        };
        const content = makeEffectVirtualEntry(exports, stack)("./worker.ts");
        yield* validate(
          { exports, entrypoints: { default: { cache: { enabled: false } } } },
          content,
        );
        for (const name of ["Counter", "Job"]) {
          const error = yield* validate(
            { exports, entrypoints: { [name]: {} } },
            content,
          ).pipe(Effect.flip);
          expect(error.message).toContain("Durable Object or Workflow export");
        }
        expect(Object.keys(exports)).toEqual(["Counter", "Job"]);
      }),
  );
  for (const config of [
    { preview: { of: "parent" } },
    { namespace: "dispatch" },
  ] as const) {
    it.effect(
      `rejects unsupported ${"preview" in config ? "preview" : "dispatch"} uploads`,
      () =>
        Effect.gen(function* () {
          const error = yield* validate({
            ...config,
            entrypoints: { default: {} },
          }).pipe(Effect.flip);
          expect(error.message).toContain(
            "do not yet support this field in the SDK",
          );
        }),
    );
  }
  it.effect("rejects an unknown key with the available exports", () =>
    Effect.gen(function* () {
      const error = yield* validate({ entrypoints: { Missing: {} } }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("WorkerEntrypointConfigError");
      expect(error.message).toContain("'Missing'");
      expect(error.message).toContain(
        "CachedDocumentList, CachedPublishedRead, UncachedRead, default",
      );
    }),
  );
  it.effect("uses export aliases rather than local class names", () =>
    Effect.gen(function* () {
      const content = `class Inner {}; export { Inner as Public, Inner as default };`;
      yield* validate({ entrypoints: { Public: {}, default: {} } }, content);
      const error = yield* validate(
        { entrypoints: { Inner: {} } },
        content,
      ).pipe(Effect.flip);
      expect(error.message).toContain("Known exports: Public, default");
    }),
  );
  it.effect(
    "follows star re-exports in prebuilt modules without inheriting default",
    () =>
      validateWorkerEntrypoints({ entrypoints: { Public: {} } }, [
        { path: "main.js", content: `export * from './inner.js';` },
        {
          path: "inner.js",
          content: `export class Public {}; export default {};`,
        },
      ]).pipe(Effect.provide(PlatformServices)),
  );
  it.effect("rejects missing re-export modules with a clear limitation", () =>
    Effect.gen(function* () {
      const error = yield* validate(
        { entrypoints: { Public: {} } },
        `export * from './missing.js';`,
      ).pipe(Effect.flip);
      expect(error.message).toContain("Include it in the uploaded bundle");
    }),
  );
  it.effect("rejects named Effect entrypoints that are not generated", () =>
    Effect.gen(function* () {
      const content = makeEffectVirtualEntry({}, stack)("./worker.ts");
      yield* validate({ entrypoints: { default: {} } }, content);
      const error = yield* validate(
        { entrypoints: { Inner: {} } },
        content,
      ).pipe(Effect.flip);
      expect(error.message).toContain("Known exports: default");
    }),
  );
  it.effect("rejects assets-only entrypoints", () =>
    Effect.gen(function* () {
      const error = yield* validateWorkerEntrypoints(
        { entrypoints: { default: {} } },
        undefined,
      ).pipe(Effect.flip);
      expect(error.message).toContain("Known exports: (none)");
    }).pipe(Effect.provide(PlatformServices)),
  );

  for (const [label, news, action] of [
    ["unchanged", props, "noop"],
    [
      "enabled changed",
      {
        ...props,
        entrypoints: {
          ...entrypoints,
          CachedPublishedRead: { cache: { enabled: false } },
        },
      },
      "update",
    ],
    [
      "cross-version changed",
      {
        ...props,
        entrypoints: {
          ...entrypoints,
          CachedPublishedRead: {
            cache: { enabled: true, crossVersionCache: true },
          },
        },
      },
      "update",
    ],
    [
      "entry removed",
      {
        ...props,
        entrypoints: { CachedDocumentList: entrypoints.CachedDocumentList },
      },
      "update",
    ],
    ["all removed", { ...props, entrypoints: undefined }, "update"],
  ] as const) {
    it.effect(`plans ${action} when ${label}`, () =>
      provide(
        Effect.gen(function* () {
          const provider = yield* Provider<Worker>("Cloudflare.Worker");
          const metadata = yield* resolveWorkerMetadataHash({
            props,
            bindings: [],
            accountId: "test-account",
            stack,
          });
          const bundle = yield* sha256(script);
          const output: Worker["Attributes"] = {
            workerId: "1234567890abcdef1234567890abcdef",
            workerName: "worker",
            accountId: "test-account",
            logpush: undefined,
            url: undefined,
            tags: undefined,
            durableObjectNamespaces: {},
            urls: [],
            domain: undefined,
            routes: [],
            crons: [],
            namespace: undefined,
            hash: {
              metadata,
              bundle,
              assets: undefined,
              input: undefined,
              additionalWorkspaces: undefined,
            },
          };
          const diff = yield* provider.diff!({
            ...identity,
            olds: props,
            news,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff?.action).toBe(action);
        }),
      ),
    );
  }
  it.effect(
    "rejects a new Worker's unknown key during plan-time read before HTTP",
    () =>
      provide(
        Effect.gen(function* () {
          const provider = yield* Provider<Worker>("Cloudflare.Worker");
          const error = yield* provider.read!({
            ...identity,
            olds: { ...props, entrypoints: { Missing: {} } },
            output: undefined,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("WorkerEntrypointConfigError");
          expect(error.message).toContain("Missing");
        }),
      ),
  );
  for (const bundle of [true, false]) {
    it.effect(
      `rejects an unknown export of an external main with bundle=${bundle} during planning`,
      () =>
        provide(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "alchemy-entrypoints-",
            });
            yield* fs.writeFileString(path.join(root, "package.json"), "{}");
            const main = path.join(root, "worker.js");
            yield* fs.writeFileString(main, script);
            const provider = yield* Provider<Worker>("Cloudflare.Worker");
            const error = yield* provider.read!({
              ...identity,
              output: undefined,
              olds: {
                ...props,
                script: undefined,
                main,
                bundle,
                isExternal: true,
                entrypoints: { Typo: {} },
              },
            }).pipe(Effect.flip);
            expect(error._tag).toBe("WorkerEntrypointConfigError");
            expect(error.message).toContain("'Typo'");
            expect(error.message).toContain("CachedPublishedRead");
          }),
        ),
    );
  }

  for (const [label, version] of [
    ["script PUT", undefined],
    ["gradual rollout", { traffic: 10 }],
    ["parent version", { parent: "parent", traffic: 0 }],
  ] as const) {
    for (const [scenario, configured, expectedExports] of [
      [
        "named overrides",
        entrypoints,
        {
          CachedPublishedRead: {
            type: "worker",
            cache: { enabled: true, cross_version_cache: false },
          },
          CachedDocumentList: {
            type: "worker",
            cache: { enabled: true, cross_version_cache: false },
          },
        },
      ],
      [
        "default override",
        { default: { cache: { enabled: true, crossVersionCache: true } } },
        {
          default: {
            type: "worker",
            cache: { enabled: true, cross_version_cache: true },
          },
        },
      ],
      ["removed overrides", undefined, undefined],
      ["omitted cache", { default: {} }, { default: { type: "worker" } }],
    ] as const) {
      it.effect(
        `encodes ${scenario} through the provider's ${label} upload`,
        () => {
          let captured:
            | { method: string; url: string; metadata: string }
            | undefined;
          const client = HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.body._tag === "FormData") {
                const metadata = request.body.formData.get("metadata");
                expect(typeof metadata).toBe("string");
                captured = {
                  method: request.method,
                  url: request.url,
                  metadata: String(metadata),
                };
                return yield* Effect.die("Upload captured");
              }
              expect(request.method).toBe("GET");
              expect(request.url).toMatch(/\/(settings|subdomain)$/);
              return yield* Effect.sync(() =>
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      success: true,
                      errors: [],
                      messages: [],
                      result: request.url.endsWith("/subdomain")
                        ? {
                            subdomain: "test",
                            enabled: false,
                            previews_enabled: false,
                          }
                        : { bindings: [], tags: [], logpush: false },
                    }),
                    { headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }),
          );
          return Effect.gen(function* () {
            const provider = yield* Provider<Worker>("Cloudflare.Worker");
            const result = yield* provider
              .reconcile({
                ...identity,
                news: {
                  ...props,
                  entrypoints: configured,
                  version,
                  ...(label === "parent version"
                    ? { name: undefined, workersDev: undefined }
                    : {}),
                },
                olds: props,
                bindings: [],
                output: {
                  workerId: "1234567890abcdef1234567890abcdef",
                  workerName: "worker",
                  accountId: "test-account",
                  logpush: undefined,
                  url: undefined,
                  tags: undefined,
                  durableObjectNamespaces: {},
                  urls: [],
                  domain: undefined,
                  routes: [],
                  crons: [],
                  namespace: undefined,
                  hash: {
                    bundle: "previous",
                    assets: undefined,
                    input: undefined,
                    additionalWorkspaces: undefined,
                  },
                },
                session: { ...noopSession, note: () => Effect.void },
              })
              .pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
            expect(captured).toBeDefined();
            expect(captured?.method).toBe(version ? "POST" : "PUT");
            expect(captured?.url).toContain(
              version ? "/versions" : "/scripts/worker",
            );
            const metadata = JSON.parse(captured!.metadata);
            expect(metadata.cache_options).toEqual({ enabled: false });
            expect(metadata.exports).toEqual(expectedExports);
            if (expectedExports === undefined) {
              expect(Object.hasOwn(metadata, "exports")).toBe(false);
            }
          }).pipe(
            Effect.provide(LiveWorkerProvider()),
            Effect.provide(base),
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.scoped,
          );
        },
      );
    }
  }
});
