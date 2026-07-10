import * as SVC from "@distilled.cloud/aws/codebuild";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { BatchGetBuilds } from "./BatchGetBuilds.ts";
import type { Project } from "./Project.ts";

export const BatchGetBuildsHttp = Layer.effect(
  BatchGetBuilds,
  Effect.gen(function* () {
    const batchGetBuilds = yield* SVC.batchGetBuilds;

    return Effect.fn(function* <P extends Project>(project: P) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CodeBuild.BatchGetBuilds(${project}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["codebuild:BatchGetBuilds"],
                  Resource: [project.projectArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CodeBuild.BatchGetBuilds(${project.LogicalId})`)(
        function* (request: SVC.BatchGetBuildsInput) {
          return yield* batchGetBuilds(request);
        },
      );
    });
  }),
);
