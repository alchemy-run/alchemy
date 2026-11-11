import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getAutoscalepool,
  getDroplet,
  listAutoscalepoolMembers,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow, testPublicKey } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:autoscalepool", "live"];
const LIVE_TIMEOUT = 1_200_000;

test.provider.skipIf(skipSlow)(
  "autoscale pool: run a fixed fleet, scale it in place, destroy with its droplets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const publicKey = yield* testPublicKey(stack.stage, "autoscale");

      const declare = (instances: number) =>
        Effect.gen(function* () {
          const key = yield* DigitalOcean.SshKey("Key", { publicKey });
          return yield* DigitalOcean.AutoscalePool("Pool", {
            scaling: { instances },
            droplet: {
              region: "nyc3",
              size: "s-1vcpu-512mb-10gb",
              image: "ubuntu-24-04-x64",
              sshKeys: [key.fingerprint],
            },
          });
        });

      const created = yield* stack.deploy(declare(1));
      expect(created.status).toEqual("active");

      const scaled = yield* stack.deploy(declare(2));
      expect(scaled.autoscalePoolId).toEqual(created.autoscalePoolId);
      const remote = yield* getAutoscalepool({ autoscale_pool_id: created.autoscalePoolId });
      expect(remote.autoscale_pool.config).toMatchObject({ target_number_instances: 2 });

      const members = yield* listAutoscalepoolMembers({
        autoscale_pool_id: created.autoscalePoolId,
      }).pipe(Effect.map((r) => r.droplets.map((m) => m.droplet_id)));
      expect(members.length).toBeGreaterThan(0);

      yield* stack.destroy();

      expect(yield* isGone(getAutoscalepool({ autoscale_pool_id: created.autoscalePoolId }))).toBe(
        true,
      );
      // Destroying the pool destroys its Droplets too.
      for (const dropletId of members) {
        expect(
          yield* isGone(getDroplet({ droplet_id: dropletId })).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (gone) => gone,
              times: 24,
            }),
          ),
        ).toBe(true);
      }
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
