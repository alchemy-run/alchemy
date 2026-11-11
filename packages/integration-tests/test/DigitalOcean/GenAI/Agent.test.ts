import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getDatabaseCluster,
  getGenaiAgent,
  getGenaiKnowledgeBase,
  listGenaiAgentApiKeys,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:genai", "live"];
const MODEL = "OpenAI GPT-oss-120b";

const resources = (instruction: string, attach: boolean) =>
  Effect.gen(function* () {
    const project = yield* DigitalOcean.Project("Project", {});
    const docs = yield* DigitalOcean.GenAI.KnowledgeBase("Docs", {
      projectId: project.projectId,
      embeddingModel: "GTE Large EN v1.5",
      sources: [{ webCrawler: { baseUrl: "https://example.com" } }],
    });
    const agent = yield* DigitalOcean.GenAI.Agent("Agent", {
      projectId: project.projectId,
      model: MODEL,
      instruction,
      knowledgeBaseIds: attach ? [docs.knowledgeBaseId] : [],
    });
    const key = yield* DigitalOcean.GenAI.AgentApiKey("Key", { agentId: agent.agentId });
    return { agent, docs, key };
  });

// A knowledge base provisions an OpenSearch cluster, which takes minutes.
test.provider.skipIf(skipSlow)(
  "agent with a knowledge base: create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(resources("Answer in one word.", true));
      expect(created.agent.endpoint).toMatch(/^https:\/\//);
      const live = (yield* getGenaiAgent({ uuid: created.agent.agentId })).agent;
      expect(live.instruction).toEqual("Answer in one word.");
      expect(live.model?.name).toEqual(MODEL);
      expect((live.knowledge_bases ?? []).map((kb) => kb.uuid)).toEqual([
        created.docs.knowledgeBaseId,
      ]);
      const kb = (yield* getGenaiKnowledgeBase({ uuid: created.docs.knowledgeBaseId }))
        .knowledge_base;
      expect(kb.database_id).toBeDefined();
      const keys = yield* listGenaiAgentApiKeys
        .items({ agent_uuid: created.agent.agentId })
        .pipe(Stream.runCollect);
      expect(keys.map((k) => k.uuid)).toContain(created.key.apiKeyId);

      // The instruction changes and the knowledge base detaches in place.
      const updated = yield* stack.deploy(resources("Answer in two words.", false));
      expect(updated.agent.agentId).toEqual(created.agent.agentId);
      expect(updated.key.apiKeyId).toEqual(created.key.apiKeyId);
      const after = (yield* getGenaiAgent({ uuid: created.agent.agentId })).agent;
      expect(after.instruction).toEqual("Answer in two words.");
      expect(after.knowledge_bases ?? []).toEqual([]);

      // Redeploying unchanged plans no updates.
      const plan = yield* stack.plan(resources("Answer in two words.", false));
      expect(Object.values(plan.resources).filter((node) => node.action !== "noop")).toEqual([]);

      yield* stack.destroy();
      expect(yield* isGone(getGenaiAgent({ uuid: created.agent.agentId }))).toBe(true);
      expect(yield* isGone(getGenaiKnowledgeBase({ uuid: created.docs.knowledgeBaseId }))).toBe(
        true,
      );
      // The OpenSearch cluster DigitalOcean provisioned goes with it.
      expect(yield* isGone(getDatabaseCluster({ database_cluster_uuid: kb.database_id! }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 2_400_000 },
);
