import { HeadObject } from "@/AWS/S3/HeadObject.ts";
import { HeadObjectHttp } from "@/AWS/S3/HeadObjectHttp.ts";
import * as Output from "@/Output.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";
import { Credentials } from "@distilled.cloud/aws";
import * as Region from "@distilled.cloud/aws/Region";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

it.effect(
  "binds version-aware object reads through the production layer",
  () => {
    let captured: any;
    const stored: Record<string, Output.Output> = {};
    const runtime = {
      Type: "AWS.Lambda.Function",
      id: "Host",
      env: {},
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          stored[id] = output;
          return id;
        }),
      get: <T>(id: string) =>
        Output.evaluate(stored[id], {}) as Effect.Effect<T>,
    };
    const host = {
      Type: "AWS.Lambda.Function",
      LogicalId: "Host",
      FQN: "Host",
      bind: (...args: unknown[]) =>
        args[0] instanceof Array
          ? (binding: unknown) => Effect.sync(() => (captured = binding))
          : Effect.void,
    };
    const bucket = {
      Type: "AWS.S3.Bucket",
      LogicalId: "Bucket",
      FQN: "Bucket",
      bucketName: Output.asOutput("bucket"),
      bucketArn: Output.asOutput("arn:aws:s3:::bucket"),
    } as any;

    return Effect.gen(function* () {
      const bind = yield* HeadObject;
      yield* bind(bucket);
      expect(captured.policyStatements[0].Action).toEqual([
        "s3:GetObject",
        "s3:GetObjectVersion",
      ]);
      expect(captured.policyStatements[1].Action).toEqual(["s3:ListBucket"]);
    }).pipe(
      Effect.provide(HeadObjectHttp),
      Effect.provide(Credentials.mock),
      Effect.provide(Region.of("us-east-1")),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provide(Layer.succeed(RuntimeContext, runtime)),
    );
  },
);
