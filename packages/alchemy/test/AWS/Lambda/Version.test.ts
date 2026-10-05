import { fileURLToPath } from "node:url";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import { type Version, VersionProvider } from "@/AWS/Lambda/Version.ts";
import { stripUnresolved } from "@/Diff.ts";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";

const handlerV1Path = fileURLToPath(new URL("./fixtures/version-handler-v1.ts", import.meta.url));
const handlerV2Path = fileURLToPath(new URL("./fixtures/version-handler-v2.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "publish, recover, promote, retain, list, and explicitly delete versions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        handlerPath,
        envVersion,
        reservedConcurrentExecutions,
        includeVersion = true,
        includeAlias = true,
        destroyVersion = false,
      }: {
        handlerPath: string;
        envVersion: string;
        reservedConcurrentExecutions?: number;
        includeVersion?: boolean;
        includeAlias?: boolean;
        destroyVersion?: boolean;
      }) =>
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("VersionedFn", {
            main: handlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            env: { VERSION: envVersion },
            reservedConcurrentExecutions,
          });

          const version = includeVersion
            ? yield* AWS.Lambda.Version("Release", {
                function: fn,
              }).pipe(destroy(destroyVersion))
            : undefined;

          const live =
            includeAlias && version
              ? yield* AWS.Lambda.Alias("Live", {
                  version,
                  aliasName: "live",
                })
              : undefined;

          return { fn, version, live };
        });

      // --- create ---
      const created = yield* stack.deploy(
        program({ handlerPath: handlerV1Path, envVersion: "one" }),
      );
      const v1 = created.version!;

      expect(v1.version).toMatch(/^[1-9]\d*$/);
      expect(v1.versionArn).toBe(`${v1.functionArn}:${v1.version}`);
      expect(v1.codeSha256).toBeTruthy();
      expect(v1.configSha256).toBeTruthy();
      expect(v1.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(created.live!.functionVersion).toBe(v1.version);

      const cloudV1 = yield* getVersionOrUndefined(v1.functionName, v1.version);
      expect(cloudV1?.FunctionArn).toBe(v1.versionArn);
      expect(cloudV1?.CodeSha256).toBe(v1.codeSha256);
      const countV1 = (yield* numberedVersions(v1.functionName)).length;

      // --- noop ---
      const unchanged = yield* stack.deploy(
        program({ handlerPath: handlerV1Path, envVersion: "one" }),
      );
      expect(unchanged.version!.version).toBe(v1.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countV1);

      // --- code change + alias promotion ---
      const codeChanged = yield* stack.deploy(
        program({ handlerPath: handlerV2Path, envVersion: "one" }),
      );
      const v2 = codeChanged.version!;
      expect(v2.version).not.toBe(v1.version);
      expect(v2.codeSha256).not.toBe(v1.codeSha256);
      expect(codeChanged.live!.aliasArn).toBe(created.live!.aliasArn);
      expect(codeChanged.live!.functionVersion).toBe(v2.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countV1 + 1);
      expect(yield* getVersionOrUndefined(v1.functionName, v1.version)).toBeDefined();

      // --- versioned configuration change ---
      const configChanged = yield* stack.deploy(
        program({ handlerPath: handlerV2Path, envVersion: "two" }),
      );
      const current = configChanged.version!;
      expect(current.version).not.toBe(v2.version);
      expect(current.codeSha256).toBe(v2.codeSha256);
      expect(current.configSha256).not.toBe(v2.configSha256);
      const countCurrent = (yield* numberedVersions(v1.functionName)).length;
      expect(countCurrent).toBe(countV1 + 2);

      // --- operational-only change ---
      const operational = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(operational.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countCurrent);

      // --- crash after PublishVersion, before state write ---
      // State resolves to an Effect that initializes and yields the concrete
      // state-store service.
      const state = yield* yield* State;
      const stage = stack.stage;
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state.get({ stack: stack.name, stage, fqn }).pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const versionRow = rows.find(
        (row): row is { fqn: string; row: ResourceState } =>
          isResourceState(row.row) && row.row.resourceType === "AWS.Lambda.Version",
      );
      if (!versionRow?.row.props) {
        return yield* Effect.die(
          new Error("no persisted AWS.Lambda.Version props found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: versionRow.fqn,
        value: {
          ...versionRow.row,
          props: versionRow.row.props,
          status: "creating",
          attr: undefined,
        },
      });

      const recovered = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(recovered.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countCurrent);

      // --- retain on removal and recover on re-add ---
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
          includeVersion: false,
          includeAlias: false,
        }),
      );
      expect(yield* getVersionOrUndefined(v1.functionName, current.version)).toBeDefined();

      const readded = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(readded.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countCurrent);

      // --- list + nuke posture ---
      const provider = yield* Provider.findProvider(AWS.Lambda.Version);
      expect(provider.nuke?.skip).toBe(true);
      const listed = yield* provider.list();
      expect(listed.some((version) => version.versionArn === current.versionArn)).toBe(true);
      expect(listed.every((version) => version.version !== "$LATEST")).toBe(true);

      // --- explicitly authorized, qualified-only deletion ---
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          // Force an operational-only Version update so the explicit removal
          // policy is persisted before the resource is removed.
          reservedConcurrentExecutions: 1,
          destroyVersion: true,
        }),
      );
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 1,
          includeVersion: false,
          includeAlias: false,
        }),
      );

      expect(yield* getVersionOrUndefined(v1.functionName, current.version)).toBeUndefined();
      expect(
        yield* Lambda.getFunctionConfiguration({
          FunctionName: v1.functionName,
          Qualifier: "$LATEST",
        }),
      ).toBeDefined();
      expect(yield* getVersionOrUndefined(v1.functionName, v1.version)).toBeDefined();

      yield* stack.destroy();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

const numberedVersions = Effect.fn(function* (functionName: string) {
  const response = yield* Lambda.listVersionsByFunction({
    FunctionName: functionName,
  });
  return (response.Versions ?? []).filter((version) => version.Version !== "$LATEST");
});

const getVersionOrUndefined = Effect.fn(function* (functionName: string, version: string) {
  return yield* Lambda.getFunctionConfiguration({
    FunctionName: functionName,
    Qualifier: version,
  }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));
});

// ── recovery read after an interrupted create ──────────────────────────
//
// The first `creating` checkpoint persists `stripUnresolved(node.props)`.
// When the Function is created in the same deploy, `function` (and
// `deploymentHash`, derived from it) are still unresolved Output
// expressions at that point, so they are stripped to `undefined` — and a
// JSON state store drops the keys entirely. If the deploy fails before the
// Version's own create runs, the next plan's recovery `read` receives those
// props as `olds` with no `output`. These run the REAL provider against a
// fake Lambda transport, so they need no AWS account.

const TEST_REGION = "us-east-1";
const FUNCTION_NAME = "my-fn";
const FUNCTION_ARN = `arn:aws:lambda:${TEST_REGION}:123456789012:function:${FUNCTION_NAME}`;
const VERSION_FQN = "Release";
const VERSION_INSTANCE_ID = "0123456789abcdef0123456789abcdef";

const latestConfiguration = {
  FunctionName: FUNCTION_NAME,
  FunctionArn: FUNCTION_ARN,
  Runtime: "nodejs22.x",
  Role: "arn:aws:iam::123456789012:role/my-fn-role",
  Handler: "index.handler",
  Timeout: 3,
  MemorySize: 128,
  CodeSha256: "Y29kZS1zaGEyNTY=",
  Version: "$LATEST",
  State: "Active",
  LastUpdateStatus: "Successful",
  RevisionId: "rev-1",
};

const testStack: Omit<StackSpec, "output"> = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

// Built with distilled's own helper so its signer can unwrap the Redacted
// secret (see the same note in S3/Bucket.test.ts).
const testCredentials = fromCredentials(
  { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "test-secret-key" },
  TEST_REGION,
);

type LambdaCall = { method: string; path: string };

/**
 * Minimal Lambda control plane: one function whose `$LATEST` has settled,
 * plus whatever versions `PublishVersion` has created.
 */
const fakeLambda = () => {
  const calls: LambdaCall[] = [];
  const published: Record<string, unknown>[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({ method: request.method, path: pathname });
    if (request.method === "GET" && pathname.endsWith("/configuration")) {
      return json(latestConfiguration);
    }
    if (request.method === "GET" && pathname.endsWith("/versions")) {
      return json({ Versions: [latestConfiguration, ...published] });
    }
    if (request.method === "POST" && pathname.endsWith("/versions")) {
      const body = (await request.json()) as { Description?: string };
      const version = String(published.length + 1);
      const configuration = {
        ...latestConfiguration,
        FunctionArn: `${FUNCTION_ARN}:${version}`,
        Version: version,
        Description: body.Description,
      };
      published.push(configuration);
      return json(configuration, 201);
    }
    return json({ message: `unexpected ${request.method} ${pathname}` }, 400);
  };
  return {
    calls,
    published,
    layer: FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
    ),
  };
};

const withVersionProvider = <A, E>(
  transport: Layer.Layer<HttpClient.HttpClient>,
  body: (provider: Provider.ProviderService<Version>) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Provider<Version>("AWS.Lambda.Version");
    return yield* body(provider);
  }).pipe(
    Effect.provide(VersionProvider()),
    Effect.provide(
      Layer.mergeAll(
        testCredentials,
        Layer.succeed(Region, Effect.succeed(TEST_REGION)),
        Layer.succeed(Stack, testStack),
        Layer.succeed(Stage, testStack.stage),
        NodeServices.layer,
      ).pipe(Layer.provideMerge(transport)),
    ),
  ) as Effect.Effect<A, E>;

const session = { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void };

/** Resolved props, as the engine hands them to `reconcile` once the Function exists. */
const resolvedNews = {
  function: { functionName: FUNCTION_NAME, functionArn: FUNCTION_ARN },
  deploymentHash: "deployment-hash",
};

const recoveryRead = (provider: Provider.ProviderService<Version>, olds: unknown) =>
  provider.read!({
    id: VERSION_FQN,
    fqn: VERSION_FQN,
    instanceId: VERSION_INSTANCE_ID,
    olds: olds as never,
    output: undefined,
  });

const createVersion = (provider: Provider.ProviderService<Version>) =>
  provider.reconcile({
    id: VERSION_FQN,
    fqn: VERSION_FQN,
    instanceId: VERSION_INSTANCE_ID,
    news: resolvedNews as never,
    olds: undefined,
    output: undefined,
    bindings: [] as never,
    session,
  });

describe(
  "recovery read after an interrupted create",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    // What the first `creating` checkpoint persists when the Function is
    // still being created: both props were unresolved Outputs.
    const checkpointProps = stripUnresolved({
      function: Output.literal("unresolved Function reference"),
      deploymentHash: Output.literal("unresolved code hash"),
    });

    it.effect("finds nothing when the Function reference was never resolved", () =>
      Effect.gen(function* () {
        expect(checkpointProps).toEqual({ function: undefined, deploymentHash: undefined });
        const lambda = fakeLambda();
        const recovered = yield* withVersionProvider(lambda.layer, (provider) =>
          Effect.all([
            // in-memory state store: stripped keys survive as `undefined`
            recoveryRead(provider, checkpointProps),
            // JSON state store: stripped keys are dropped
            recoveryRead(provider, JSON.parse(JSON.stringify(checkpointProps))),
          ]),
        );
        expect(recovered).toEqual([undefined, undefined]);
        // There is no function name to look a version up by.
        expect(lambda.calls).toEqual([]);
      }),
    );

    it.effect("recovers a published version when the Function reference was resolved", () =>
      Effect.gen(function* () {
        const lambda = fakeLambda();
        const [created, recovered] = yield* withVersionProvider(lambda.layer, (provider) =>
          Effect.gen(function* () {
            const created = yield* createVersion(provider);
            return [created, yield* recoveryRead(provider, resolvedNews)] as const;
          }),
        );
        expect(created.version).toBe("1");
        expect(recovered).toEqual(created);
      }),
    );

    it.effect("a re-driven create reuses the version an interrupted create published", () =>
      Effect.gen(function* () {
        // Recovery read found nothing, so the engine re-drives the create
        // with no `output`. Reconcile must find its own earlier version by
        // the ownership marker instead of publishing a second one.
        const lambda = fakeLambda();
        const [first, second] = yield* withVersionProvider(lambda.layer, (provider) =>
          Effect.all([createVersion(provider), createVersion(provider)], {
            concurrency: 1,
          }),
        );
        expect(second).toEqual(first);
        expect(lambda.published).toHaveLength(1);
      }),
    );
  },
);
