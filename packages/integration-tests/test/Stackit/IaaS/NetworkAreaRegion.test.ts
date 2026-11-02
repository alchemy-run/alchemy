import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Free; needs organization-level IaaS permissions for the test service
// account (and an organization id in the profile).
const options = { tags: stackitTags("iaas", "networkarearegion"), timeout: 600_000 } as const;

const observe = (organizationId: string, areaId: string, region: string) =>
  iaas
    .getNetworkAreaRegion({ organizationId, areaId, region })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (organizationId: string, areaId: string, region: string) =>
  observe(organizationId, areaId, region).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (regional) => regional === "gone",
      times: 10,
    }),
    Effect.map((regional) => expect(regional).toEqual("gone")),
  );

const areaWithRegion = (props: Omit<Stackit.IaaS.NetworkAreaRegionProps, "networkAreaId">) =>
  Effect.gen(function* () {
    const area = yield* Stackit.IaaS.NetworkArea("RegionArea", {});
    const regional = yield* Stackit.IaaS.NetworkAreaRegion("RegionConfig", {
      networkAreaId: area.networkAreaId,
      ...props,
    });
    return { area, regional };
  });

test.provider(
  "configure, update, reconfigure and delete a network area region",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      const organizationId = env.organizationId ?? "";
      expect(organizationId).not.toEqual("");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        areaWithRegion({
          networkRanges: ["10.232.0.0/16"],
          transferNetwork: "10.233.255.0/24",
        }),
      );
      const areaId = created.area.networkAreaId;
      expect(created.regional.region).toEqual(env.region);
      expect(created.regional.networkRanges.map((range) => range.prefix)).toEqual([
        "10.232.0.0/16",
      ]);
      expect(created.regional.transferNetwork).toEqual("10.233.255.0/24");
      expect(created.regional.defaultPrefixLength).toEqual(25);
      expect(created.regional.minPrefixLength).toEqual(24);
      expect(created.regional.maxPrefixLength).toEqual(29);

      const fetched = yield* iaas.getNetworkAreaRegion({
        organizationId,
        areaId,
        region: env.region,
      });
      expect(fetched.ipv4?.transferNetwork).toEqual("10.233.255.0/24");

      // Add a range, change prefix lengths and nameservers in place.
      const updated = yield* stack.deploy(
        areaWithRegion({
          networkRanges: ["10.232.0.0/16", "10.234.0.0/16"],
          transferNetwork: "10.233.255.0/24",
          defaultPrefixLength: 26,
          minPrefixLength: 22,
          maxPrefixLength: 28,
          defaultNameservers: ["1.1.1.1"],
        }),
      );
      expect(updated.area.networkAreaId).toEqual(areaId);
      const ranges = yield* iaas.listNetworkAreaRanges({
        organizationId,
        areaId,
        region: env.region,
      });
      expect(ranges.items.map((range) => range.prefix).sort()).toEqual([
        "10.232.0.0/16",
        "10.234.0.0/16",
      ]);
      const refetched = yield* iaas.getNetworkAreaRegion({
        organizationId,
        areaId,
        region: env.region,
      });
      expect(refetched.ipv4?.defaultPrefixLen).toEqual(26);
      expect(refetched.ipv4?.minPrefixLen).toEqual(22);
      expect(refetched.ipv4?.maxPrefixLen).toEqual(28);
      expect(refetched.ipv4?.defaultNameservers).toEqual(["1.1.1.1"]);

      // Remove the first range.
      const trimmed = yield* stack.deploy(
        areaWithRegion({
          networkRanges: ["10.234.0.0/16"],
          transferNetwork: "10.233.255.0/24",
          defaultPrefixLength: 26,
          minPrefixLength: 22,
          maxPrefixLength: 28,
          defaultNameservers: ["1.1.1.1"],
        }),
      );
      expect(trimmed.regional.networkRanges.map((range) => range.prefix)).toEqual([
        "10.234.0.0/16",
      ]);

      // A new transfer network deletes and recreates the configuration.
      const plan = yield* stack.plan(
        areaWithRegion({
          networkRanges: ["10.234.0.0/16"],
          transferNetwork: "10.235.255.0/24",
        }),
      );
      expect(plan.resources.RegionConfig).toMatchObject({ action: "replace" });
      const reconfigured = yield* stack.deploy(
        areaWithRegion({
          networkRanges: ["10.234.0.0/16"],
          transferNetwork: "10.235.255.0/24",
        }),
      );
      expect(reconfigured.regional.transferNetwork).toEqual("10.235.255.0/24");
      const afterReplace = yield* iaas.getNetworkAreaRegion({
        organizationId,
        areaId,
        region: env.region,
      });
      expect(afterReplace.ipv4?.transferNetwork).toEqual("10.235.255.0/24");

      yield* stack.destroy();
      yield* expectGone(organizationId, areaId, env.region);
    }).pipe(logLevel),
  options,
);
