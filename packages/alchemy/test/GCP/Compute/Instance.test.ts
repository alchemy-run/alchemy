import * as GCP from "@/GCP";
import * as Provider from "@/Provider";
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

const waitUntilGone = (project: string, zone: string, instance: string) =>
  compute.getInstances({ project, zone, instance }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider("diffs identity settings against the observed VM", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(GCP.Compute.Instance);
    const olds: GCP.Compute.InstanceProps = {
      zone: "us-central1-a",
      machineType: "e2-micro",
    };
    const input = {
      id: "Vm",
      fqn: "Vm",
      instanceId: "instance",
      olds,
      oldBindings: [],
      newBindings: [],
      output: {
        instanceName: "vm",
        zone: "us-central1-a",
        machineType: "e2-micro",
        serviceAccount: "123456-compute@developer.gserviceaccount.com",
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        shieldedInstanceConfig: {
          enableSecureBoot: false,
          enableVtpm: true,
          enableIntegrityMonitoring: true,
        },
      },
    } as const;

    // Declaring what already runs is a no-op.
    const declaredObserved = yield* provider.diff!({
      ...input,
      news: {
        ...olds,
        serviceAccount: "default",
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        shieldedInstanceConfig: { enableVtpm: true },
      },
    } as never);
    expect(declaredObserved).toBeUndefined();

    // Changing an identity setting still replaces (the API only allows it on
    // a stopped VM).
    const secureBoot = yield* provider.diff!({
      ...input,
      news: { ...olds, shieldedInstanceConfig: { enableSecureBoot: true } },
    } as never);
    expect(secureBoot).toEqual({ action: "replace", deleteFirst: true });

    const otherAccount = yield* provider.diff!({
      ...input,
      news: { ...olds, serviceAccount: "runner@p.iam.gserviceaccount.com" },
    } as never);
    expect(otherAccount).toEqual({ action: "replace", deleteFirst: true });
  }),
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            zone: "us-central1-a",
            machineType: "e2-micro",
            bootDiskType: "pd-balanced",
            labels: { env: "test" },
            tags: ["alchemy-test"],
            metadata: { role: "test" },
            associatePublicIp: false,
            provisioningModel: "STANDARD",
            onHostMaintenance: "MIGRATE",
            serviceAccount: "default",
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            shieldedInstanceConfig: {
              enableIntegrityMonitoring: true,
              enableSecureBoot: true,
              enableVtpm: true,
            },
          });
        }),
      );

      expect(created.instanceName).toEqual(expect.any(String));
      expect(created.zone).toEqual("us-central1-a");
      expect(created.machineType).toEqual("e2-micro");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.tags).toEqual(["alchemy-test"]);
      expect(created.metadata).toMatchObject({ role: "test" });
      expect(created.scheduling?.provisioningModel).toEqual("STANDARD");
      expect(created.scheduling?.onHostMaintenance).toEqual("MIGRATE");
      expect(created.serviceAccount).toEqual(expect.any(String));
      expect(created.oauthScopes).toContain(
        "https://www.googleapis.com/auth/cloud-platform",
      );
      expect(created.shieldedInstanceConfig).toMatchObject({
        enableIntegrityMonitoring: true,
        enableSecureBoot: true,
        enableVtpm: true,
      });

      const fetched = yield* compute.getInstances({
        project: created.project,
        zone: created.zone,
        instance: created.instanceName,
      });
      expect(fetched.name).toEqual(created.instanceName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.tags?.items).toEqual(["alchemy-test"]);
      expect(fetched.scheduling?.provisioningModel).toEqual("STANDARD");
      expect(fetched.serviceAccounts?.[0]?.email).toEqual(expect.any(String));
      expect(fetched.shieldedInstanceConfig).toMatchObject({
        enableIntegrityMonitoring: true,
        enableSecureBoot: true,
        enableVtpm: true,
      });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            instanceName: created.instanceName,
            zone: "us-central1-a",
            machineType: "e2-micro",
            bootDiskType: "pd-balanced",
            labels: { env: "prod", role: "web" },
            tags: ["alchemy-prod"],
            metadata: { role: "prod" },
            description: "alchemy instance update",
            associatePublicIp: false,
            provisioningModel: "STANDARD",
            onHostMaintenance: "MIGRATE",
            automaticRestart: false,
            serviceAccount: "default",
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            shieldedInstanceConfig: {
              enableIntegrityMonitoring: true,
              enableSecureBoot: true,
              enableVtpm: true,
            },
          });
        }),
      );

      expect(updated.instanceName).toEqual(created.instanceName);
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });
      expect(updated.tags).toEqual(["alchemy-prod"]);
      expect(updated.metadata).toMatchObject({ role: "prod" });
      expect(updated.scheduling?.automaticRestart).toEqual(false);
      expect(updated.scheduling?.onHostMaintenance).toEqual("MIGRATE");

      const refetched = yield* compute.getInstances({
        project: created.project,
        zone: created.zone,
        instance: created.instanceName,
      });
      expect(refetched.id).toEqual(created.instanceId);
      expect(refetched.scheduling?.automaticRestart).toEqual(false);
      expect(refetched.description).toEqual("alchemy instance update");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.zone,
        created.instanceName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
