import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export interface AgentPushTrigger {
  /**
   * Branch globs (`main`, `release/*`); the agent runs only on a Change
   * whose branch matches one. Empty matches every branch.
   */
  branches?: string[];
  /**
   * Path globs (`frontend/**`, `**\/*.go`); the agent runs only on a Change
   * that touches a matching path. Empty matches every Change.
   */
  paths?: string[];
  /**
   * Which Changes it runs on by readiness for review: `ready`, `always` or
   * `not_ready`.
   * @default "ready"
   */
  when?: "ready" | "always" | "not_ready";
}

export type AgentProps = {
  /** ID of the project the agent belongs to. Changing it replaces the agent. */
  projectId: string;
  /**
   * Display name, unique among the project's active agents (ignoring case).
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /** Free-form description. */
  description?: string;
  /** The agent CLI that runs the instructions. */
  harness: "claude" | "codex";
  /** What the agent reviews or does. Supports `{{branch}}` and `{{base_branch}}`. */
  instructions: string;
  /**
   * Model passed to the harness, one of the IDs
   * `Entire.agents.listAgentModels` lists for it.
   * @default the harness default
   */
  model?: string;
  /**
   * Reasoning effort, one the model supports.
   * @default the harness default
   */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** ID of the {@link Environment} the agent runs in. */
  environmentId: string;
  /** IDs of the project's repositories the agent works on (1–100). */
  repositoryIds: string[];
  /**
   * Run the agent on pushes to open Changes. Omit for an agent that runs
   * only when asked.
   */
  trigger?: AgentPushTrigger;
  /**
   * Whether the trigger runs the agent. Manual runs ignore it.
   * @default false
   */
  enabled?: boolean;
  /**
   * Run timeout in milliseconds.
   * @default 1200000
   */
  timeoutMs?: number;
  /**
   * The reading the agent reports on each Change: a `boolean`, a `percent`
   * (0–100) or a `size` (small, medium, large), and which readings are
   * good.
   * @default { valueType: "boolean", polarity: "lower_is_better" }
   */
  signal?: {
    valueType: "boolean" | "percent" | "size";
    polarity?: "higher_is_better" | "lower_is_better" | "neutral";
  };
};

export type Agent = Resource<
  "Entire.Agent",
  AgentProps,
  {
    /** Agent ID (ULID), stable across versions. */
    id: string;
    /** ID of the owning project. */
    projectId: string;
    name: string;
    harness: string;
    model: string | undefined;
    environmentId: string;
    repositoryIds: string[];
    enabled: boolean;
    /** Current version; each replace saves a new one. */
    version: number;
  },
  never,
  Providers
>;

/**
 * A custom Entire agent: instructions for Claude Code or Codex that run in
 * an {@link Environment} against a project's repositories, on demand or on
 * every push to an open Change. Saving an agent starts no run.
 *
 * Every change saves a new version. Entire never deletes agents, so delete
 * archives it.
 *
 * ### Creating an Agent
 * **Example:** A reviewer that runs on every ready Change
 * ```typescript
 * const sandbox = yield* Entire.Environment("sandbox", { projectId: project.id });
 *
 * yield* Entire.Agent("reviewer", {
 *   projectId: project.id,
 *   harness: "claude",
 *   instructions: "Review {{branch}} against {{base_branch}} for security issues.",
 *   environmentId: sandbox.id,
 *   repositoryIds: [repo.id],
 *   trigger: { branches: ["**"], when: "ready" },
 *   enabled: true,
 * });
 * ```
 *
 * **Example:** An on-demand agent on a pinned model
 * ```typescript
 * yield* Entire.Agent("migrator", {
 *   projectId: project.id,
 *   harness: "codex",
 *   model: "gpt-6.1-sol",
 *   reasoningEffort: "high",
 *   instructions: "Migrate the touched files to the new logger API.",
 *   environmentId: sandbox.id,
 *   repositoryIds: [repo.id],
 * });
 * ```
 *
 * @resource
 * @product Agent
 */
export const Agent = Resource<Agent>("Entire.Agent");

const toAttrs = (agent: Entire.agents.Agent) => ({
  id: agent.id,
  projectId: agent.project_id,
  name: agent.name,
  harness: agent.harness,
  model: agent.model ?? undefined,
  environmentId: agent.environment_id,
  repositoryIds: [...(agent.repository_ids ?? [])],
  enabled: agent.is_enabled,
  version: agent.version as number,
});

/** The timeout Entire's own review presets use. */
const DEFAULT_TIMEOUT_MS = 1_200_000;

const sorted = (xs: ReadonlyArray<string> | null | undefined) => [...(xs ?? [])].sort();

export const AgentProvider = () =>
  Provider.effect(
    Agent,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const agentName = (id: string, props: { name?: string }) =>
        props.name ? Effect.succeed(props.name) : createPhysicalName({ id, maxLength: 128 });

      const getActive = Effect.fn(function* (projectId: string, agentId: string) {
        const { host, project, cell } = yield* client.project(projectId);
        const agent = yield* cell(
          Entire.agents.getProjectAgent({ host, project, id: agentId }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        return agent && agent.archived_at === null ? agent : undefined;
      });

      const findByName = Effect.fn(function* (projectId: string, name: string) {
        const { host, project, cell } = yield* client.project(projectId);
        return yield* cell(
          Entire.agents.listProjectAgents.items({ host, project }).pipe(
            Stream.filter(
              (a) => a.name.toLowerCase() === name.toLowerCase() && a.archived_at === null,
            ),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );
      });

      return {
        stables: ["id", "projectId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.projectId !== output.projectId) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const agent = yield* getActive(output.projectId, output.id);
          return agent ? toAttrs(agent) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const name = yield* agentName(id, news);
          const { host, project, cell } = yield* client.project(news.projectId);
          const triggers = news.trigger
            ? [
                {
                  kind: "push" as const,
                  branches: news.trigger.branches ?? [],
                  paths: news.trigger.paths ?? [],
                  when: news.trigger.when ?? "ready",
                },
              ]
            : [];
          const desired = {
            name,
            description: news.description ?? "",
            harness: news.harness,
            instructions: news.instructions,
            model: news.model ?? null,
            reasoning_effort: news.reasoningEffort ?? null,
            environment_id: news.environmentId,
            repository_ids: news.repositoryIds,
            is_enabled: news.enabled ?? false,
            triggers,
            timeout_ms: news.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            signal: {
              value_type: news.signal?.valueType ?? "boolean",
              polarity: news.signal?.polarity ?? "lower_is_better",
            },
          };

          // Observe
          const observed = output?.id
            ? yield* getActive(news.projectId, output.id)
            : yield* findByName(news.projectId, name);

          // Ensure -- the instance id is a stable Idempotency-Key.
          if (!observed) {
            return toAttrs(
              yield* cell(
                Entire.agents.createProjectAgent({
                  host,
                  project,
                  idempotencyKey: instanceId,
                  ...desired,
                }),
              ),
            );
          }

          // Sync -- compare the fields this resource owns; replace saves a
          // new version only when one differs.
          const observedTriggers = (observed.triggers ?? []).map((t) => ({
            kind: t.kind,
            branches: [...(t.branches ?? [])],
            paths: [...(t.paths ?? [])],
            when: t.when,
          }));
          const same =
            observed.name === desired.name &&
            observed.description === desired.description &&
            observed.harness === desired.harness &&
            observed.instructions === desired.instructions &&
            (observed.model ?? null) === desired.model &&
            (news.reasoningEffort === undefined ||
              observed.reasoning_effort === desired.reasoning_effort) &&
            observed.environment_id === desired.environment_id &&
            JSON.stringify(sorted(observed.repository_ids)) ===
              JSON.stringify(sorted(desired.repository_ids)) &&
            observed.is_enabled === desired.is_enabled &&
            JSON.stringify(observedTriggers) === JSON.stringify(triggers) &&
            observed.timeout_ms === desired.timeout_ms &&
            observed.signal.value_type === desired.signal.value_type &&
            observed.signal.polarity === desired.signal.polarity;
          if (same) return toAttrs(observed);
          return toAttrs(
            yield* cell(
              Entire.agents.replaceProjectAgent({
                host,
                project,
                id: observed.id,
                ifMatch: observed.etag,
                ...desired,
              }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const agent = yield* getActive(output.projectId, output.id).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!agent) return;
          const { host, project, cell } = yield* client.project(output.projectId);
          yield* cell(
            Entire.agents.archiveProjectAgent({ host, project, id: agent.id, ifMatch: agent.etag }),
          ).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
