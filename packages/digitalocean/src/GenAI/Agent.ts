import * as DO from "@distilled.cloud/digitalocean";
import type { ApiAgent } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";

export type AgentProps = {
  /**
   * Agent name. A change renames the agent in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * The model, by its UUID or its name in the GenAI model catalog (for
   * example `"Ministral 3 14B"`). Updates in place.
   */
  model: string;
  /** System instructions the agent follows. Updates in place. */
  instruction: string;
  /** Project the agent belongs to. A change replaces the agent. */
  projectId: string;
  /** Region the agent runs in. A change replaces the agent. @default "tor1" */
  region?: string;
  /** Free-form description. */
  description?: string;
  /** Knowledge bases the agent retrieves from. Updates in place. */
  knowledgeBaseIds?: string[];
  /** Sampling temperature, 0 to 1. */
  temperature?: number;
  /** Most tokens per response. */
  maxTokens?: number;
  /**
   * Functions the agent can call: DigitalOcean Functions, described by
   * name, purpose and JSON schemas. Added, changed and removed in place.
   */
  functions?: AgentFunction[];
  /**
   * Other agents this agent hands a conversation to, each when its
   * condition holds. Added, changed and removed in place.
   */
  routes?: AgentRoute[];
  /** Guardrails to apply, by UUID, in priority order. Updates in place. */
  guardrails?: { guardrailId: string; priority?: number }[];
};

/** A function the agent can call. */
export interface AgentFunction {
  /** Name the model calls the function by. */
  name: string;
  /** What the function does; the model reads it to decide when to call. */
  description: string;
  /** The Functions namespace id (`fn-<uuid>`). */
  namespaceId: string;
  /** The function's name in the namespace (a `Functions.Action`'s `name`). */
  function: string;
  /** The parameters the model passes, sent to the function as query parameters. */
  parameters?: { name: string; type: string; required?: boolean; description?: string }[];
  /** The fields of the function's result. */
  returns?: { name: string; type: string; description?: string }[];
}

/** A hand-off to another agent. */
export interface AgentRoute {
  /** The agent to hand off to. */
  agentId: string;
  /** Route name. */
  name: string;
  /** When to hand off, in plain language. */
  when: string;
}

export type Agent = Resource<
  "DigitalOcean.GenAI.Agent",
  AgentProps,
  {
    /** Agent UUID. */
    agentId: string;
    /** Agent name. */
    name: string;
    /** Chat endpoint of the deployed agent. */
    endpoint: string | undefined;
    /** `STATUS_RUNNING` once the agent answers. */
    status: string | undefined;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type AgentAttributes = Agent["Attributes"];

/**
 * A DigitalOcean GenAI Platform agent: a hosted model with your
 * instructions and optional knowledge bases behind a private chat endpoint.
 * Call it with an `AgentApiKey` and the `InvokeAgent` binding. The model,
 * instructions, knowledge bases and tuning update in place; `projectId` and
 * `region` replace the agent.
 *
 * ### Creating an Agent
 * **Example:** A support agent that answers from your docs
 * ```typescript
 * const project = yield* DigitalOcean.Project("support", {});
 * const docs = yield* DigitalOcean.GenAI.KnowledgeBase("docs", {
 *   projectId: project.projectId,
 *   embeddingModel: "GTE Large EN v1.5",
 *   sources: [{ webCrawler: { baseUrl: "https://docs.example.com" } }],
 * });
 * const agent = yield* DigitalOcean.GenAI.Agent("support", {
 *   projectId: project.projectId,
 *   model: "Ministral 3 14B",
 *   instruction: "Answer questions about Example Corp. using the docs.",
 *   knowledgeBaseIds: [docs.knowledgeBaseId],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/GenAI-Platform
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const Agent = Resource<Agent>("DigitalOcean.GenAI.Agent");

export class AgentWaitTimedOut extends Data.TaggedError("DigitalOcean.GenAI.AgentWaitTimedOut")<{
  readonly agentId: string;
  readonly lastStatus: string | undefined;
}> {
  override get message() {
    return `Agent ${this.agentId} timed out waiting to deploy (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

export class ModelNotFound extends Data.TaggedError("DigitalOcean.GenAI.ModelNotFound")<{
  readonly model: string;
}> {
  override get message() {
    return `No GenAI model has the UUID or name '${this.model}'.`;
  }
}

// An agent deploys in one to three minutes (≈ 8 min budget).
const DEPLOY_POLL: PollBudget = { maxDelay: "10 seconds", times: 48 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

/** A model UUID, or the UUID of the catalog model with this name or id. */
export const resolveModel = (
  model: string,
  usecase: "MODEL_USECASE_AGENT" | "MODEL_USECASE_KNOWLEDGEBASE" = "MODEL_USECASE_AGENT",
) =>
  UUID.test(model)
    ? Effect.succeed(model)
    : DO.listGenaiModels.items({ per_page: 200, usecases: [usecase] }).pipe(
        Stream.filter((m) => m.name === model || m.id === model),
        Stream.runHead,
        Effect.flatMap((found) =>
          Effect.fromOption(Option.flatMapNullishOr(found, (m) => m.uuid)).pipe(
            Effect.mapError(() => new ModelNotFound({ model })),
          ),
        ),
      );

const toAttrs = (agent: ApiAgent): AgentAttributes => ({
  agentId: agent.uuid,
  name: agent.name,
  endpoint: agent.deployment?.url,
  status: agent.deployment?.status,
  createdAt: agent.created_at,
});

const observeById = (agentId: string) =>
  noneIfNotFound(DO.getGenaiAgent({ uuid: agentId }).pipe(Effect.map((r) => r.agent)));

// The listing returns a summary; the agent itself is read by its uuid.
const observeByName = (name: string) =>
  DO.listGenaiAgents.items({ per_page: 200 }).pipe(
    Stream.filter((agent) => agent.name === name && agent.uuid !== undefined),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (agent) => observeById(agent.uuid!),
      }),
    ),
  );

export const AgentProvider = () =>
  Provider.succeed(Agent, {
    stables: ["agentId", "createdAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.agentId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      if (olds.name !== undefined) return undefined;
      const generatedName = yield* physicalName(id);
      const named = yield* observeByName(generatedName);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.projectId !== olds.projectId ||
        (news.region ?? "tor1") !== (olds.region ?? "tor1")
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const modelUuid = yield* resolveModel(news.model);
      const byId = output === undefined ? Option.none() : yield* observeById(output.agentId);
      const observed = Option.isSome(byId)
        ? byId
        : news.name === undefined
          ? yield* observeByName(name)
          : Option.none<ApiAgent>();
      const agent = yield* Option.match(observed, {
        onNone: () =>
          DO.createGenaiAgent({
            name,
            model_uuid: modelUuid,
            instruction: news.instruction,
            project_id: news.projectId,
            region: news.region ?? "tor1",
            description: news.description,
          }).pipe(Effect.map((r) => r.agent)),
        onSome: Effect.succeed,
      });

      const inSync =
        agent.name === name &&
        agent.model?.uuid === modelUuid &&
        agent.instruction === news.instruction &&
        (news.description === undefined || agent.description === news.description) &&
        (news.temperature === undefined || agent.temperature === news.temperature) &&
        (news.maxTokens === undefined || agent.max_tokens === news.maxTokens);
      if (!inSync) {
        yield* DO.updateGenaiAgent({
          uuid: agent.uuid,
          name,
          model_uuid: modelUuid,
          instruction: news.instruction,
          description: news.description,
          temperature: news.temperature,
          max_tokens: news.maxTokens,
        });
      }

      const attached = (agent.knowledge_bases ?? []).flatMap((kb) => (kb.uuid ? [kb.uuid] : []));
      const desired = news.knowledgeBaseIds ?? [];
      if (!setEquals(attached, desired)) {
        for (const kb of Arr.difference(desired, attached)) {
          yield* DO.attachGenaiKnowledgeBase({ agent_uuid: agent.uuid, knowledge_base_uuid: kb });
        }
        for (const kb of Arr.difference(attached, desired)) {
          yield* DO.detachGenaiKnowledgeBase({ agent_uuid: agent.uuid, knowledge_base_uuid: kb });
        }
      }

      // Functions, by the name the model calls them.
      const observedFunctions = new Map(
        (agent.functions ?? []).flatMap((fn) => (fn.name ? [[fn.name, fn] as const] : [])),
      );
      const desiredFunctions = news.functions ?? [];
      for (const fn of desiredFunctions) {
        const wire = {
          function_name: fn.name,
          description: fn.description,
          faas_namespace: fn.namespaceId,
          // The platform addresses a function as `package/name`.
          faas_name: fn.function.includes("/") ? fn.function : `default/${fn.function}`,
          input_schema: {
            parameters: (fn.parameters ?? []).map((p) => ({
              name: p.name,
              in: "query",
              schema: { type: p.type },
              required: p.required ?? false,
              description: p.description ?? p.name,
            })),
          },
          output_schema: {
            properties: (fn.returns ?? []).map((r) => ({
              name: r.name,
              type: r.type,
              description: r.description ?? r.name,
            })),
          },
        };
        const current = observedFunctions.get(fn.name);
        if (current?.uuid === undefined) {
          yield* DO.attachGenaiAgentFunction({ agent_uuid: agent.uuid, ...wire });
        } else if (
          current.description !== fn.description ||
          current.faas_namespace !== fn.namespaceId ||
          current.faas_name !== wire.faas_name ||
          JSON.stringify(current.input_schema ?? {}) !== JSON.stringify(wire.input_schema) ||
          JSON.stringify(current.output_schema ?? {}) !== JSON.stringify(wire.output_schema)
        ) {
          yield* DO.updateGenaiAgentFunction({
            agent_uuid: agent.uuid,
            function_uuid: current.uuid,
            ...wire,
          });
        }
      }
      for (const [fnName, fn] of observedFunctions) {
        if (fn.uuid === undefined || desiredFunctions.some((d) => d.name === fnName)) continue;
        yield* ignoreNotFound(
          DO.detachGenaiAgentFunction({ agent_uuid: agent.uuid, function_uuid: fn.uuid }),
        );
      }

      // Routes, by the child agent they hand off to.
      const observedRoutes = new Map(
        (agent.child_agents ?? []).map((child) => [child.uuid, child]),
      );
      const desiredRoutes = news.routes ?? [];
      for (const route of desiredRoutes) {
        const current = observedRoutes.get(route.agentId);
        const wire = {
          parent_agent_uuid: agent.uuid,
          child_agent_uuid: route.agentId,
          route_name: route.name,
          if_case: route.when,
        };
        if (current === undefined) {
          yield* DO.attachGenaiAgent(wire);
        } else if (current.route_name !== route.name || current.if_case !== route.when) {
          yield* DO.updateGenaiAttachedAgent({ ...wire, uuid: current.route_uuid });
        }
      }
      for (const childId of observedRoutes.keys()) {
        if (desiredRoutes.some((r) => r.agentId === childId)) continue;
        yield* ignoreNotFound(
          DO.detachGenaiAgent({ parent_agent_uuid: agent.uuid, child_agent_uuid: childId }),
        );
      }

      // Guardrails, by UUID.
      const attachedGuardrails = (agent.guardrails ?? []).flatMap((g) =>
        g.guardrail_uuid && g.is_attached !== false ? [g.guardrail_uuid] : [],
      );
      const desiredGuardrails = news.guardrails ?? [];
      const missingGuardrails = desiredGuardrails.filter(
        (g) => !attachedGuardrails.includes(g.guardrailId),
      );
      if (missingGuardrails.length > 0) {
        yield* DO.attachGenaiAgentGuardrails({
          agent_uuid: agent.uuid,
          guardrails: missingGuardrails.map((g, i) => ({
            guardrail_uuid: g.guardrailId,
            priority: g.priority ?? i + 1,
          })),
        });
      }
      for (const guardrailId of attachedGuardrails) {
        if (desiredGuardrails.some((g) => g.guardrailId === guardrailId)) continue;
        yield* ignoreNotFound(
          DO.detachGenaiAgentGuardrail({ agent_uuid: agent.uuid, guardrail_uuid: guardrailId }),
        );
      }

      const deployed = yield* pollUntil(observeById(agent.uuid), {
        ...DEPLOY_POLL,
        until: (o): o is Option.Some<ApiAgent> =>
          Option.isSome(o) && o.value.deployment?.status === "STATUS_RUNNING",
        onTimeout: (last) =>
          new AgentWaitTimedOut({
            agentId: agent.uuid,
            lastStatus: Option.getOrUndefined(last)?.deployment?.status,
          }),
      });
      return toAttrs(deployed.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteGenaiAgent({ uuid: output.agentId }));
    }),
  });
