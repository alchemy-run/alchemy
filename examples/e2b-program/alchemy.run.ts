// alchemy.run.ts
import * as E2B from "@alchemy.run/e2b";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "E2BProgramExample",
  { providers: E2B.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // One long-lived sandbox serves the program. It pauses when idle and a
    // request to its URL resumes it; a new build of the program replaces it.
    const sandbox = yield* E2B.Sandbox("ApiSandbox", {
      template: Api,
      network: { allowPublicTraffic: true },
    });
    return {
      url: Output.interpolate`https://3000-${sandbox.sandboxId}.${sandbox.domain}`,
      sandboxId: sandbox.sandboxId,
    };
  }),
);
