import * as AWS from "@/AWS";
import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle.ts";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// The engine's ConfigProvider (`loadConfigProvider` → `fromEnv()`)
// SNAPSHOTS `process.env` at construction — seed the plan-only config value
// at module scope, before any harness stack builds its provider. The key is
// unique to this suite, so leaving it set is inert for every other test.
process.env.EFFECTFUL_PLAN_SECRET = "plan-secret";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Plan-level coverage for the AWS hybrid Function mode (collect-only): an
 * impl combined with `bundle: false` runs at plan time in the engine
 * process — bindings collect (env vars + IAM policy statements), the
 * resolved props are stamped with `runtimeDelivery`, and the prebuilt
 * framework artifact ships untouched — without any build or cloud call.
 * Nothing in this file deploys.
 */

const mountedMain = new URL(
  "./fixtures/effectful-site/index.mjs",
  import.meta.url,
).pathname;
const unmountedMain = new URL(
  "./fixtures/effectful-site-unmounted/index.mjs",
  import.meta.url,
).pathname;

const nodeOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource?.LogicalId === logicalId,
  );

/** The defect of a died plan, if any. */
const defectOf = (exit: Exit.Exit<any, any>): any => {
  if (!Exit.isFailure(exit)) return undefined;
  const die = exit.cause.reasons.find(Cause.isDieReason);
  return die?.defect;
};

/** The typed failure of a failed exit, if any. */
const failureOf = (exit: Exit.Exit<any, any>): any => {
  if (!Exit.isFailure(exit)) return undefined;
  const fail = exit.cause.reasons.find(
    (reason: any) => reason._tag === "Fail",
  ) as any;
  return fail?.error;
};

const okFetch = {
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
};

describe.concurrent("effectful Function plan (collect-only)", () => {
  test.provider(
    "impl + bundle:false stamps external delivery and collects the DynamoDB binding",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const table = yield* AWS.DynamoDB.Table("PlanVisits", {
              partitionKey: "pk",
              attributes: { pk: "S" },
            });
            yield* AWS.Lambda.Function(
              "SiteServer",
              {
                main: mountedMain,
                handler: "handler",
                bundle: false,
                functionUrl: {
                  authType: "NONE",
                  invokeMode: "RESPONSE_STREAM",
                },
              },
              Effect.gen(function* () {
                const getItem = yield* AWS.DynamoDB.GetItem(table);
                void getItem;
                return okFetch;
              }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
            );
          }),
        );

        const site = nodeOf(plan, "SiteServer");
        expect(site).toBeDefined();
        expect(site.action).toBe("create");

        // Collect-only stamp: AWS has no alchemy-owned bundler seam by
        // default, so the tier default is the explicit mount.
        expect(site.props.runtimeDelivery).toBe("external");
        // The framework artifact props are untouched — no effect-bundling
        // props, `main`/`handler` survive so the Lambda Handler string
        // stays `<mainBasename>.handler`.
        expect(site.props.bundle).toBe(false);
        expect(site.props.main).toBe(mountedMain);
        expect(site.props.handler).toBe("handler");
        expect(site.props.isExternal).toBeUndefined();

        // The impl's init ran at plan time: the DynamoDB capability
        // collected an IAM policy row on the Function through the binding
        // channel.
        const statements = (site.bindings ?? []).flatMap(
          (binding: any) => binding.data?.policyStatements ?? [],
        );
        expect(
          statements.some((statement: any) =>
            (statement.Action ?? []).includes("dynamodb:GetItem"),
          ),
        ).toBe(true);

        // ... and the table's physical name rode the env channel (the
        // runtime client reads it back from the Lambda environment).
        const envKeys = Object.keys(site.props.env ?? {});
        expect(envKeys.some((key) => key.includes("tableName"))).toBe(true);

        // ... and the bound table resource itself is planned.
        const tableNode = nodeOf(plan, "PlanVisits");
        expect(tableNode).toBeDefined();
        expect(tableNode.action).toBe("create");
      }),
  );

  test.provider(
    "Config reads auto-bind into props.env (packEnvValue markers)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function(
              "ConfigServer",
              { main: mountedMain, handler: "handler", bundle: false },
              Effect.gen(function* () {
                const secret = yield* Config.string("EFFECTFUL_PLAN_SECRET");
                void secret;
                return okFetch;
              }),
            );
          }),
        );
        const site = nodeOf(plan, "ConfigServer");
        // The intercepting ConfigProvider bound the read onto the
        // RuntimeContext as an env var (an Output that packs the value as
        // a `{"_tag":"Redacted","value":...}` marker for the runtime
        // `reifyBoundConfigProvider` round-trip).
        expect(
          Object.keys(site.props.env ?? {}).includes("EFFECTFUL_PLAN_SECRET"),
        ).toBe(true);
      }),
  );

  test.provider(
    "composite tier default (wrapper) rides through; takeover:false forces external",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function(
              "WrapperTier",
              {
                main: mountedMain,
                handler: "handler",
                bundle: false,
                // Internal prop a Website composite stamps for its
                // auto-inject tier (generated wrapper entry).
                runtimeDelivery: "wrapper",
              },
              Effect.succeed(okFetch),
            );
            yield* AWS.Lambda.Function(
              "ExplicitTier",
              {
                main: mountedMain,
                handler: "handler",
                bundle: false,
                runtimeDelivery: "wrapper",
                server: { takeover: false },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        expect(nodeOf(plan, "WrapperTier").props.runtimeDelivery).toBe(
          "wrapper",
        );
        expect(nodeOf(plan, "ExplicitTier").props.runtimeDelivery).toBe(
          "external",
        );
      }),
  );

  test.provider("invalid server.routes fail fast at plan", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function(
              "BadRoutes",
              {
                main: mountedMain,
                handler: "handler",
                bundle: false,
                server: { routes: ["api/*"] },
              },
              Effect.succeed(okFetch),
            );
          }),
        ),
      );
      expect(defectOf(exit)?._tag).toBe("FunctionServerRoutingError");
    }),
  );

  test.provider(
    "non-fetch listeners (event sources) are rejected on external delivery",
    (stack) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          stack.plan(
            Effect.gen(function* () {
              const queue = yield* AWS.SQS.Queue("PlanJobs", {});
              yield* AWS.Lambda.Function(
                "EventedServer",
                { main: mountedMain, handler: "handler", bundle: false },
                Effect.gen(function* () {
                  yield* AWS.SQS.consumeQueueMessages(queue, (records) =>
                    records.pipe(
                      Stream.runForEach((record) => Effect.log(record.body)),
                    ),
                  );
                  return okFetch;
                }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
              );
            }),
          ),
        );
        const defect = defectOf(exit);
        expect(defect?._tag).toBe("FunctionExportsDeliveryError");
        expect(defect?.listeners).toBe(1);
      }),
  );

  test.provider(
    "classic effect Function (bundled) is untouched: no stamp",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function(
              "ClassicEffect",
              { main: mountedMain },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "ClassicEffect");
        expect(site.props.runtimeDelivery).toBeUndefined();
        expect(site.props.isExternal).toBeUndefined();
      }),
  );

  test.provider(
    "no-impl bundle:false arm is untouched: external, no stamp",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function("PlainPrebuilt", {
              main: mountedMain,
              handler: "handler",
              bundle: false,
            });
          }),
        );
        const site = nodeOf(plan, "PlainPrebuilt");
        expect(site.action).toBe("create");
        expect(site.props.isExternal).toBe(true);
        expect(site.props.runtimeDelivery).toBeUndefined();
      }),
  );
});

describe.concurrent("prebuilt artifact + sentinel scan (bundler unit)", () => {
  const bundler = Effect.provide(makeFunctionBundler, NodeServices.layer);

  it.effect("external delivery without a serve mount fails the handshake", () =>
    Effect.gen(function* () {
      const { bundleCode } = yield* bundler;
      const exit = yield* Effect.exit(
        bundleCode("SiteServer", {
          main: unmountedMain,
          handler: "handler",
          bundle: false,
          runtimeDelivery: "external",
        } as any).pipe(Effect.provide(NodeServices.layer)),
      );
      const failure = failureOf(exit);
      expect(failure?._tag).toBe("MissingServeMountError");
      expect(String(failure?.message)).toContain("alchemy/serve");
    }),
  );

  it.effect("server.verify: false skips the handshake", () =>
    Effect.gen(function* () {
      const { bundleCode } = yield* bundler;
      const result = yield* bundleCode("SiteServer", {
        main: unmountedMain,
        handler: "handler",
        bundle: false,
        runtimeDelivery: "external",
        server: { verify: false },
      } as any).pipe(Effect.provide(NodeServices.layer));
      expect(result.identityHash.length).toBeGreaterThan(0);
    }),
  );

  it.effect(
    "wrapper delivery is never scanned and the prebuilt artifact ships byte-for-byte",
    () =>
      Effect.gen(function* () {
        const { bundleCode } = yield* bundler;
        // The wrapper tier generates the mounting entry itself — no scan
        // even over an unmounted directory.
        const wrapper = yield* bundleCode("SiteServer", {
          main: unmountedMain,
          handler: "handler",
          bundle: false,
          runtimeDelivery: "wrapper",
        } as any).pipe(Effect.provide(NodeServices.layer));
        expect(wrapper.identityHash.length).toBeGreaterThan(0);

        // A mounted artifact passes the external scan, and the collect-only
        // branch changes NOTHING about the shipped bytes: identity hash and
        // archive are identical to a plain `bundle: false` packaging.
        const plain = yield* bundleCode("SiteServer", {
          main: mountedMain,
          handler: "handler",
          bundle: false,
        } as any).pipe(Effect.provide(NodeServices.layer));
        const scanned = yield* bundleCode("SiteServer", {
          main: mountedMain,
          handler: "handler",
          bundle: false,
          runtimeDelivery: "external",
        } as any).pipe(Effect.provide(NodeServices.layer));
        expect(scanned.identityHash).toBe(plain.identityHash);
        const plainArchive = yield* plain.buildArchive.pipe(
          Effect.provide(NodeServices.layer),
        );
        const scannedArchive = yield* scanned.buildArchive.pipe(
          Effect.provide(NodeServices.layer),
        );
        expect(
          Buffer.compare(
            Buffer.from(scannedArchive.archive),
            Buffer.from(plainArchive.archive),
          ),
        ).toBe(0);
      }),
  );
});
