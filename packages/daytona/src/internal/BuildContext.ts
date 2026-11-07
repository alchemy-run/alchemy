import { createHash } from "node:crypto";
import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as objectStorage from "@distilled.cloud/daytona/object_storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { tar } from "./Tar.ts";

const redact = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

/**
 * Upload a plan's context files to Daytona's build-context storage and
 * return the hash `buildInfo.contextHashes` takes.
 *
 * Daytona's builders read each context from
 * `<organizationId>/<hash>/context.tar` in the bucket `getPushAccess`
 * names, with the temporary credentials it returns (the layout Daytona's
 * own SDKs use). The files go in one archive at their context paths; an
 * archive already uploaded under the same hash is reused.
 */
export const uploadBuildContext = Effect.fn(function* (plan: BuildPlan.BuildPlan) {
  const hash = yield* Effect.sync(() =>
    createHash("sha256")
      .update(JSON.stringify(plan.files.map((f) => [f.path, f.mode, f.sha256])))
      .digest("hex")
      .slice(0, 32),
  );
  const access = yield* objectStorage.getPushAccess({});
  const prefix = `${access.organizationId}/${hash}/`;
  const storage = Layer.mergeAll(
    fromCredentials(
      {
        accessKeyId: Redacted.make(access.accessKey),
        secretAccessKey: redact(access.secret),
        sessionToken: redact(access.sessionToken),
      },
      access.region as RegionName,
    ),
    AwsEndpoint.of(access.storageUrl),
  );
  const existing = yield* s3
    .listObjectsV2({ Bucket: access.bucket, Prefix: prefix, MaxKeys: 1 })
    .pipe(Effect.provide(storage));
  if ((existing.KeyCount ?? 0) > 0) return hash;
  const entries = yield* Effect.forEach(plan.files, (file) =>
    Effect.map(BuildPlan.readContextFile(file), (bytes) => ({
      path: file.path,
      mode: file.mode,
      bytes,
    })),
  );
  const body = yield* Effect.sync(() => tar(entries));
  yield* s3
    .putObject({ Bucket: access.bucket, Key: `${prefix}context.tar`, Body: body })
    .pipe(Effect.provide(storage));
  return hash;
});
