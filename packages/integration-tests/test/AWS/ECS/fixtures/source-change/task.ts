import { Task } from "@alchemy.run/aws/ECS/Task";
import * as Effect from "effect/Effect";
import { sourceChangeMarker } from "./marker.ts";

/**
 * An Effect-native one-shot task whose only change between deploys is the
 * source of an imported module (`marker.ts`), so its props stay identical.
 */
export class SourceChangeTask extends Task<SourceChangeTask>()("SourceChangeTask") {}

export default SourceChangeTask.make(
  {
    main: import.meta.filename,
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
  },
  Effect.gen(function* () {
    return {
      run: Effect.log(sourceChangeMarker),
    };
  }),
);
