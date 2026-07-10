import * as SVC from "@distilled.cloud/aws/codebuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Project } from "./Project.ts";
import { StartBuild, type StartBuildRequest } from "./StartBuild.ts";

export const StartBuildHttp = Layer.effect(
  StartBuild,
  Effect.gen(function* () {
    const startBuild = yield* SVC.startBuild;

    return Effect.fn(function* <P extends Project>(project: P) {
      const ProjectName = yield* project.projectName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CodeBuild.StartBuild(${project}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "codebuild:StartBuild",
                    "codebuild:StopBuild",
                    "codebuild:BatchGetBuilds",
                  ],
                  Resource: [project.projectArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CodeBuild.StartBuild(${project.LogicalId})`)(
        function* (request?: StartBuildRequest) {
          const projectName = yield* ProjectName;
          return yield* startBuild({ ...request, projectName });
        },
      );
    });
  }),
);
