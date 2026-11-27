// Deep imports keep the Compute bundle lean (see bucket.ts).
import { Compute } from "@alchemy.run/prisma/Compute";
import { Project } from "@alchemy.run/prisma/Project";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const EffectNativeProject = Project("PrismaEffectNativeProject", { createDatabase: false });

/** An Effect-native Compute whose response comes from a variable its init binds. */
export default Compute(
  "PrismaEffectNativeCompute",
  Effect.gen(function* () {
    return {
      project: yield* EffectNativeProject,
      main: import.meta.filename,
      port: 8080,
      timeoutSeconds: 240,
    };
  }),
  Effect.gen(function* () {
    const context = yield* CurrentRuntimeContext;
    const key = yield* context!.set("GREETING", Output.literal("from a binding"));
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(String(yield* context!.get<string>(key)));
      }),
    };
  }),
);
