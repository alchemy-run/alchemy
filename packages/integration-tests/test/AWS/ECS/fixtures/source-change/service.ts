import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { Service } from "@alchemy.run/aws/ECS/Service";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { sourceChangeMarker } from "./marker.ts";

export const SourceChangeCluster = Cluster("SourceChangeCluster", {});

/**
 * An Effect-native service whose only change between deploys is the source
 * of an imported module (`marker.ts`), so its props stay identical.
 * `desiredCount: 0` keeps Fargate placement out of the test.
 */
export class SourceChangeService extends Service<SourceChangeService>()("SourceChangeService") {}

export default SourceChangeService.make(
  Effect.gen(function* () {
    const cluster = yield* SourceChangeCluster;
    return {
      cluster,
      main: import.meta.filename,
      // Docker Hub's `oven/bun`; the public.ecr.aws default mirror
      // rate-limits anonymous pulls during local builds (see fixtures/task.ts).
      image: "oven/bun:1",
      port: 3000,
      cpu: 256,
      memory: 512,
      desiredCount: 0,
      // Build/run on ARM64 so an image built on an Apple Silicon host
      // matches the Fargate runtime architecture (Graviton).
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text(sourceChangeMarker)),
    };
  }),
);
