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
  hasGcpCreds && !!process.env.GCP_TEST_MIG_RESIZE_REQUEST && !process.env.FAST;

const region = "us-central1";

const templateProps: GCP.Compute.InstanceTemplateProps = {
  machineType: "e2-micro",
  disks: [
    {
      boot: true,
      autoDelete: true,
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      diskSizeGb: 10,
    },
  ],
  networkInterfaces: [{ network: "global/networks/default" }],
};

const waitUntilGone = (
  project: string,
  instanceGroupManager: string,
  resizeRequest: string,
) =>
  compute
    .getRegionInstanceGroupManagerResizeRequests({
      project,
      region,
      instanceGroupManager,
      resizeRequest,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertRegionInstanceGroupManagerResizeRequests entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertRegionInstanceGroupManagerResizeRequests({
          project,
          region,
          instanceGroupManager: "does-not-exist",
          body: {
            name: "alchemy-rr-probe",
            description: "alchemy entitlement probe",
            resizeBy: 1,
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
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteRegionInstanceGroupManagerResizeRequests({
            project,
            region,
            instanceGroupManager: "does-not-exist",
            resizeRequest: "alchemy-rr-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a regional instance group manager resize request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate("Template", {
            ...templateProps,
          });
          const manager = yield* GCP.Compute.RegionInstanceGroupManager(
            "Manager",
            {
              region,
              instanceTemplate: template.templateName,
              targetSize: 0,
            },
          );
          const request =
            yield* GCP.Compute.RegionInstanceGroupManagerResizeRequest(
              "Burst",
              {
                region,
                instanceGroupManager: manager.managerName,
                resizeBy: 1,
                description: "queued burst",
              },
            );
          return { template, manager, request };
        }),
      );

      expect(created.request.requestName).toEqual(expect.any(String));
      expect(created.request.resizeBy).toEqual(1);
      expect(created.request.description).toEqual("queued burst");
      expect(created.request.instanceGroupManager).toEqual(
        created.manager.managerName,
      );

      const fetched =
        yield* compute.getRegionInstanceGroupManagerResizeRequests({
          project: created.request.project,
          region,
          instanceGroupManager: created.manager.managerName,
          resizeRequest: created.request.requestName,
        });
      expect(fetched.name).toEqual(created.request.requestName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.request.project,
        created.manager.managerName,
        created.request.requestName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
