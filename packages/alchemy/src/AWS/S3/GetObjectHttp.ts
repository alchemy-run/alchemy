import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import { GetObject, type GetObjectRequest } from "./GetObject.ts";

export const GetObjectHttp = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const getObject = yield* S3.getObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.GetObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
              {
                Effect: "Allow",
                Action: [
                  // ListBucket is required to check if the object exists (otherwise a non-existent key returns 403)
                  // https://repost.aws/articles/ARe3OTZ3SCTWWqGtiJ6aHn8Q/why-does-s-3-return-403-instead-of-404-when-the-object-doesnt-exist
                  "s3:ListBucket",
                ],
                Resource: [bucket.bucketArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.GetObject(${bucket.LogicalId})`)(function* (
        request: GetObjectRequest,
      ) {
        return yield* getObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);
