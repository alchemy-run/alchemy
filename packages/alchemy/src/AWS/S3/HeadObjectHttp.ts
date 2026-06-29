import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import { HeadObject, type HeadObjectRequest } from "./HeadObject.ts";

export const HeadObjectHttp = Layer.effect(
  HeadObject,
  Effect.gen(function* () {
    const headObject = yield* S3.headObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.HeadObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.HeadObject(${bucket.LogicalId})`)(function* (
        request: HeadObjectRequest,
      ) {
        return yield* headObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);
