import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { StartJob } from "./StartJob.ts";

export const StartJobHttp = Layer.effect(
  StartJob,
  Effect.gen(function* () {
    const op = yield* location.startJob;

    return Effect.fn(function* (executionRole: Role) {
      const RoleArn = yield* executionRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Location.StartJob(${executionRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["geo:StartJob"],
                  // Jobs are created by the call itself — their ARNs are
                  // unknowable at deploy time.
                  Resource: ["*"],
                },
                // CRITICAL: without iam:PassRole on the execution role,
                // StartJob fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${executionRole.roleArn}`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Location.StartJob(${executionRole.LogicalId})`)(
        function* (
          request: Omit<location.StartJobRequest, "ExecutionRoleArn"> & {
            ExecutionRoleArn?: string;
          },
        ) {
          return yield* op({
            ...request,
            ExecutionRoleArn: request.ExecutionRoleArn ?? (yield* RoleArn),
          });
        },
      );
    });
  }),
);
