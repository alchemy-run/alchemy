import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_COMPUTE_NODE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const region = "us-central1";

const waitUntilGone = (nodeTemplate: string) =>
  compute.getNodeTemplates({ project, region, nodeTemplate }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getNodeTemplates on a missing template fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getNodeTemplates({
          project,
          region,
          nodeTemplate: "alchemy-missing-nt",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertNodeTemplates entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertNodeTemplates({
          project,
          region,
          body: {
            name: "alchemy-nt-probe",
            description: "alchemy entitlement probe",
            nodeType: "n2-node-80-640",
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteNodeTemplates({
            project,
            region,
            nodeTemplate: "alchemy-nt-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a node template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NodeTemplate("SoleTenant", {
            region,
            nodeType: "n2-node-80-640",
            description: "prod sole tenant",
          });
        }),
      );

      expect(created.nodeTemplateName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("prod sole tenant");
      expect(created.nodeType).toEqual("n2-node-80-640");

      const fetched = yield* compute.getNodeTemplates({
        project: created.project,
        region,
        nodeTemplate: created.nodeTemplateName,
      });
      expect(fetched.name).toEqual(created.nodeTemplateName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.nodeTemplateName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
