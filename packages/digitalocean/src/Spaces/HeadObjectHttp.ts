import * as S3 from "@distilled.cloud/s3";
import * as Layer from "effect/Layer";
import { makeSpacesBinding } from "./BucketBinding.ts";
import { HeadObject } from "./HeadObject.ts";

/**
 * HeadObject over the Spaces S3 API, signed with a key scoped to the bound
 * bucket.
 *
 * @layer
 * @product Spaces
 * @provides DigitalOcean.Spaces.HeadObject
 */
export const HeadObjectHttp = Layer.effect(
  HeadObject,
  makeSpacesBinding({
    tag: "DigitalOcean.Spaces.HeadObject",
    access: "read",
    operation: S3.headObject,
  }),
);
