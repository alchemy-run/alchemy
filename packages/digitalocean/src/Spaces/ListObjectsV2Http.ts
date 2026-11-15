import * as S3 from "@distilled.cloud/s3";
import * as Layer from "effect/Layer";
import { makeSpacesBinding } from "./BucketBinding.ts";
import { ListObjectsV2 } from "./ListObjectsV2.ts";

/**
 * ListObjectsV2 over the Spaces S3 API, signed with a key scoped to the bound
 * bucket.
 *
 * @layer
 * @product Spaces
 * @provides DigitalOcean.Spaces.ListObjectsV2
 */
export const ListObjectsV2Http = Layer.effect(
  ListObjectsV2,
  makeSpacesBinding({
    tag: "DigitalOcean.Spaces.ListObjectsV2",
    access: "read",
    operation: S3.listObjectsV2,
  }),
);
