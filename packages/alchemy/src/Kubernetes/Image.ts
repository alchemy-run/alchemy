/**
 * Typed container-image values for Kubernetes workloads.
 *
 * A bare `image: string` on {@link Deployment} / {@link Job} still means
 * "mirror into the cluster's managed registry" on EKS (existing
 * behaviour). {@link Image.ref} is the lift that says the opposite: use
 * this registry reference verbatim. A produced image resource (anything
 * with `imageUri`, e.g. {@link AWS.ECR.Image}) is the same direct path
 * without a wrapper.
 *
 * Build, bundle, and mirror stay on those image resources — they are
 * lifecycles, not constructors.
 */
import type { Input } from "../Input.ts";

export const ImageRefTypeId = "Kubernetes.Image.Ref" as const;

/**
 * A pre-built registry reference used verbatim on the pod spec.
 * The cluster must already be able to pull it; Alchemy does not copy it
 * into the managed registry.
 */
export interface Ref {
  readonly _tag: typeof ImageRefTypeId;
  readonly ref: Input<string>;
}

/**
 * A produced image (e.g. `AWS.ECR.Image`). The workload writes
 * `imageUri` onto the pod and never invokes the cluster registry adapter.
 */
export interface Produced {
  readonly imageUri: Input<string>;
}

/** Values that skip the managed-registry mirror. */
export type ImageValue = Ref | Produced;

export const isRef = (value: unknown): value is Ref =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === ImageRefTypeId;

export const isProduced = (value: unknown): value is Produced =>
  typeof value === "object" &&
  value !== null &&
  !isRef(value) &&
  "imageUri" in value;

/** True when `image` is a direct pull spec, not a string to be mirrored. */
export const isDirectImage = (value: unknown): boolean =>
  isRef(value) || isProduced(value);

/**
 * The resolved registry reference for a direct image, or `undefined` when
 * `value` is not direct or its inner `Input` has not resolved to a string.
 */
export const directPullSpec = (value: unknown): string | undefined => {
  if (isRef(value)) {
    return typeof value.ref === "string" ? value.ref : undefined;
  }
  if (isProduced(value)) {
    return typeof value.imageUri === "string" ? value.imageUri : undefined;
  }
  return undefined;
};

/**
 * Lift a pre-built registry reference into a typed image that Deployment
 * and Job will use verbatim.
 *
 * @example
 * ```typescript
 * image: Image.ref("2956….dkr.ecr.us-east-1.amazonaws.com/apps@sha256:…")
 * image: Image.ref(other.imageUri)
 * ```
 */
export const Image = {
  ref: (ref: Input<string>): Ref => ({
    _tag: ImageRefTypeId,
    ref,
  }),
  isRef,
};
