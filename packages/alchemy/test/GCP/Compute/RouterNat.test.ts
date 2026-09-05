import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const infrastructure = (includeNat: boolean, enableLogging = false) =>
  Effect.gen(function* () {
    const network = yield* GCP.Compute.Network("Vpc", {
      autoCreateSubnetworks: false,
    });
    const subnet = yield* GCP.Compute.Subnetwork("Private", {
      network: network.networkName,
      region: "us-central1",
      ipCidrRange: "10.91.0.0/24",
      privateIpGoogleAccess: true,
    });
    const router = yield* GCP.Compute.Router("Router", {
      network: network.networkName,
      region: "us-central1",
    });
    const nat = includeNat
      ? yield* GCP.Compute.RouterNat("Nat", {
          router: router.routerName,
          region: router.region,
          natIpAllocateOption: "AUTO_ONLY",
          sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
          subnetworks: [
            {
              name: subnet.subnetworkName,
              sourceIpRangesToNat: ["ALL_IP_RANGES"],
            },
          ],
          logConfig: {
            enable: enableLogging,
            filter: "ERRORS_ONLY",
          },
          udpIdleTimeoutSec: enableLogging ? 45 : 30,
        })
      : undefined;
    return { network, subnet, router, nat };
  });

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a router NAT without replacing its router",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(infrastructure(true));
      expect(created.nat?.natName).toEqual(expect.any(String));
      expect(created.nat?.router).toEqual(created.router.routerName);
      expect(created.nat?.natIpAllocateOption).toEqual("AUTO_ONLY");
      expect(created.nat?.sourceSubnetworkIpRangesToNat).toEqual(
        "LIST_OF_SUBNETWORKS",
      );
      expect(created.nat?.subnetworks[0]?.name).toEqual(
        expect.stringContaining(
          `/subnetworks/${created.subnet.subnetworkName}`,
        ),
      );

      const fetchedCreate = yield* compute.getRouters({
        project: created.router.project,
        region: created.router.region,
        router: created.router.routerName,
      });
      expect(
        fetchedCreate.nats?.find((nat) => nat.name === created.nat?.natName),
      ).toMatchObject({
        natIpAllocateOption: "AUTO_ONLY",
        sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
        logConfig: { enable: false, filter: "ERRORS_ONLY" },
      });

      const updated = yield* stack.deploy(infrastructure(true, true));
      expect(updated.router.routerId).toEqual(created.router.routerId);
      expect(updated.nat?.natName).toEqual(created.nat?.natName);
      expect(updated.nat?.logConfig).toEqual({
        enable: true,
        filter: "ERRORS_ONLY",
      });
      expect(updated.nat?.udpIdleTimeoutSec).toEqual(45);

      const removed = yield* stack.deploy(infrastructure(false));
      expect(removed.router.routerId).toEqual(created.router.routerId);
      const fetchedDelete = yield* compute.getRouters({
        project: removed.router.project,
        region: removed.router.region,
        router: removed.router.routerName,
      });
      // Compute omits `nats` entirely once the last entry is removed.
      expect(
        fetchedDelete.nats?.some((nat) => nat.name === created.nat?.natName) ??
          false,
      ).toEqual(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
