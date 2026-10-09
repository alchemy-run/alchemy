import * as Data from "effect/Data";

/**
 * A {@link Bucket}'s Tigris credentials could not be resolved when a
 * bound S3 operation ran.
 *
 * Tigris hands out the access key pair once, at add-on creation. If the
 * Bucket attributes reaching the binding carry no key pair — an adopted
 * bucket, or one whose create-only secrets were never persisted — the
 * operation fails with this instead of signing an anonymous request.
 */
export class TigrisCredentialsMissing extends Data.TaggedError("Fly.TigrisCredentialsMissing")<{
  name: string;
}> {}

/**
 * Tigris refused to delete some keys of the batch `DeleteObjects` requests
 * `Fly.Website.AssetDeployment` sent while it pruned stale assets or emptied
 * its prefix.
 */
export class TigrisObjectsNotDeleted extends Data.TaggedError("Fly.TigrisObjectsNotDeleted")<{
  bucketName: string;
  refused: { key?: string; code?: string; message?: string }[];
}> {
  get message() {
    return `Tigris refused to delete ${this.refused.length} object(s) in bucket ${this.bucketName}: ${this.refused
      .map(
        ({ key, code, message }) =>
          `${JSON.stringify(key ?? "")} ${code ?? "UnknownError"}${message ? `: ${message}` : ""}`,
      )
      .join(", ")}`;
  }
}
