import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const project = Neon.Project("AIProject", { region: "aws-us-east-2" });
export const branch = Effect.gen(function* () {
  return yield* Neon.Branch("AIBranch", { project: yield* project });
});
export const gateway = Effect.gen(function* () {
  return yield* Neon.AIGateway("Gateway", { branch: yield* branch });
});
