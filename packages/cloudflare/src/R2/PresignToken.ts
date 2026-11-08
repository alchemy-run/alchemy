import * as AwsCredentials from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import * as Presign from "@distilled.cloud/aws/Presign";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";
import { makeS3Credentials, type S3CredentialsAccess } from "./S3Credentials.ts";

/**
 * Shared scaffolding for the R2 presign bindings (`PresignGetObjectToken`,
 * `PresignPutObjectToken`): resolve the bucket's `S3Credentials` and presign
 * the S3 operation for R2's S3 endpoint with them, the same way
 * `AWS.S3.PresignGetObject`/`PresignPutObject` presign for S3.
 * `makeS3Credentials` handles the per-mode wiring (a scoped API token when
 * deployed, the Worker's local S3 endpoint under `alchemy dev`).
 *
 * NOT exported from `index.ts`.
 */
export const makePresignBinding = <I, O, E, R>(options: {
  name: string;
  access: S3CredentialsAccess;
  operation: Parameters<typeof Presign.presignRequest<I, O, E, R>>[0];
}) =>
  Effect.gen(function* () {
    // Resolved once at layer construction and provided to each bind, so the
    // binding callable carries no Worker requirements.
    const host = yield* Worker;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (bucket: Bucket) {
      const credentials = yield* makeS3Credentials(host, env, bucket, options.access);
      return Effect.fn(`${options.name}(${bucket.LogicalId})`)(function* ({
        expiresIn,
        ...input
      }: Omit<I, "Bucket" | "Body"> & { expiresIn?: number }) {
        const s3 = yield* credentials;
        return yield* Presign.presignRequest(
          options.operation,
          { ...input, Bucket: s3.bucketName } as unknown as Omit<I, "Body">,
          { expiresIn },
        ).pipe(
          Effect.provideService(
            AwsCredentials.Credentials,
            Effect.succeed({
              accessKeyId: Redacted.make(s3.accessKeyId),
              secretAccessKey: Redacted.make(s3.secretAccessKey),
              sessionToken: undefined,
              region: s3.region,
            }),
          ),
          Effect.provide(AwsEndpoint.of(s3.endpoint.replace(/\/+$/, ""))),
        );
      });
    });
  });
