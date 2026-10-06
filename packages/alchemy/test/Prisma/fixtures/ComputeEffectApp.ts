import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
// Deep imports keep the Compute bundle lean (see ./bucket.ts).
import { Compute } from "@/Prisma/Compute.ts";
import { Project } from "@/Prisma/Project.ts";
import { Stack } from "@/Stack.ts";

/** Project shared by the live build suite and this app. */
export const ComputeBuildProject = Project("Project", { createDatabase: false });

/**
 * Effect-native Compute app deployed from a named export. It answers with
 * the deploy-time stack identity the bundle bakes in for the runtime.
 */
export const Api = Compute(
  "EffectApp",
  Effect.gen(function* () {
    const project = yield* ComputeBuildProject;
    return {
      project,
      main: import.meta.filename,
      handler: "Api",
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const stack = yield* Stack;
    return {
      fetch: Effect.succeed(
        HttpServerResponse.text(`effect-native-ok ${stack.name}/${stack.stage}`),
      ),
    };
  }),
);
