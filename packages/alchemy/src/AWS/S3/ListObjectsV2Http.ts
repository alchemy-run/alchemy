import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import { ListObjectsV2, type ListObjectsV2Request } from "./ListObjectsV2.ts";

export const ListObjectsV2Http = Layer.effect(
  ListObjectsV2,
  Effect.gen(function* () {
    const listObjectsV2 = yield* S3.listObjectsV2;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.ListObjectsV2(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: [Output.interpolate`${bucket.bucketArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.ListObjectsV2(${bucket.LogicalId})`)(function* (
        request?: ListObjectsV2Request,
      ) {
        return yield* listObjectsV2({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);
