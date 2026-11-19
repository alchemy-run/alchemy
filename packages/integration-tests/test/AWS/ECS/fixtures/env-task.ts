import { Task } from "@alchemy.run/aws/ECS/Task";
import * as Effect from "effect/Effect";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

/** Prefix of the stdout line carrying the echoed env values as JSON. */
export const ENV_MARKER = "ALCHEMY_ENV_VALUES ";

/**
 * One-shot task whose `env` holds every {@link envValues} case. It prints the
 * values it reads from `process.env` as one JSON line; the test reads it back
 * from the task's log group.
 */
export class EnvTask extends Task<EnvTask>()("EcsEnvTask") {}

export default EnvTask.make(
  {
    main: import.meta.filename,
    // Docker Hub's `oven/bun`; the public.ecr.aws default mirror rate-limits
    // anonymous pulls during local builds (see fixtures/task.ts).
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    env: envValues,
  },
  Effect.gen(function* () {
    return {
      run: Effect.sync(() =>
        console.log(
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
          `${ENV_MARKER}${JSON.stringify(readEnvValues(process.env))}`,
        ),
      ),
    };
  }),
);
