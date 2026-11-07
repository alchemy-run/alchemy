import * as Cloudflare from "@alchemy.run/cloudflare";
import { s3CredentialsPolicy } from "@alchemy.run/cloudflare/R2/S3CredentialsBinding";
import * as Modal from "@alchemy.run/modal";
import * as Output from "alchemy/Output";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const Agents = Modal.Environment("BindingsEnv", {});

// Declarations as props: each is yielded with the resource that uses it.
export const Coder = Modal.App("BindingsApp", { environment: Agents });

export const Base = Modal.Image("BindingsBase", {
  app: Coder,
  image: "debian:bookworm-slim",
  commands: ["RUN echo ready > /ready.txt"],
});

export const Workspace = Modal.Volume("BindingsVolume", { environment: Agents });

export const Results = Modal.Dict("BindingsDict", { environment: Agents });

export const Jobs = Modal.Queue("BindingsQueue", { environment: Agents });

export const Token = Modal.Secret("BindingsSecret", {
  environment: Agents,
  env: { TOKEN: Redacted.make("dummy") },
});

/** A Cloudflare R2 bucket the sandbox program mounts with Modal's cloud bucket mounts. */
export const Uploads = Cloudflare.R2.Bucket("MountedUploads", { forceDestroy: true });

/** An account token scoped to the bucket: R2 derives its S3 keys from it. */
export const UploadsToken = Cloudflare.ApiToken.AccountApiToken(
  "MountedUploadsToken",
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    return {
      policies: [
        Output.all(bucket.accountId, bucket.bucketName, bucket.jurisdiction).pipe(
          Output.map(([accountId, bucketName, jurisdiction]) =>
            s3CredentialsPolicy(accountId, bucketName, jurisdiction, "read-write"),
          ),
        ),
      ],
    };
  }),
);

/** The bucket's S3 keys, as Modal's cloud bucket mounts read them. */
export const UploadsKeys = Modal.Secret(
  "MountedUploadsKeys",
  Effect.gen(function* () {
    const token = yield* UploadsToken;
    return {
      environment: yield* Agents,
      env: {
        AWS_ACCESS_KEY_ID: token.tokenId,
        // R2's secret access key is the SHA-256 of the token value.
        AWS_SECRET_ACCESS_KEY: token.value.pipe(
          Output.mapEffect((value) => sha256(Redacted.value(value))),
        ),
      },
    };
  }),
);
