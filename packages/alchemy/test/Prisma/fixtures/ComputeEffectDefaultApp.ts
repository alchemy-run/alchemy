import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
// Deep imports keep the Compute bundle lean (see ./bucket.ts).
import { Compute } from "@/Prisma/Compute.ts";
import { ComputeBuildProject } from "./ComputeEffectApp.ts";

/** Effect-native Compute app deployed from the default export on a non-default port. */
export default Compute(
  "EffectDefaultApp",
  Effect.gen(function* () {
    const project = yield* ComputeBuildProject;
    return {
      project,
      main: import.meta.filename,
      port: 4555,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("effect-native-default-ok")),
  }),
);
