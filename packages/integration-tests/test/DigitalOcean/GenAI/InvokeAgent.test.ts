import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { listGenaiAgentApiKeys } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import AgentApp, { Echo } from "./fixtures/agent-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, calls the agent and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App calls an agent through InvokeAgent with its own key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url, agentId } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* AgentApp;
          const agent = yield* Echo;
          return { url: app.url, agentId: agent.agentId };
        }),
      );
      // The binding minted one key for the App.
      const keys = yield* listGenaiAgentApiKeys
        .items({ agent_uuid: agentId })
        .pipe(Stream.runCollect);
      expect(keys.length).toEqual(1);

      yield* waitForAppHost(url);
      const client = yield* HttpClient.HttpClient;
      const answer = yield* client.get(url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(answer.toLowerCase()).toContain("pong");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:genai", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
