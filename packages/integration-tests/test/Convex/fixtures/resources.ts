import * as Convex from "@alchemy.run/convex";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

export const BindingProject = Convex.Project("BindingProject").pipe(RemovalPolicy.destroy());

export const BindingDeployment = Effect.gen(function* () {
  const project = yield* BindingProject;
  return yield* Convex.Deployment("BindingDeployment", { project, type: "preview" });
});
