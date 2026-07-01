import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import {
  CompleteMultipartUpload,
  type CompleteMultipartUploadRequest,
} from "./CompleteMultipartUpload.ts";

export const CompleteMultipartUploadHttp = Layer.effect(
  CompleteMultipartUpload,
  Effect.gen(function* () {
    const completeMultipartUpload = yield* S3.completeMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.CompleteMultipartUpload(${bucket}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["s3:PutObject"],
                  Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.S3.CompleteMultipartUpload(${bucket.LogicalId})`)(
        function* (request: CompleteMultipartUploadRequest) {
          return yield* completeMultipartUpload({
            ...request,
            Bucket: yield* BucketName,
          });
        },
      );
    });
  }),
);
