import * as S3 from "@distilled.cloud/s3";
import * as Layer from "effect/Layer";
import { makeSpacesBinding } from "./BucketBinding.ts";
import { GetObject } from "./GetObject.ts";

/**
 * GetObject over the Spaces S3 API, signed with a key scoped to the bound
 * bucket.
 *
 * @layer
 * @product Spaces
 * @provides DigitalOcean.Spaces.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  makeSpacesBinding({
    tag: "DigitalOcean.Spaces.GetObject",
    access: "read",
    operation: S3.getObject,
  }),
);
