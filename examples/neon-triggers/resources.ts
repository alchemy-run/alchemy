import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const resources = Effect.gen(function* () {
  const project = yield* Neon.Project("App", { region: "aws-us-east-2" });
  const branch = yield* Neon.Branch("Backend", { project });
  const uploads = yield* Neon.Bucket("Uploads", { branch });
  return { project, branch, uploads };
});
