import * as DO from "@distilled.cloud/digitalocean";
import type { ApiWorkspace } from "@distilled.cloud/digitalocean";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type WorkspaceProps = {
  /**
   * Workspace name. Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Description. Updates in place. */
  description?: string;
  /** Agents to keep in this workspace. Moved in place. */
  agentIds?: string[];
};

export type Workspace = Resource<
  "DigitalOcean.GenAI.Workspace",
  WorkspaceProps,
  {
    /** Workspace UUID. */
    workspaceId: string;
    /** Workspace name. */
    name: string;
  },
  never,
  Providers
>;

export type WorkspaceAttributes = Workspace["Attributes"];

/**
 * A GenAI workspace: a group of agents that share access and evaluations.
 * Agents listed in `agentIds` are moved into it.
 *
 * ### Grouping Agents
 * **Example:** A workspace for the support agents
 * ```typescript
 * yield* DigitalOcean.GenAI.Workspace("support", {
 *   description: "Customer support agents",
 *   agentIds: [triage.agentId, billing.agentId],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/GenAI-Platform
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const Workspace = Resource<Workspace>("DigitalOcean.GenAI.Workspace");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (workspace: ApiWorkspace): WorkspaceAttributes => ({
  workspaceId: workspace.uuid,
  name: workspace.name,
});

const observe = (workspaceId: string) =>
  noneIfNotFound(
    DO.getGenaiWorkspace({ workspace_uuid: workspaceId }).pipe(Effect.map((r) => r.workspace)),
  );

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.workspaceId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const observed =
        output === undefined ? Option.none<ApiWorkspace>() : yield* observe(output.workspaceId);
      const workspace = yield* Option.match(observed, {
        onSome: Effect.succeed,
        onNone: () =>
          DO.createGenaiWorkspace({
            name,
            description: news.description,
            agent_uuids: news.agentIds,
          }).pipe(Effect.map((r) => r.workspace)),
      });
      if (
        workspace.name !== name ||
        (news.description !== undefined && workspace.description !== news.description)
      ) {
        yield* DO.updateGenaiWorkspace({
          workspace_uuid: workspace.uuid,
          name,
          description: news.description,
        });
      }
      const present = (workspace.agents ?? []).map((agent) => agent.uuid);
      const missing = (news.agentIds ?? []).filter((agentId) => !present.includes(agentId));
      if (missing.length > 0) {
        yield* DO.updateGenaiAgentsWorkspace({
          workspace_uuid: workspace.uuid,
          agent_uuids: missing,
        });
      }
      return { workspaceId: workspace.uuid, name };
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observe(output.workspaceId);
      if (Option.isNone(observed)) return;
      // A workspace with agents cannot be deleted, and the agents are
      // deleted after it. Move them to the team's default workspace, the
      // oldest one, which DigitalOcean creates with the team's first agent.
      const agentIds = (observed.value.agents ?? []).map((agent) => agent.uuid);
      if (agentIds.length > 0) {
        const { workspaces } = yield* DO.listGenaiWorkspaces({});
        const fallback = [...(workspaces ?? [])]
          .filter((w) => w.uuid !== output.workspaceId)
          .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
        if (fallback !== undefined) {
          yield* DO.updateGenaiAgentsWorkspace({
            workspace_uuid: fallback.uuid,
            agent_uuids: agentIds,
          });
        }
      }
      yield* ignoreNotFound(DO.deleteGenaiWorkspace({ workspace_uuid: output.workspaceId }));
    }),
  });
