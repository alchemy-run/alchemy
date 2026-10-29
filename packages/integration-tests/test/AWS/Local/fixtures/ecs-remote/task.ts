import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * An ECS task emulated by floci under `alchemy dev`, bound to a bucket in the
 * real cloud: each request writes an object there with the developer's
 * credentials. Bridge networking on a literal port, like the other ECS dev
 * fixtures, so the test reaches it at `localhost:<port>`.
 */
export default class EcsRemoteTask extends AWS.ECS.Task<EcsRemoteTask>()(
  "EcsRemoteTask",
  {
    main: import.meta.filename,
    cpu: 256,
    memory: 512,
    port: 17364,
    networkMode: "bridge",
    requiresCompatibilities: ["EC2"],
    image: "oven/bun:1",
    runtimePlatform:
      process.arch === "arm64"
        ? { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }
        : { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
  },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("EcsRemoteBucket", { forceDestroy: true }).pipe(
      Alchemy.remote(),
    );
    const putObject = yield* AWS.S3.PutObject(bucket);
    return {
      fetch: putObject({ Key: "from-ecs.txt", Body: "from-ecs" }).pipe(
        Effect.as(HttpServerResponse.text("ecs-remote-marker")),
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(AWS.S3.PutObjectHttp)),
) {}
