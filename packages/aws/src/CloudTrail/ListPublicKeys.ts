import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCloudTrailAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `cloudtrail:ListPublicKeys`.
 *
 * An account-level operation (no resource argument) that returns the public
 * keys used to sign CloudTrail digest files in the region — the building
 * block for verifying log-file integrity at runtime. Provide the
 * implementation with `Effect.provide(AWS.CloudTrail.ListPublicKeysHttp)`.
 * ### Verifying Log Integrity
 * **Example:** List Digest Public Keys
 * ```typescript
 * // init — account-level binding takes no resource
 * const listPublicKeys = yield* AWS.CloudTrail.ListPublicKeys();
 *
 * // runtime
 * const result = yield* listPublicKeys();
 * console.log(result.PublicKeyList?.map((k) => k.Fingerprint));
 * ```
 *
 * @binding
 */
export interface ListPublicKeys extends Binding.Service<
  ListPublicKeys,
  "AWS.CloudTrail.ListPublicKeys",
  () => Effect.Effect<
    (
      request?: cloudtrail.ListPublicKeysRequest,
    ) => Effect.Effect<cloudtrail.ListPublicKeysResponse, cloudtrail.ListPublicKeysError>
  >
> {}
export const ListPublicKeys = Binding.Service<ListPublicKeys>("AWS.CloudTrail.ListPublicKeys");

export const ListPublicKeysHttp = Layer.effect(
  ListPublicKeys,
  makeCloudTrailAccountHttpBinding({
    tag: "AWS.CloudTrail.ListPublicKeys",
    operation: cloudtrail.listPublicKeys,
    actions: ["cloudtrail:ListPublicKeys"],
  }),
);
