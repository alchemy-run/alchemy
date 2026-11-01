import * as management from "@distilled.cloud/convex/management";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { assertTeam } from "./internal/team.ts";
import type { ProjectAttributes } from "./Project.ts";
import type { Providers } from "./Providers.ts";

export interface DefaultEnvironmentVariablesProps {
  /** The project. Changing it replaces this resource. */
  project: Pick<ProjectAttributes, "projectId" | "teamId">;
  /**
   * Variables every new deployment of the chosen types starts with. A name
   * removed here is deleted. A default set by hand and never listed is left
   * alone. Existing deployments keep their values.
   */
  env: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Which deployment types get these defaults.
   * @default ["dev", "preview", "prod"]
   */
  deploymentTypes?: Array<"dev" | "preview" | "prod" | "custom">;
}

export interface DefaultEnvironmentVariablesAttributes {
  /** The project these defaults belong to. */
  projectId: number;
  /** Numeric ID of the owning team. */
  teamId: number;
  /** The `name/type` pairs this resource set, which are the only ones it deletes. */
  managed: string[];
}

export type DefaultEnvironmentVariables = Resource<
  "Convex.DefaultEnvironmentVariables",
  DefaultEnvironmentVariablesProps,
  DefaultEnvironmentVariablesAttributes,
  never,
  Providers
>;

/**
 * Default environment variables for a Convex project. New deployments start
 * with them, which makes them the way to configure preview deployments that
 * something other than Alchemy creates.
 *
 * ### Setting Defaults
 * **Example:** Defaults for previews
 * ```typescript
 * yield* Convex.DefaultEnvironmentVariables("Defaults", {
 *   project,
 *   deploymentTypes: ["preview"],
 *   env: { API_URL: "https://staging.example.com" },
 * });
 * ```
 *
 * @see https://docs.convex.dev/management-api/update-default-environment-variables
 *
 * @resource
 * @product Projects
 */
export const DefaultEnvironmentVariables = Resource<DefaultEnvironmentVariables>(
  "Convex.DefaultEnvironmentVariables",
);

const DEFAULT_TYPES = ["dev", "preview", "prod"] as const;

const pair = (name: string, type: string) => `${name}/${type}`;
const split = (key: string) => {
  const index = key.lastIndexOf("/");
  return { name: key.slice(0, index), deploymentType: key.slice(index + 1) };
};

const plain = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

export const DefaultEnvironmentVariablesProvider = () =>
  Provider.effect(
    DefaultEnvironmentVariables,
    Effect.succeed({
      stables: ["projectId", "teamId"],
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news)) return undefined;
        if (output !== undefined && news.project.projectId !== output.projectId) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const projectId = news.project.projectId;
        const types = news.deploymentTypes ?? DEFAULT_TYPES;
        const desired = new Map(
          Object.entries(news.env).flatMap(([name, value]) =>
            types.map((type) => [pair(name, type), plain(value)] as const),
          ),
        );

        // Observe the project, never `olds`: someone may have changed a value.
        const { items } = yield* management.listDefaultEnvironmentVariables({
          projectId,
        });
        const observed = new Map(
          items.flatMap((item) =>
            item.deploymentTypes.map((type) => [pair(item.name, type), item.value] as const),
          ),
        );

        // Sync
        const changes = [
          ...[...desired]
            .filter(([key, value]) => observed.get(key) !== value)
            .map(([key, value]) => ({ ...split(key), value: value as string | null })),
          ...(output?.managed ?? [])
            .filter((key) => !desired.has(key) && observed.has(key))
            .map((key) => ({ ...split(key), value: null as string | null })),
        ];
        if (changes.length > 0) {
          yield* session.note(`Updating ${changes.length} default variables...`);
          yield* management.updateDefaultEnvironmentVariables({ projectId, changes });
        }
        return {
          projectId,
          teamId: news.project.teamId,
          managed: [...desired.keys()].toSorted(),
        };
      }),
      // Defaults live on their project and go with it.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* assertTeam(output.teamId, `defaults of project ${output.projectId}`);
        if (output.managed.length === 0) return;
        yield* management
          .updateDefaultEnvironmentVariables({
            projectId: output.projectId,
            changes: output.managed.map((key) => ({ ...split(key), value: null })),
          })
          .pipe(Effect.catchTag("ProjectNotFound", () => Effect.void));
      }),
    }),
  );
