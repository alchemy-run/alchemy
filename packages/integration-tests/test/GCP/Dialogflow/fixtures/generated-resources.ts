import * as GCP from "@alchemy.run/gcp";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** Dialogflow resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeSecuritySetting = GCP.Dialogflow.SecuritySetting("ProbeSecuritySetting", {
  location: "global",
  displayName: "session-only",
  retentionStrategy: "REMOVE_AFTER_CONVERSATION",
});

/** The CX agent every agent-scoped probe binds, and its children. */
export const ProbeAgent = GCP.Dialogflow.Agent("ProbeAgent", {
  location: "global",
  displayName: "alchemy-probe",
});
const onAgent = <A>(make: (agent: Output.Output<string>) => Effect.Effect<A, never, any>) =>
  Effect.gen(function* () {
    const agent = yield* ProbeAgent;
    return yield* make(agent.name);
  });
export const ProbeEntityType = onAgent((agent) =>
  GCP.Dialogflow.AgentsEntityType("ProbeEntityType", {
    agent,
    displayName: "color",
    kind: "KIND_MAP",
    entities: [{ value: "red", synonyms: ["red"] }],
  }),
);
export const ProbeFlow = onAgent((agent) =>
  GCP.Dialogflow.AgentsFlow("ProbeFlow", { agent, displayName: "ordering" }),
);
const onFlow = <A>(make: (flow: Output.Output<string>) => Effect.Effect<A, never, any>) =>
  Effect.gen(function* () {
    const flow = yield* ProbeFlow;
    return yield* make(flow.name);
  });
export const ProbePage = onFlow((flow) =>
  GCP.Dialogflow.AgentsFlowsPage("ProbePage", { flow, displayName: "greeting" }),
);
export const ProbeFlowRouteGroup = onFlow((flow) =>
  GCP.Dialogflow.AgentsFlowsTransitionRouteGroup("ProbeFlowRouteGroup", {
    flow,
    displayName: "fallback",
    transitionRoutes: [
      { condition: "true", triggerFulfillment: { messages: [{ text: { text: ["ok"] } }] } },
    ],
  }),
);
export const ProbeFlowVersion = onFlow((flow) =>
  GCP.Dialogflow.AgentsFlowsVersion("ProbeFlowVersion", { flow, displayName: "v1" }),
);
export const ProbeGenerator = onAgent((agent) =>
  GCP.Dialogflow.AgentsGenerator("ProbeGenerator", {
    agent,
    displayName: "greeting",
    promptText: "Greet the user by name.",
  }),
);
export const ProbeIntent = onAgent((agent) =>
  GCP.Dialogflow.AgentsIntent("ProbeIntent", {
    agent,
    displayName: "hello",
    trainingPhrases: [{ parts: [{ text: "hello" }], repeatCount: 1 }],
  }),
);
export const ProbePlaybook = onAgent((agent) =>
  GCP.Dialogflow.AgentsPlaybook("ProbePlaybook", {
    agent,
    displayName: "support",
    goal: "Answer the user's support question.",
  }),
);
export const ProbeTool = onAgent((agent) =>
  GCP.Dialogflow.AgentsTool("ProbeTool", {
    agent,
    displayName: "lookup",
    description: "Look up an order.",
    functionSpec: {
      inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
      outputSchema: { type: "object", properties: { status: { type: "string" } } },
    },
  }),
);
export const ProbeRouteGroup = onAgent((agent) =>
  GCP.Dialogflow.AgentsTransitionRouteGroup("ProbeRouteGroup", {
    agent,
    displayName: "g1",
    transitionRoutes: [
      { condition: "true", triggerFulfillment: { messages: [{ text: { text: ["ok"] } }] } },
    ],
  }),
);
export const ProbeWebhook = onAgent((agent) =>
  GCP.Dialogflow.AgentsWebhook("ProbeWebhook", {
    agent,
    displayName: "orders",
    genericWebService: { uri: "https://example.com/dialogflow" },
  }),
);
