import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsInternalRanges({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsInternalRanges on a missing range fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsInternalRanges({
          name: `projects/${project}/locations/global/internalRanges/alchemy-ir-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page =
        yield* networkconnectivity.listProjectsLocationsInternalRanges({
          parent: `projects/${project}/locations/global`,
          pageSize: 100,
        });
      expect(Array.isArray(page.internalRanges ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_NCC,
)(
  "create, update, and delete an internal range",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("RangeVpc", {
            autoCreateSubnetworks: false,
          });
          const range = yield* GCP.NetworkConnectivity.InternalRange(
            "Reserved",
            {
              network: network.selfLink.as<string>(),
              usage: "FOR_VPC",
              peering: "FOR_SELF",
              ipCidrRange: "10.0.0.0/24",
              description: "range a",
              labels: { env: "test" },
            },
          );
          return { network, range };
        }),
      );

      expect(created.range.name).toContain("/internalRanges/");
      expect(created.range.name).toContain("/locations/global/");
      expect(created.range.internalRangeId).toEqual(expect.any(String));
      expect(created.range.location).toEqual("global");
      expect(created.range.project).toEqual(project);
      expect(created.range.networkName).toEqual(created.network.networkName);
      expect(created.range.usage).toEqual("FOR_VPC");
      expect(created.range.peering).toEqual("FOR_SELF");
      expect(created.range.ipCidrRange).toEqual("10.0.0.0/24");
      expect(created.range.description).toEqual("range a");
      expect(created.range.labels).toMatchObject({ env: "test" });
      expect(created.range.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkconnectivity.getProjectsLocationsInternalRanges({
          name: created.range.name,
        });
      expect(fetched.name).toEqual(created.range.name);
      expect(fetched.ipCidrRange).toEqual("10.0.0.0/24");
      expect(fetched.usage).toEqual("FOR_VPC");
      expect(fetched.peering).toEqual("FOR_SELF");
      expect(fetched.description).toEqual("range a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("RangeVpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          return yield* GCP.NetworkConnectivity.InternalRange("Reserved", {
            internalRangeId: created.range.internalRangeId,
            network: network.selfLink.as<string>(),
            usage: "FOR_VPC",
            peering: "FOR_SELF",
            ipCidrRange: "10.0.0.0/24",
            description: "range b",
            labels: { env: "prod", role: "ipam" },
          });
        }),
      );

      expect(updated.name).toEqual(created.range.name);
      expect(updated.internalRangeId).toEqual(created.range.internalRangeId);
      expect(updated.description).toEqual("range b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ipam" });
      expect(updated.ipCidrRange).toEqual("10.0.0.0/24");

      const refetched =
        yield* networkconnectivity.getProjectsLocationsInternalRanges({
          name: created.range.name,
        });
      expect(refetched.description).toEqual("range b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ipam");
      expect(refetched.ipCidrRange).toEqual("10.0.0.0/24");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.range.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
