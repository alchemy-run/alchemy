import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  InvokeAgentRuntime,
  type InvokeAgentRuntimeRequest,
} from "./InvokeAgentRuntime.ts";
import type { Runtime } from "./Runtime.ts";

export const InvokeAgentRuntimeHttp = Layer.effect(
  InvokeAgentRuntime,
  Effect.gen(function* () {
    const invokeAgentRuntime = yield* agentcore.invokeAgentRuntime;

    return Effect.fn(function* <R extends Runtime>(runtime: R) {
      const AgentRuntimeArn = yield* runtime.agentRuntimeArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.InvokeAgentRuntime(${runtime}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:InvokeAgentRuntime"],
                  Resource: [
                    runtime.agentRuntimeArn,
                    // qualified invocations target a runtime endpoint
                    // sub-resource of the runtime.
                    Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.InvokeAgentRuntime(${runtime.LogicalId})`,
      )(function* (request: InvokeAgentRuntimeRequest) {
        return yield* invokeAgentRuntime({
          ...request,
          agentRuntimeArn: yield* AgentRuntimeArn,
        });
      });
    });
  }),
);
