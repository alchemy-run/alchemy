import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { registryFor, Stage } from "./deployer.ts";

/**
 * The async form: `main` is a plain file with a `fetch` handler, bundled with no
 * Effect runtime. The handler gets `env` as its second argument.
 */
export const Web = Effect.gen(function* () {
  const stage = yield* Stage;
  const registry = yield* registryFor("web");
  return yield* Stackit.CloudFoundry.App("Web", {
    spaceId: stage.role.spaceId,
    credentials: stage.credentials,
    main: "./src/web.ts",
    registry,
    memoryInMb: 256,
    env: { GREETING: "hello from an async app" },
  });
});

export type WebEnv = Stackit.InferEnv<typeof Web>;
