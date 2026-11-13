import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createVpc, deleteVpc, getDroplet, getVpc } from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, skipSlow, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "sfo3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:vpc", "live"];
const LIVE_TIMEOUT = 180_000;
// A droplet takes one to two minutes to create and as long to destroy.
const DROPLET_TIMEOUT = 600_000;

const readVpc = (vpcId: string) =>
  getVpc({ vpc_id: vpcId }).pipe(Effect.map((response) => response.vpc));

const isVpcGone = (vpcId: string) => isGone(readVpc(vpcId));

// Ranges must not overlap another VPC on the team, so each test owns one.
const RANGES = {
  lifecycle: "10.181.0.0/24",
  replaced: "10.181.1.0/24",
  foreign: "10.181.2.0/24",
  generated: "10.181.3.0/24",
  droplet: "10.181.4.0/24",
};

test.provider(
  "vpc lifecycle: create, rename and redescribe in place, replace on a new range, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "vpc");
      const renamed = testName(stack.stage, "vpc-renamed");

      const created = yield* stack.deploy(
        DigitalOcean.Vpc("Network", { name, region: REGION, ipRange: RANGES.lifecycle }),
      );
      expect(created).toMatchObject({
        name,
        region: REGION,
        ipRange: RANGES.lifecycle,
        isDefault: false,
      });
      expect(created.urn).toEqual(`do:vpc:${created.vpcId}`);

      const updated = yield* stack.deploy(
        DigitalOcean.Vpc("Network", {
          name: renamed,
          region: REGION,
          ipRange: RANGES.lifecycle,
          description: "app network",
        }),
      );
      expect(updated.vpcId).toEqual(created.vpcId);
      const remote = yield* readVpc(created.vpcId);
      expect(remote.name).toEqual(renamed);
      expect(remote.description).toEqual("app network");

      const replaced = yield* stack.deploy(
        DigitalOcean.Vpc("Network", { name: renamed, region: REGION, ipRange: RANGES.replaced }),
      );
      expect(replaced.vpcId).not.toEqual(created.vpcId);
      expect(replaced.ipRange).toEqual(RANGES.replaced);
      expect(yield* isVpcGone(created.vpcId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isVpcGone(replaced.vpcId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a vpc created outside alchemy with the chosen name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "vpc-foreign");

      yield* Effect.acquireUseRelease(
        createVpc({ name, region: REGION, ip_range: RANGES.foreign }).pipe(
          Effect.map((response) => response.vpc),
        ),
        (foreign) =>
          Effect.gen(function* () {
            const declared = DigitalOcean.Vpc("Adopted", {
              name,
              region: REGION,
              ipRange: RANGES.foreign,
              description: "adopted",
            });
            const refused = yield* stack.deploy(declared).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(declared.pipe(adopt(true)));
            expect(adopted.vpcId).toEqual(foreign.id);
            expect((yield* readVpc(foreign.id)).description).toEqual("adopted");

            yield* stack.destroy();

            expect(yield* isVpcGone(foreign.id)).toBe(true);
          }),
        (foreign) => ignoreNotFound(deleteVpc({ vpc_id: foreign.id })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "destroy recovers a generated-name vpc without recorded attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declared = DigitalOcean.Vpc("Box", { region: REGION, ipRange: RANGES.generated });
      const created = yield* stack.deploy(declared);
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });

      const resumed = yield* stack.deploy(declared);
      expect(resumed.vpcId).toEqual(created.vpcId);

      yield* stack.destroy();

      expect(yield* isVpcGone(created.vpcId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a droplet in the vpc gets a private address in its range, and destroy removes both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* DigitalOcean.Vpc("Network", {
            region: REGION,
            ipRange: RANGES.droplet,
          });
          const host = yield* DigitalOcean.Droplet("Host", {
            region: REGION,
            size: "s-1vcpu-512mb-10gb",
            image: "ubuntu-24-04-x64",
            vpcUuid: network.vpcId,
          });
          return { network, host };
        }),
      );
      expect(deployed.host.vpcUuid).toEqual(deployed.network.vpcId);
      expect(deployed.host.privateIpv4).toMatch(/^10\.181\.4\./);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: deployed.host.dropletId }))).toBe(true);
      expect(yield* isVpcGone(deployed.network.vpcId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: DROPLET_TIMEOUT },
);
