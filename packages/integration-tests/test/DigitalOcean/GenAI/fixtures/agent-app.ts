import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const AgentProject = DigitalOcean.Project("AgentProject", {});

export const Echo = Effect.gen(function* () {
  const project = yield* AgentProject;
  return yield* DigitalOcean.GenAI.Agent("Echo", {
    projectId: project.projectId,
    model: "Ministral 3 14B",
    instruction: "Reply with exactly the word the user asks for, in lowercase, and nothing else.",
  });
});

/** Asks the agent for a word through `InvokeAgent`, with the App's own key. */
export default class AgentApp extends DigitalOcean.App<AgentApp>()(
  "AgentApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const agent = yield* Echo;
    const echo = yield* DigitalOcean.GenAI.InvokeAgent(agent);
    return {
      fetch: Effect.gen(function* () {
        const answer = yield* echo.ask("Reply with the word: pong");
        return HttpServerResponse.text(answer);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.GenAI.InvokeAgentHttp)),
) {}
