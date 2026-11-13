import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getVpcnatgateway } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:natgateway", "live"];
const LIVE_TIMEOUT = 1_200_000;

test.provider.skipIf(skipSlow)(
  "nat gateway: route a vpc's egress, rename in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (name: string | undefined) =>
        Effect.gen(function* () {
          const network = yield* DigitalOcean.Vpc("Network", {
            region: "nyc3",
            ipRange: "10.184.0.0/24",
          });
          const nat = yield* DigitalOcean.NatGateway("Egress", {
            name,
            region: "nyc3",
            vpcIds: [network.vpcId],
          });
          return { network, nat };
        });

      const created = yield* stack.deploy(declare(undefined));
      expect(created.nat.state).toEqual("ACTIVE");
      expect(created.nat.egressIps.length).toBeGreaterThan(0);

      const renamed = yield* stack.deploy(declare(`${created.nat.name.slice(0, 50)}-renamed`));
      expect(renamed.nat.natGatewayId).toEqual(created.nat.natGatewayId);

      yield* stack.destroy();

      expect(yield* isGone(getVpcnatgateway({ id: created.nat.natGatewayId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
