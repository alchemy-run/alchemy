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
export class TigrisCredentialsMissing extends Data.TaggedError(
  "Fly.TigrisCredentialsMissing",
)<{
  name: string;
}> {}

/**
 * Failure of a Fly PetSem (KMS) call made from inside a Machine over the
 * `/.fly/api` unix socket.
 *
 * The distilled Machines SDK cannot reach that socket, so
 * {@link Encrypt}, {@link Decrypt}, {@link Sign}, and {@link Verify} post
 * directly when running inside a deployed host. This is the typed error
 * for that path — a non-2xx response, or a socket/transport failure.
 */
export class FlyKmsError extends Data.TaggedError("Fly.KmsError")<{
  /** The PetSem operation that failed. */
  readonly op: "encrypt" | "decrypt" | "sign" | "verify";
  /** HTTP status, when Fly answered at all. */
  readonly status?: number;
  /** Response body, or the transport failure message. */
  readonly message: string;
  readonly cause?: unknown;
}> {}
