import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:bedrockagentcore", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (browser custom, code interpreter, gateway, memory, runtime).
// The testing account can't use BedrockAgentCore; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_AGENTCORE)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      // Browser and code interpreter ids are `<name>-<10 alphanumerics>`; an id
      // of another shape is rejected as invalid rather than reported missing.
      const toolId = `${name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 48)}-0000000000`;
      yield* expectAllMissing(stack, {
        "missing-browser-custom": AWS.BedrockAgentCore.BrowserCustom.lookup({ browserId: toolId })
          .browserId,
        "missing-code-interpreter": AWS.BedrockAgentCore.CodeInterpreter.lookup({
          codeInterpreterId: toolId,
        }).codeInterpreterId,
        "missing-gateway": AWS.BedrockAgentCore.Gateway.lookup({ gatewayId: name }).gatewayId,
        "missing-memory": AWS.BedrockAgentCore.Memory.lookup({ memoryId: name }).memoryId,
        "missing-runtime": AWS.BedrockAgentCore.Runtime.lookup({ agentRuntimeId: name })
          .agentRuntimeId,
      });
    }),
  { tags, timeout: 180_000 },
);
