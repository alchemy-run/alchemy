// Deep imports keep the Compute bundle lean (see bucket.ts).
import { Compute } from "@alchemy.run/prisma/Compute";
import { Project } from "@alchemy.run/prisma/Project";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bindEnvOutputs, echoEnv, envValuesWithout } from "../../EnvValues.ts";

export const EnvValuesProject = Project("PrismaEnvValuesProject", { createDatabase: false });

/**
 * Compute's `env` takes only non-empty strings and Redacted strings (Prisma
 * rejects empty values), so it deploys just those cases.
 */
export const computeEnv = envValuesWithout(
  "ENV_EMPTY",
  "ENV_NUMBER",
  "ENV_OBJECT",
  "ENV_SECRET_OBJECT",
);

/** Echoes the raw `process.env` value of each case, and the Outputs bound in init. */
export default Compute(
  "PrismaStringEnvValuesCompute",
  Effect.gen(function* () {
    return {
      project: yield* EnvValuesProject,
      main: import.meta.filename,
      port: 8080,
      env: computeEnv.values as Record<string, string>,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const project = yield* EnvValuesProject;
    const bound = yield* bindEnvOutputs(project.projectId);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ env: yield* echoEnv, bound: yield* bound });
      }).pipe(Effect.orDie),
    };
  }),
);
