import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import {
  CreateMultipartUpload,
  type CreateMultipartUploadRequest,
} from "./CreateMultipartUpload.ts";

export const CreateMultipartUploadHttp = Layer.effect(
  CreateMultipartUpload,
  Effect.gen(function* () {
    const createMultipartUpload = yield* S3.createMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.CreateMultipartUpload(${bucket}))`(
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
      return Effect.fn(`AWS.S3.CreateMultipartUpload(${bucket.LogicalId})`)(
        function* (request: CreateMultipartUploadRequest) {
          return yield* createMultipartUpload({
            ...request,
            Bucket: yield* BucketName,
          });
        },
      );
    });
  }),
);
