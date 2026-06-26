import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";

import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import { DeleteObject, type DeleteObjectRequest } from "./DeleteObject.ts";

export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  Effect.gen(function* () {
    const deleteObject = yield* S3.deleteObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.DeleteObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.DeleteObject(${bucket.LogicalId})`)(function* (
        request: DeleteObjectRequest,
      ) {
        return yield* deleteObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);
