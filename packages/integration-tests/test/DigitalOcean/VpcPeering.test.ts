import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getVpcPeering } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:vpcpeering", "live"];
const LIVE_TIMEOUT = 600_000;

test.provider(
  "vpc peering: connect two vpcs across regions, rename in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (name: string) =>
        Effect.gen(function* () {
          const a = yield* DigitalOcean.Vpc("A", { region: "nyc3", ipRange: "10.183.0.0/24" });
          const b = yield* DigitalOcean.Vpc("B", { region: "sfo3", ipRange: "10.183.1.0/24" });
          const peering = yield* DigitalOcean.VpcPeering("Peering", {
            name,
            vpcIds: [a.vpcId, b.vpcId],
          });
          return { a, b, peering };
        });

      const created = yield* stack.deploy(declare(testName(stack.stage, "peering")));
      expect(created.peering.status).toEqual("ACTIVE");
      expect([...created.peering.vpcIds].sort()).toEqual([created.a.vpcId, created.b.vpcId].sort());

      const renamed = yield* stack.deploy(declare(testName(stack.stage, "peering-renamed")));
      expect(renamed.peering.vpcPeeringId).toEqual(created.peering.vpcPeeringId);
      expect(
        (yield* getVpcPeering({ vpc_peering_id: created.peering.vpcPeeringId })).vpc_peering.name,
      ).toEqual(testName(stack.stage, "peering-renamed"));

      yield* stack.destroy();

      expect(yield* isGone(getVpcPeering({ vpc_peering_id: created.peering.vpcPeeringId }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
