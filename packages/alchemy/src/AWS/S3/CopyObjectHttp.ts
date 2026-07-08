// @ts-nocheck
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import { CopyObject, type CopyObjectRequest } from "./CopyObject.ts";

export const CopyObjectHttp = Layer.effect(
  CopyObject,
  Effect.gen(function* () {
    const copyObject = yield* S3.copyObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.CopyObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:PutObject", "s3:GetObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.CopyObject(${bucket.LogicalId})`)(function* (
        request: CopyObjectRequest,
      ) {
        return yield* copyObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);
