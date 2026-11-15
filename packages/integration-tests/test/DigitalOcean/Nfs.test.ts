import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getNfs } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:nfs", "live"];
const LIVE_TIMEOUT = 1_200_000;
// NFS shares are offered in a few regions; atl1 has them.
const REGION = "atl1";

test.provider.skipIf(skipSlow)(
  "nfs share: create attached to a vpc, grow in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (sizeGib: number) =>
        Effect.gen(function* () {
          const network = yield* DigitalOcean.Vpc("Network", {
            region: REGION,
            ipRange: "10.185.0.0/24",
          });
          const share = yield* DigitalOcean.Nfs("Files", {
            region: REGION,
            sizeGib,
            vpcIds: [network.vpcId],
          });
          return { network, share };
        });

      const created = yield* stack.deploy(declare(50));
      expect(created.share).toMatchObject({ status: "ACTIVE", sizeGib: 50 });
      expect(created.share.host).toBeTruthy();

      const grown = yield* stack.deploy(declare(100));
      expect(grown.share.nfsId).toEqual(created.share.nfsId);
      expect(
        (yield* getNfs({ nfs_id: created.share.nfsId, region: REGION })).share.size_gib,
      ).toEqual(100);

      yield* stack.destroy();

      expect(yield* isGone(getNfs({ nfs_id: created.share.nfsId, region: REGION }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
