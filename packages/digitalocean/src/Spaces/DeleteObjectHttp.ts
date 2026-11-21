import * as S3 from "@distilled.cloud/s3";
import * as Layer from "effect/Layer";
import { makeSpacesBinding } from "./BucketBinding.ts";
import { DeleteObject } from "./DeleteObject.ts";

/**
 * DeleteObject over the Spaces S3 API, signed with a key scoped to the bound
 * bucket.
 *
 * @layer
 * @product Spaces
 * @provides DigitalOcean.Spaces.DeleteObject
 */
export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  makeSpacesBinding({
    tag: "DigitalOcean.Spaces.DeleteObject",
    access: "readwrite",
    operation: S3.deleteObject,
  }),
);
