import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { declareDurableObjectApplication } from "@alchemy.run/cloudflare/Containers/DurableObjectApplication";
import { WorkerPreviewConfigError } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as containers from "@distilled.cloud/cloudflare/containers";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as path from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const script = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

const loggingScript = `export default { fetch(request) { console.log("preview-log:" + new URL(request.url).searchParams.get("m")); return new Response("logged"); } };`;

/** Workers Logs events whose message carries `marker`, from the last 15 minutes. */
const logEvents = (accountId: string, marker: string) =>
  // Re-evaluate the timeframe per poll: rows are keyed by ingestion time.
  Effect.suspend(() =>
    workers.queryObservabilityTelemetry({
      accountId,
      queryId: "adhoc-preview-observability",
      view: "events",
      timeframe: { from: Date.now() - 15 * 60 * 1000, to: Date.now() },
      limit: 50,
      parameters: {
        filters: [
          { key: "$metadata.message", operation: "includes", type: "string", value: marker },
        ],
      },
    }),
  ).pipe(Effect.map((response) => response.events?.events ?? []));

const envScript = `export default { fetch(_request, env) { return new Response([env.LINEAR.teamIds.FIN, env.LINEAR.stateIds["FIN/Triage"], env.LINEAR.stateIds["In Review"], env.SIGNING_KEY.algorithm.namedCurve].join("|")); } };`;

const linearConfig = {
  teamIds: { FIN: "team-fin" },
  stateIds: { "FIN/Triage": "state-1", "In Review": "state-2" },
};
const envMarker = "team-fin|state-1|state-2|P-256";

const ECDSA_P256_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "I1ozXkOgIpZDp-Nn7Q3OtPapgQ_h2E8UqrtEPPqz2qY",
  y: "cJhHJik5pjNIZolyCryZu3NDb8zgL_5z4HWXdkAu-lQ",
  d: "4MwKCFxYuXltCvTaoz2RDvf_B8VRr2Ft0UtFIkcWuDI",
};

describe.concurrent(
  "Cloudflare.Worker preview",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "preview of a parent worker, updated, then deleted",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const v1 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                script: script("parent-marker-v1"),
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: script("preview-marker-v1"),
                preview: { of: parent, message: "alchemy preview test" },
              });
              return { parent, preview };
            }),
          );

          expect(v1.preview.previewOf).toEqual(v1.parent.workerName);
          expect(v1.preview.workerName).toEqual(v1.parent.workerName);
          expect(v1.preview.previewId).toBeDefined();
          expect(v1.preview.previewName).toBeDefined();
          expect(v1.preview.previewSlug).toBeDefined();
          expect(v1.preview.deploymentId).toBeDefined();
          expect(v1.preview.url).toBeDefined();
          expect(v1.preview.url).toContain(`${v1.preview.previewSlug}-${v1.parent.workerName}.`);
          expect(v1.preview.versionOf).toBeUndefined();

          yield* expectUrlContains(v1.parent.url!, "parent-marker-v1", {
            label: "parent serves its own code",
          });
          yield* expectUrlContains(v1.preview.url!, "preview-marker-v1", {
            label: "Preview URL serves the Preview's code",
          });

          const v2 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                script: script("parent-marker-v1"),
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: script("preview-marker-v2"),
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );

          expect(v2.preview.previewId).toEqual(v1.preview.previewId);
          expect(v2.preview.previewName).toEqual(v1.preview.previewName);
          expect(v2.preview.url).toEqual(v1.preview.url);
          yield* expectUrlContains(v2.preview.url!, "preview-marker-v2", {
            label: "updated Preview serves new code at the same URL",
          });
          yield* expectUrlContains(v2.parent.url!, "parent-marker-v1", {
            label: "parent is untouched by the Preview update",
          });

          yield* stack.destroy();

          const { accountId } = yield* yield* CloudflareEnvironment;
          const gone = yield* workers
            .getPreview({
              accountId,
              workerId: v1.parent.workerName,
              previewId: v1.preview.previewId!,
            })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("PreviewNotFound", () => Effect.succeed(true)),
              Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
            );
          expect(gone).toBe(true);
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "Preview records logs by default and syncs observability from props",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* yield* CloudflareEnvironment;
          const getObservability = (parent: string, previewId: string) =>
            workers
              .getPreview({ accountId, workerId: parent, previewId })
              .pipe(Effect.map((preview) => preview.observability));

          const v1 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("ObsParent", { script: loggingScript });
              const preview = yield* Cloudflare.Worker("ObsPreview", {
                script: loggingScript,
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );

          // A new Preview starts with observability off; the Worker's
          // default (logs on) must be on it before the deployment.
          const observed = yield* getObservability(v1.parent.workerName, v1.preview.previewId!);
          expect(observed?.logs?.enabled).toBe(true);
          expect(observed?.logs?.invocationLogs).toBe(true);
          expect(observed?.traces?.enabled ?? false).toBe(false);

          const marker = `${v1.preview.previewSlug}-${Date.now()}`;
          yield* expectUrlContains(`${v1.preview.url!}?m=${marker}`, "logged", {
            label: "Preview serves the logging script",
          });
          const events = yield* logEvents(accountId, marker).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (events) => events.length > 0,
              times: 24,
            }),
          );
          expect(events.length).toBeGreaterThan(0);

          const withTraces = Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("ObsParent", { script: loggingScript });
            const preview = yield* Cloudflare.Worker("ObsPreview", {
              script: loggingScript,
              preview: { of: parent },
              observability: {
                enabled: true,
                logs: { enabled: true, invocationLogs: true },
                traces: { enabled: true },
              },
            });
            return { parent, preview };
          });
          const v2 = yield* stack.deploy(withTraces);
          expect(v2.preview.previewId).toEqual(v1.preview.previewId);
          const traced = yield* getObservability(v2.parent.workerName, v2.preview.previewId!);
          expect(traced?.traces?.enabled).toBe(true);
          expect(traced?.logs?.enabled).toBe(true);

          const plan = yield* stack.plan(withTraces);
          expect(plan.resources.ObsPreview?.action).toBe("noop");

          // Removing traces from the props turns them off on the Preview.
          const v3 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("ObsParent", { script: loggingScript });
              const preview = yield* Cloudflare.Worker("ObsPreview", {
                script: loggingScript,
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );
          const untraced = yield* getObservability(v3.parent.workerName, v3.preview.previewId!);
          expect(untraced?.traces?.enabled ?? false).toBe(false);
          expect(untraced?.logs?.enabled).toBe(true);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "Preview sees json and secret_key binding payloads exactly as declared",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent, preview } = yield* stack.deploy(
            Effect.gen(function* () {
              const env = {
                LINEAR: linearConfig,
                SIGNING_KEY: Cloudflare.Workers.SecretKey("SIGNING_KEY", {
                  format: "jwk",
                  algorithm: { name: "ECDSA", namedCurve: "P-256" },
                  usages: ["sign"],
                  keyJwk: ECDSA_P256_JWK,
                }),
              };
              const parent = yield* Cloudflare.Worker("EnvParent", { script: envScript, env });
              const preview = yield* Cloudflare.Worker("EnvPreview", {
                script: envScript,
                env,
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );

          yield* expectUrlContains(parent.url!, envMarker, {
            label: "parent sees the payloads as declared",
          });
          yield* expectUrlContains(preview.url!, envMarker, {
            label: "Preview sees the same payloads as its parent",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "Preview of a Worker with a container-backed Durable Object starts its container",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const program = Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("ContainerPreviewParent", {
              script: script("container-parent"),
            });
            const shell = Cloudflare.Container("PreviewShell", {
              schedulingPolicy: "durable_object",
              image: "alpine:3.21",
            });
            const preview = yield* Cloudflare.Worker("ContainerPreview", {
              main: path.resolve(import.meta.dirname, "fixtures/preview-container/worker.ts"),
              env: {
                SANDBOX: Cloudflare.DurableObject("PreviewSandbox", { containers: [shell] }),
              },
              preview: { of: parent },
            });
            const application = yield* declareDurableObjectApplication(preview, "PreviewSandbox");
            return { parent, preview, application };
          });
          const { parent, preview, application } = yield* stack.deploy(program);

          // The recorded namespaces settle the plan: an unchanged redeploy
          // must not keep planning the healing update for older Previews.
          const settled = yield* stack.plan(program);
          const actionOf = (logicalId: string) =>
            Object.values(settled.resources).find((node) => node.resource.LogicalId === logicalId)
              ?.action;
          expect(actionOf("ContainerPreview")).toBe("noop");
          expect(actionOf("ContainerPreviewParent")).toBe("noop");

          // The Preview reports its own namespace, and the class's container
          // application is attached to it.
          const namespaceId = preview.durableObjectNamespaces.PreviewSandbox;
          expect(namespaceId).toBeDefined();
          expect(application.durableObjects?.namespaceId).toEqual(namespaceId);

          const { accountId } = yield* yield* CloudflareEnvironment;
          const observed = yield* containers.getContainerApplication({
            accountId,
            applicationId: application.applicationId,
          });
          expect(observed.durableObjects?.namespaceId).toEqual(namespaceId);

          yield* expectUrlContains(preview.url!, "alpine 3.21", {
            label: "the Preview's Durable Object starts its container",
            timeout: "180 seconds",
          });

          yield* stack.destroy();

          const applicationGone = yield* containers
            .getContainerApplication({ accountId, applicationId: application.applicationId })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(true)),
            );
          expect(applicationGone).toBe(true);
          const previewGone = yield* workers
            .getPreview({ accountId, workerId: parent.workerName, previewId: preview.previewId! })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag(["PreviewNotFound", "WorkerNotFound"], () => Effect.succeed(true)),
            );
          expect(previewGone).toBe(true);
        }).pipe(logLevel),
      { timeout: 600_000 },
    );

    test.provider(
      "rejects preview combined with version.parent",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent } = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("ComboParent", {
                script: script("combo-parent"),
              });
              return { parent };
            }),
          );

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Cloudflare.Worker("ComboParent", { script: script("combo-parent") });
                return yield* Cloudflare.Worker("ComboPreview", {
                  script: script("combo-preview"),
                  preview: { of: parent.workerName },
                  version: { parent: parent.workerName },
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerPreviewConfigError);
          expect(String(error)).toContain("preview and version cannot be set");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test.provider(
      "rejects script-level settings on a Preview worker",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent } = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("SettingsParent", {
                script: script("settings-parent"),
              });
              return { parent };
            }),
          );

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Cloudflare.Worker("SettingsParent", { script: script("settings-parent") });
                return yield* Cloudflare.Worker("SettingsPreview", {
                  script: script("settings-preview"),
                  preview: { of: parent.workerName },
                  crons: ["*/5 * * * *"],
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerPreviewConfigError);
          expect(String(error)).toContain("script-level settings");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
