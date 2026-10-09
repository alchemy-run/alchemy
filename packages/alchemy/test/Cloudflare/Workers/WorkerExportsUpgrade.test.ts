import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { encodeDurableObjectTags } from "@/Cloudflare/Workers/WorkerProvider.ts";
import * as Test from "@/Test/Alchemy";

/**
 * Upgrading a Worker that an earlier Alchemy release deployed with
 * Cloudflare's legacy `migrations` flow to the declarative `exports` flow.
 *
 * Each case first recreates the earlier release's deploy through the
 * Workers API — the same `migrations` upload and the same ownership and
 * `alchemy:dos:` tags — then deploys the same stack, stage and logical id
 * with the current provider, which is the upgrade a user runs.
 */
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// A pooled keep-alive connection stays pinned to one edge metal, which can
// keep serving the previous version; close each connection so retries can
// reach a metal with the new version.
const freshConn = HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close"));

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        Effect.flatMap(r.text, (body) =>
          r.status !== 200
            ? Effect.fail(new Error(`not ready at ${url}: ${r.status} ${body.slice(0, 300)}`))
            : body.includes(DEPLOY_PLACEHOLDER)
              ? Effect.fail(new Error("still deploying"))
              : Effect.try({
                  try: () => JSON.parse(body) as T,
                  catch: () => new Error(`non-json body: ${body.slice(0, 300)}`),
                }),
        ),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );
  });

/** A Worker hosting the given Durable Object classes; `Counter` (or the first class) stores a count. */
const hostScript = (
  classes: string[],
  counterBinding = "Counter",
) => `import { DurableObject } from "cloudflare:workers";
${classes
  .map(
    (c) => `export class ${c} extends DurableObject {
  async increment() {
    const value = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", value);
    return value;
  }
  async get() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}`,
  )
  .join("\n")}
export default {
  async fetch(request, env) {
    const stub = env.${counterBinding}.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") return Response.json({ value: await stub.increment() });
    return Response.json({ value: await stub.get() });
  },
};
`;

type Scratch = { name: string; stage: string };

/** A deterministic per-stage script name. */
const scriptNameFor = (scratch: Scratch, suffix: string) =>
  `alchemy-test-upgrade-${suffix}-${scratch.stage}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/**
 * Deploy a Worker the way an earlier Alchemy release did: a `migrations`
 * upload carrying the stack ownership tags and the packed `alchemy:dos:`
 * mapping, with its workers.dev URL enabled.
 */
const deployWithMigrations = Effect.fn(function* (params: {
  scratch: Scratch;
  logicalId: string;
  scriptName: string;
  script: string;
  bindings: { logicalId: string; className: string }[];
  migrations: workers.PutScriptRequest["metadata"]["migrations"];
}) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers.putScript({
    accountId,
    scriptName: params.scriptName,
    metadata: {
      mainModule: "main.js",
      compatibilityDate: "2026-08-31",
      bindings: params.bindings.map((b) => ({
        type: "durable_object_namespace",
        name: b.logicalId,
        className: b.className,
      })),
      migrations: params.migrations,
      tags: [
        `alchemy:stack:${params.scratch.name}`,
        `alchemy:stage:${params.scratch.stage}`,
        `alchemy:id:${params.logicalId}`,
        ...encodeDurableObjectTags(params.bindings),
      ],
    },
    files: [new File([params.script], "main.js", { type: "application/javascript+module" })],
  });
  yield* workers.createScriptSubdomain({ accountId, scriptName: params.scriptName, enabled: true });
  const { subdomain } = yield* workers.getSubdomain({ accountId });
  return `https://${params.scriptName}.${subdomain}.workers.dev`;
});

const deleteScript = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers
    .deleteScript({ accountId, scriptName, force: true })
    .pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
});

/** The script's Durable Object namespaces as `{ className: namespaceId }`. */
const namespacesOf = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const namespaces = yield* durableObjects.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.script === scriptName),
    Stream.runCollect,
  );
  return Object.fromEntries(Array.from(namespaces).map((ns) => [ns.class, ns.id]));
});

describe.concurrent(
  "Durable Object migrations → exports upgrade",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "upgrades a worker deployed with migrations, keeping its data",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "plain");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Upgraded",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(scriptName);

          const program = Cloudflare.Worker("Upgraded", {
            name: scriptName,
            script: hostScript(["Counter"]),
            env: { Counter: Cloudflare.DurableObject("Counter") },
          });

          const upgraded = yield* scratch.deploy(program);
          expect(upgraded.durableObjectNamespaces.Counter).toBe(before.Counter);
          expect(yield* namespacesOf(scriptName)).toEqual(before);
          expect((yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/get`)).value).toBe(1);
          expect(
            (yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/increment`)).value,
          ).toBe(2);

          // A routine redeploy on the exports flow is steady.
          const redeployed = yield* scratch.deploy(program);
          expect((yield* fetchJsonReady<{ value: number }>(`${redeployed.url}/get`)).value).toBe(2);
          expect(yield* namespacesOf(scriptName)).toEqual(before);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "upgrades a worker whose class was renamed under migrations",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "renamed");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Renamed",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newTag: "v1", newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const original = yield* namespacesOf(scriptName);

          // The earlier release's rename: same logical id, new class name.
          yield* deployWithMigrations({
            scratch,
            logicalId: "Renamed",
            scriptName,
            script: hostScript(["CounterV2"]),
            bindings: [{ logicalId: "Counter", className: "CounterV2" }],
            migrations: {
              oldTag: "v1",
              newTag: "v2",
              renamedClasses: [{ from: "Counter", to: "CounterV2" }],
            },
          });

          const upgraded = yield* scratch.deploy(
            Cloudflare.Worker("Renamed", {
              name: scriptName,
              script: hostScript(["CounterV2"]),
              env: { Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }) },
            }),
          );
          expect(upgraded.durableObjectNamespaces.CounterV2).toBe(original.Counter);
          expect(yield* namespacesOf(scriptName)).toEqual({ CounterV2: original.Counter });
          expect((yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "renames and deletes after upgrading apply through exports",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "lifecycle");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Lifecycle",
            scriptName,
            script: hostScript(["Counter", "Extra"]),
            bindings: [
              { logicalId: "Counter", className: "Counter" },
              { logicalId: "Extra", className: "Extra" },
            ],
            migrations: { newSqliteClasses: ["Counter", "Extra"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(scriptName);

          yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["Counter", "Extra"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
                Extra: Cloudflare.DurableObject("Extra"),
              },
            }),
          );

          // Rename Counter → CounterV2 on the exports flow.
          const renamed = yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["CounterV2", "Extra"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }),
                Extra: Cloudflare.DurableObject("Extra"),
              },
            }),
          );
          expect(renamed.durableObjectNamespaces.CounterV2).toBe(before.Counter);
          expect((yield* fetchJsonReady<{ value: number }>(`${renamed.url}/get`)).value).toBe(1);

          // Delete Extra on the exports flow.
          const deleted = yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["CounterV2"]),
              env: { Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }) },
            }),
          );
          expect(yield* namespacesOf(scriptName)).toEqual({ CounterV2: before.Counter });
          expect((yield* fetchJsonReady<{ value: number }>(`${deleted.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "the first deploy after upgrading refuses a gradual rollout until it runs at 100%",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "gradual");
          yield* deleteScript(scriptName);

          const program = (marker: string, traffic?: number) =>
            Cloudflare.Worker("Gradual", {
              name: scriptName,
              script: `${hostScript(["Counter"])}\n// ${marker}\n`,
              env: { Counter: Cloudflare.DurableObject("Counter") },
              ...(traffic !== undefined ? { version: { traffic } } : {}),
            });

          // Give the stack a recorded deployment, then put the script back on
          // the earlier release's migrations flow: the state a user has right
          // before upgrading.
          yield* scratch.deploy(program("v0"));
          yield* deleteScript(scriptName);
          yield* deployWithMigrations({
            scratch,
            logicalId: "Gradual",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const refused = yield* scratch.deploy(program("v1", 50)).pipe(Effect.flip);
          expect(String(refused)).toContain("still uses migrations");

          // At 100% the upgrade lands; gradual rollouts work again afterwards.
          yield* scratch.deploy(program("v1"));
          const gradual = yield* scratch.deploy(program("v2", 50));
          expect(gradual.workerName).toBe(scriptName);
          const { accountId } = yield* yield* CloudflareEnvironment;
          const { deployments } = yield* workers.listScriptDeployments({ accountId, scriptName });
          expect(deployments[0]?.versions.map((v) => v.percentage).sort()).toEqual([50, 50]);

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "a version worker of an upgraded parent deploys",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "version");
          yield* deleteScript(scriptName);

          yield* deployWithMigrations({
            scratch,
            logicalId: "VersionParent",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const { parent, canary } = yield* scratch.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("VersionParent", {
                name: scriptName,
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
              const canary = yield* Cloudflare.Worker("VersionCanary", {
                script: `${hostScript(["Counter"])}\n// canary\n`,
                env: { Counter: Cloudflare.DurableObject("Counter", { scriptName }) },
                version: { parent, traffic: 25 },
              });
              return { parent, canary };
            }),
          );
          expect(canary.versionOf).toBe(parent.workerName);

          const { accountId } = yield* yield* CloudflareEnvironment;
          const { deployments } = yield* workers.listScriptDeployments({ accountId, scriptName });
          expect(deployments[0]?.versions.map((v) => v.percentage).sort()).toEqual([25, 75]);

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "a preview of an upgraded worker deploys",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "preview");
          yield* deleteScript(scriptName);

          yield* deployWithMigrations({
            scratch,
            logicalId: "PreviewParent",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const { preview } = yield* scratch.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                name: scriptName,
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );
          expect(preview.previewId).toBeDefined();
          expect((yield* fetchJsonReady<{ value: number }>(`${preview.url}/increment`)).value).toBe(
            1,
          );

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );
  },
);
