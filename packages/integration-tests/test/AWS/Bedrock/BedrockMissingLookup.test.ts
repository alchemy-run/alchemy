import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:bedrock", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (agent, agent alias, data source, knowledge base).
// The testing account can't use Bedrock; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_BEDROCK_AGENTS)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-agent": AWS.Bedrock.Agent.lookup({ agentId: name }).agentId,
        "missing-agent-alias": AWS.Bedrock.AgentAlias.lookup({
          agentId: name,
          agentAliasName: name,
        }).agentId,
        "missing-data-source": AWS.Bedrock.DataSource.lookup({
          knowledgeBaseId: name,
          dataSourceId: name,
        }).knowledgeBaseId,
        "missing-knowledge-base": AWS.Bedrock.KnowledgeBase.lookup({ knowledgeBaseId: name })
          .knowledgeBaseId,
      });
    }),
  { tags, timeout: 180_000 },
);
