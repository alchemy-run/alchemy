// Deep imports keep the Compute bundle lean (see bucket.ts).
import { Compute } from "@alchemy.run/prisma/Compute";
import { Project } from "@alchemy.run/prisma/Project";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { bindEnvOutputs } from "../../EnvBoundOutputs.ts";
import { envValues, readEnvValues } from "../../EnvValues.ts";

export const EnvValuesProject = Project("PrismaEnvValuesProject", { createDatabase: false });

/**
 * The {@link envValues} cases Compute's `env` type admits: non-empty strings
 * and Redacted strings.
 */
export const stringEnvValues = Object.fromEntries(
  Object.entries(envValues).filter(([, value]: [string, unknown]) => {
    const plain = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    return typeof plain === "string" && plain.length > 0;
  }),
) as Record<string, string | Redacted.Redacted<string>>;

/**
 * Compute app deployed with `env`. `/env` echoes the raw `process.env` value
 * of each {@link envValues} key; `/bound` echoes Outputs bound in init.
 */
const EnvValuesCompute = (id: string, env: Record<string, string | Redacted.Redacted<string>>) =>
  Compute(
    id,
    Effect.gen(function* () {
      return {
        project: yield* EnvValuesProject,
        main: import.meta.filename,
        port: 8080,
        env,
        timeoutSeconds: 240,
        destroyOldDeployment: true,
      };
    }),
    Effect.gen(function* () {
      const project = yield* EnvValuesProject;
      const bound = yield* bindEnvOutputs(project.projectId);

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          if (request.url.startsWith("/env")) {
            return yield* HttpServerResponse.json(
              // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
              yield* Effect.sync(() => readEnvValues(process.env)),
            );
          }
          if (request.url.startsWith("/bound")) {
            return yield* HttpServerResponse.json(yield* bound);
          }
          return HttpServerResponse.text("ok");
        }).pipe(Effect.orDie),
      };
    }),
  );

/** Only the string cases, so the deploy is not blocked on the others. */
export const StringEnvValuesCompute = EnvValuesCompute(
  "PrismaStringEnvValuesCompute",
  stringEnvValues,
);

export default StringEnvValuesCompute;
