import * as Effect from "effect/Effect";
import { Branch } from "@/Neon/Branch";
import { Project } from "@/Neon/Project";

export const ConnectProject = Project("ConnectProject", {
  region: "aws-us-east-2",
});
export const ConnectBranch = Effect.gen(function* () {
  const project = yield* ConnectProject;
  return yield* Branch("ConnectBranch", { project });
});
