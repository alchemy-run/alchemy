import * as S3 from "@distilled.cloud/s3";
import * as Layer from "effect/Layer";
import { makeSpacesBinding } from "./BucketBinding.ts";
import { PutObject } from "./PutObject.ts";

/**
 * PutObject over the Spaces S3 API, signed with a key scoped to the bound
 * bucket.
 *
 * @layer
 * @product Spaces
 * @provides DigitalOcean.Spaces.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  makeSpacesBinding({
    tag: "DigitalOcean.Spaces.PutObject",
    access: "readwrite",
    operation: S3.putObject,
  }),
);
