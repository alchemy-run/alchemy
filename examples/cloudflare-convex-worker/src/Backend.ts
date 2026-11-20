// src/Backend.ts
import * as Convex from "@alchemy.run/convex";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

export const Project = Convex.Project("Project").pipe(RemovalPolicy.destroy());

export const Backend = Effect.gen(function* () {
  const project = yield* Project;
  return yield* Convex.Deployment("Backend", { project, type: "preview" });
});
