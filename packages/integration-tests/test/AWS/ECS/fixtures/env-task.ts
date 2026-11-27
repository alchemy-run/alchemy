import { Task } from "@alchemy.run/aws/ECS/Task";
import * as Effect from "effect/Effect";
import { echoEnv, envValues } from "../../../EnvValues.ts";

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
      run: echoEnv.pipe(Effect.map((env) => console.log(`${ENV_MARKER}${JSON.stringify(env)}`))),
    };
  }),
);
