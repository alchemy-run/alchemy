import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Out-of-band access to a bucket's S3 API: `use` runs with a key created for the
 * test in the given credentials group (the project's `default` group when
 * omitted), which is deleted afterwards.
 */
export const withOutOfBandS3 = <A, E, R>(
  target: {
    readonly projectId: string;
    readonly region: string;
    readonly credentialsGroupId?: string;
  },
  use: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    objectStorage.createAccessKey({
      projectId: target.projectId,
      region: target.region,
      credentials_group: target.credentialsGroupId,
    }),
    (key) =>
      use.pipe(
        Effect.provide(
          Layer.mergeAll(
            fromCredentials(
              {
                accessKeyId: Redacted.make(key.accessKey),
                secretAccessKey:
                  typeof key.secretAccessKey === "string"
                    ? Redacted.make(key.secretAccessKey)
                    : key.secretAccessKey,
              },
              target.region as RegionName,
            ),
            Endpoint.of(`https://object.storage.${target.region}.onstackit.cloud`),
            FetchHttpClient.layer,
          ),
        ),
      ),
    (key) =>
      objectStorage
        .deleteAccessKey({
          projectId: target.projectId,
          region: target.region,
          keyId: key.keyId,
          credentials_group: target.credentialsGroupId,
        })
        .pipe(Effect.ignore),
  );

/** A fresh key may not be known to S3 yet; policies take a moment to apply. */
export const s3Propagation = { schedule: Schedule.spaced("3 seconds"), times: 10 } as const;
