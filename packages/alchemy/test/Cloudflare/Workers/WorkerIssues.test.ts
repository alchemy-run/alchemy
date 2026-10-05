import { credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import type { Worker, WorkerObservability } from "@/Cloudflare/Workers/Worker.ts";
import { LiveWorkerProvider } from "@/Cloudflare/Workers/WorkerProvider.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const observability = {
  enabled: true,
  headSamplingRate: 0.5,
  logs: { enabled: true, invocationLogs: true, headSamplingRate: 0.25, persist: true },
  traces: { enabled: true, headSamplingRate: 0.1, persist: true },
  issues: { enabled: true },
} satisfies WorkerObservability;

const scriptPath = "/accounts/account/workers/scripts/worker";

const mockReconcile = (
  desired: WorkerObservability | undefined,
  observed: boolean | null | undefined,
  missingPatches = 0,
) => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let patches = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname.replace(/^\/client\/v4/, "");
      calls.push({
        method: request.method,
        path,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      });
      let result: object;
      if (request.method === "PUT" && path === scriptPath) {
        result = {
          id: "worker",
          tag: "worker-id",
          startup_time_ms: 0,
          observability:
            observed === undefined
              ? undefined
              : observed === null
                ? null
                : { enabled: true, issues: { enabled: observed } },
        };
      } else if (request.method === "PATCH" && path === `${scriptPath}/script-settings`) {
        if (++patches <= missingPatches) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { success: false, errors: [{ code: 10007, message: "Worker not found" }] },
              { status: 404 },
            ),
          );
        }
        result = {};
      } else if (request.method === "GET" && path === `${scriptPath}/settings`) {
        // Deliberately disagree with the upload: Issues must use the PUT response.
        result = { bindings: [], tags: [], observability: { issues: { enabled: !observed } } };
      } else if (request.method === "GET" && path === `${scriptPath}/subdomain`) {
        result = { enabled: false, previews_enabled: false };
      } else {
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const reconcile = Effect.gen(function* () {
    const provider = yield* Provider.Provider<Worker>(Cloudflare.Worker.Type);
    return yield* provider.reconcile({
      id: "IssuesWorker",
      fqn: "IssuesWorker",
      instanceId: "issues-unit",
      news: {
        name: "worker",
        script: 'export default { fetch() { return new Response("ok"); } };',
        bundle: false,
        workersDev: false,
        observability: desired,
      },
      olds: undefined,
      output: undefined,
      bindings: [],
      session: { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void },
    });
  }).pipe(
    Effect.provide(LiveWorkerProvider()),
    Retry.none,
    Effect.provide(credentials({ apiToken: "test" })),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test"),
        accountId: "account",
        source: { type: "env" },
      }),
    ),
    Effect.provideService(Stack, {
      name: "worker-issues-unit",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Effect.provideService(Stage, "test"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Unexpected process spawn")),
    ),
    Effect.provide(FileSystem.layerNoop({})),
    Effect.provide(Path.layer),
  );
  return { calls, reconcile };
};

const expectedCalls = (patches: number, completed = true) => [
  { method: "GET", path: `${scriptPath}/settings` },
  { method: "PUT", path: scriptPath },
  ...Array.from({ length: patches }, () => ({
    method: "PATCH",
    path: `${scriptPath}/script-settings`,
  })),
  ...(completed
    ? [
        { method: "GET", path: `${scriptPath}/settings` },
        { method: "GET", path: `${scriptPath}/subdomain` },
      ]
    : []),
];

const requestSequence = (calls: ReturnType<typeof mockReconcile>["calls"]) =>
  calls.map(({ method, path }) => ({ method, path }));

describe("Worker Issues reconciliation", { tags: ["unit", "local"] }, () => {
  for (const [name, observed, desired, expectedPatch] of [
    [
      "restores Issues reset by upload",
      false,
      observability,
      {
        enabled: true,
        head_sampling_rate: 0.5,
        logs: { enabled: true, invocation_logs: true, head_sampling_rate: 0.25, persist: true },
        traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
        issues: { enabled: true },
      },
    ],
    [
      "disables Issues explicitly",
      true,
      { issues: { enabled: false } },
      { issues: { enabled: false } },
    ],
    ["disables Issues when omitted", true, {}, { issues: { enabled: false } }],
    ["skips an already enabled flag", true, observability, undefined],
    ["skips an already disabled flag", false, { issues: { enabled: false } }, undefined],
    ["confirms an absent flag is disabled", undefined, {}, { issues: { enabled: false } }],
    [
      "enables Issues when the upload omits observability",
      undefined,
      { issues: { enabled: true } },
      { issues: { enabled: true } },
    ],
    [
      "omits nullable upload settings from PATCH",
      false,
      {
        headSamplingRate: null,
        logs: null,
        traces: null,
        issues: { enabled: true },
      },
      { issues: { enabled: true } },
    ],
    [
      "omits nullable channel sampling from PATCH",
      false,
      {
        logs: { enabled: true, invocationLogs: true, headSamplingRate: null },
        traces: { enabled: true, headSamplingRate: null },
        issues: { enabled: true },
      },
      {
        logs: { enabled: true, invocation_logs: true },
        traces: { enabled: true },
        issues: { enabled: true },
      },
    ],
    ["skips the default disabled flag", false, undefined, undefined],
    [
      "restores default logs while disabling omitted Issues",
      true,
      undefined,
      {
        enabled: true,
        logs: { enabled: true, invocation_logs: true },
        issues: { enabled: false },
      },
    ],
    ["disables Issues when upload observability is null", null, {}, { issues: { enabled: false } }],
  ] satisfies Array<
    [string, boolean | null | undefined, WorkerObservability | undefined, object | undefined]
  >) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const { calls, reconcile } = mockReconcile(desired, observed);
        const worker = yield* reconcile;
        expect(worker.workerId).toBe("worker-id");
        expect(requestSequence(calls)).toEqual(expectedCalls(expectedPatch ? 1 : 0));
        if (expectedPatch) {
          expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
            observability: expectedPatch,
          });
        }
      }),
    );
  }

  it.live("retries registry propagation on patches without rereading settings", () =>
    Effect.gen(function* () {
      const { calls, reconcile } = mockReconcile(observability, false, 2);
      yield* reconcile;
      expect(requestSequence(calls)).toEqual(expectedCalls(3));
      const bodies = calls.filter((call) => call.method === "PATCH").map((call) => call.body);
      expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
    }),
  );

  it.live("propagates settings failures after bounded retries", () =>
    Effect.gen(function* () {
      const { calls, reconcile } = mockReconcile(observability, undefined, Infinity);
      const error = yield* reconcile.pipe(Effect.flip);
      expect(error._tag).toBe("WorkerNotFound");
      expect(requestSequence(calls)).toEqual(expectedCalls(7, false));
    }),
  );
});

const program = (config: WorkerObservability | undefined, version = "v1") =>
  Cloudflare.Worker("IssuesWorker", {
    script: `export default { fetch() { return new Response("${version}"); } };`,
    bundle: false,
    observability: config,
  });

const readIssues = Effect.fn(function* (accountId: string, scriptName: string) {
  const settings = yield* workers.getScriptSetting({ accountId, scriptName });
  const combined = yield* workers.getScriptScriptAndVersionSetting({ accountId, scriptName });
  expect(combined.observability?.issues?.enabled).toBe(settings.observability?.issues?.enabled);
  return settings.observability;
});

describe(
  "Cloudflare Worker Issues",
  { tags: ["live", "provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    test.provider("issues-only configuration survives a code redeploy", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();
        const config = { issues: { enabled: true } };
        const first = yield* stack.deploy(program(config));
        expect((yield* readIssues(accountId, first.workerName))?.issues?.enabled).toBe(true);
        yield* expectUrlContains(first.url!, "v1", { timeout: "30 seconds" });

        const updated = yield* stack.deploy(program(config, "v2"));
        expect(updated.workerName).toBe(first.workerName);
        yield* expectUrlContains(updated.url!, "v2", { timeout: "30 seconds" });
        expect((yield* readIssues(accountId, updated.workerName))?.issues?.enabled).toBe(true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(updated.workerName, accountId);
      }),
    );

    test.provider("repairs a reset flag on redeploy", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();
        const worker = yield* stack.deploy(program(observability));
        yield* workers.patchScriptSetting({
          accountId,
          scriptName: worker.workerName,
          observability: { ...observability, issues: { enabled: false } },
        });
        expect((yield* readIssues(accountId, worker.workerName))?.issues?.enabled).toBe(false);

        yield* stack.deploy(program(observability, "v2"));
        const actual = yield* readIssues(accountId, worker.workerName);
        expect(actual?.issues?.enabled).toBe(true);
        expect(actual?.logs).toMatchObject(observability.logs!);
        expect(actual?.traces).toMatchObject(observability.traces!);

        yield* workers.patchScriptSetting({
          accountId,
          scriptName: worker.workerName,
          observability: { issues: { enabled: false } },
        });
        yield* stack.deploy(program({ issues: { enabled: true } }, "v3"));
        expect((yield* readIssues(accountId, worker.workerName))?.issues?.enabled).toBe(true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }),
    );

    test.provider("version uploads and gradual rollouts preserve parent Issues", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();
        const config = { issues: { enabled: true } };
        const initial = yield* stack.deploy(program(config));

        const deployVersion = (gradual: boolean) =>
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("IssuesWorker", {
              script: `export default { fetch() { return new Response("${gradual ? "v2" : "v1"}"); } };`,
              bundle: false,
              observability: gradual ? { issues: { enabled: false } } : config,
              version: gradual ? { traffic: 0 } : undefined,
            });
            yield* Cloudflare.Worker("IssuesPreview", {
              script: 'export default { fetch() { return new Response("preview"); } };',
              bundle: false,
              version: { parent },
            });
            return parent;
          });

        const preview = yield* stack.deploy(deployVersion(false));
        expect(preview.workerName).toBe(initial.workerName);
        expect((yield* readIssues(accountId, preview.workerName))?.issues?.enabled).toBe(true);

        const gradual = yield* stack.deploy(deployVersion(true));
        expect(gradual.workerName).toBe(initial.workerName);
        expect((yield* readIssues(accountId, gradual.workerName))?.issues?.enabled).toBe(true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(initial.workerName, accountId);
      }),
    );

    test.provider("toggles and removes Issues while preserving logs and traces", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();
        const { issues: _, ...channels } = observability;
        let scriptName = "";
        const configurations: WorkerObservability[] = [
          observability,
          { ...channels, issues: { enabled: false } },
          observability,
          channels,
        ];
        for (const config of configurations) {
          const worker = yield* stack.deploy(program(config));
          if (scriptName) expect(worker.workerName).toBe(scriptName);
          scriptName = worker.workerName;
          const actual = yield* readIssues(accountId, scriptName);
          expect(actual?.issues?.enabled ?? false).toBe(config.issues?.enabled ?? false);
          expect(actual?.enabled).toBe(true);
          expect(actual?.headSamplingRate).toBe(0.5);
          expect(actual?.logs).toMatchObject(channels.logs!);
          expect(actual?.traces).toMatchObject(channels.traces!);
        }

        yield* stack.deploy(program(observability));
        const defaults = yield* stack.deploy(program(undefined));
        const actual = yield* readIssues(accountId, defaults.workerName);
        expect(actual?.issues?.enabled ?? false).toBe(false);
        expect(actual?.logs?.enabled).toBe(true);
        expect(actual?.logs?.invocationLogs).toBe(true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(scriptName, accountId);
      }),
    );
  },
);
