import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as observability from "@distilled.cloud/gcp/observability_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const projectName = `projects/${project}`;

// Observability API is entitlement-gated on the default testing project.
// Live create returns Forbidden: "Observability API has not been used in
// project alchemy-gcp-testing-83661 before or it is disabled." Set
// GCP_TEST_OBSERVABILITY=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_OBSERVABILITY === "1";
const runLifecycle = hasGcpCreds && entitled;

const waitUntilGone = (name: string) =>
  observability.getProjectsLocationsTraceScopes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTraceScopes on a missing scope fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        observability.getProjectsLocationsTraceScopes({
          name: `projects/${project}/locations/global/traceScopes/alchemy-missing-scope`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("Observability API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete a trace scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.TraceScope("App", {
            resourceNames: [projectName],
            description: "application traces",
          });
        }),
      );

      expect(created.traceScopeId).toEqual(expect.any(String));
      expect(created.traceScopeId).not.toEqual("_Default");
      expect(created.location).toEqual("global");
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/global/traceScopes/${created.traceScopeId}`,
      );
      expect(created.resourceNames).toEqual([projectName]);
      expect(created.description).toEqual("application traces");

      const fetched = yield* observability.getProjectsLocationsTraceScopes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.resourceNames).toEqual([projectName]);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("application traces");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.TraceScope("App", {
            traceScopeId: created.traceScopeId,
            resourceNames: [projectName],
            description: "all application traces",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.traceScopeId).toEqual(created.traceScopeId);
      expect(updated.description).toEqual("all application traces");
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate =
        yield* observability.getProjectsLocationsTraceScopes({
          name: created.name,
        });
      expect(fetchedUpdate.description).toContain("all application traces");

      const last = created.traceScopeId.at(-1) ?? "a";
      const nextTraceScopeId = `${created.traceScopeId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.TraceScope("App", {
            traceScopeId: nextTraceScopeId,
            resourceNames: [projectName],
            description: "replaced scope",
          });
        }),
      );

      expect(replaced.traceScopeId).not.toEqual(created.traceScopeId);
      expect(replaced.name).toEqual(
        `projects/${project}/locations/global/traceScopes/${replaced.traceScopeId}`,
      );
      expect(replaced.description).toEqual("replaced scope");

      const fetchedReplacement =
        yield* observability.getProjectsLocationsTraceScopes({
          name: replaced.name,
        });
      expect(fetchedReplacement.name).toEqual(replaced.name);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
