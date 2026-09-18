import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const project = Neon.Project("AuthProject", { region: "aws-us-east-2" });
export const branch = Effect.gen(function* () {
  return yield* Neon.Branch("AuthBranch", { project: yield* project });
});
export const auth = Effect.gen(function* () {
  return yield* Neon.Auth("ManagedAuth", {
    branch: yield* branch,
    name: "Alchemy Neon Auth",
    allowLocalhost: false,
    emailAndPassword: {
      enabled: true,
      require_email_verification: false,
      send_verification_email_on_sign_up: false,
    },
  });
});
