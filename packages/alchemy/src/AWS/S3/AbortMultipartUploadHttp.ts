import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import {
  AbortMultipartUpload,
  type AbortMultipartUploadRequest,
} from "./AbortMultipartUpload.ts";

export const AbortMultipartUploadHttp = Layer.effect(
  AbortMultipartUpload,
  Effect.gen(function* () {
    const abortMultipartUpload = yield* S3.abortMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.AbortMultipartUpload(${bucket}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["s3:AbortMultipartUpload"],
                  Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.S3.AbortMultipartUpload(${bucket.LogicalId})`)(
        function* (request: AbortMultipartUploadRequest) {
          return yield* abortMultipartUpload({
            ...request,
            Bucket: yield* BucketName,
          });
        },
      );
    });
  }),
);
