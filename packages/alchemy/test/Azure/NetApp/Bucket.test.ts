import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  BUCKET_CERTIFICATE_BASE64,
  BUCKET_FQDN,
} from "./fixtures/bucket-certificate.ts";
import { logLevel, subscription, tags, volumeBase, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { permissions: "ReadOnly" | "ReadWrite" }) =>
  Effect.gen(function* () {
    const base = yield* volumeBase;
    const bucket = yield* Azure.NetApp.Bucket("Objects", {
      resourceGroup: base.group.resourceGroupName,
      account: base.account.accountName,
      pool: base.pool.poolName,
      volume: base.volume.volumeName,
      fileSystemUser: { nfsUser: { userId: 1000, groupId: 1000 } },
      server: {
        fqdn: BUCKET_FQDN,
        certificateObject: Redacted.make(BUCKET_CERTIFICATE_BASE64),
      },
      permissions: props.permissions,
    });
    return { ...base, bucket };
  });

// 1 TiB Standard pool (~$0.20/hour) for ~25 minutes: ~$0.20 per run.
// Buckets are a preview feature in selected regions. Free-trial
// subscriptions cannot create NetApp accounts (`NetAppCreationRestricted`,
// probed in Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a volume bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool, volume, bucket } = yield* stack.deploy(
        program({ permissions: "ReadOnly" }),
      );
      const get = () =>
        Effect.gen(function* () {
          return yield* netapp.GetBucket({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            poolName: pool.poolName,
            volumeName: volume.volumeName,
            bucketName: bucket.bucketName,
          });
        });
      expect(bucket.serverFqdn).toEqual(BUCKET_FQDN);
      const observed = yield* get();
      expect(observed.properties?.permissions).toEqual("ReadOnly");
      expect(observed.properties?.fileSystemUser?.nfsUser?.userId).toEqual(
        1000,
      );

      // In place: permissions.
      const updated = yield* stack.deploy(
        program({ permissions: "ReadWrite" }),
      );
      expect(updated.bucket.bucketId).toEqual(bucket.bucketId);
      expect((yield* get()).properties?.permissions).toEqual("ReadWrite");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
