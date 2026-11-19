import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { envValuesWithout, readEnvValues } from "../../../EnvValues.ts";

/** AWS Batch drops an empty env value, so the job skips it. */
export const jobEnv = envValuesWithout("ENV_EMPTY");

/** Prefix of the stdout line carrying the echoed env values as JSON. */
export const ENV_MARKER = "ALCHEMY_ENV_VALUES ";

/**
 * Run-to-completion job whose `env` holds the {@link jobEnv} cases. It
 * prints the values it reads from `process.env` as one JSON line; the test
 * reads it back from the job's `/aws/batch/job` log stream.
 */
export default class EnvJob extends AWS.Batch.JobDefinition<EnvJob>()(
  "BatchEnvJob",
  {
    main: import.meta.filename,
    vcpus: 0.25,
    memory: 512,
    timeout: "10 minutes",
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
    env: jobEnv.values,
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
) {}
