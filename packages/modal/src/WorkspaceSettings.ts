import * as workspace from "@distilled.cloud/modal/workspace";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { envNameOf, type EnvironmentInput } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export interface WorkspaceSettingsProps {
  /**
   * Environment that Modal clients use when none is named (the `modal` CLI,
   * `environmentName: ""` on the API).
   */
  defaultEnvironment?: EnvironmentInput;
  /**
   * Image builder version for new image builds in the workspace (e.g.
   * `"2025.06"`). Changing it rebuilds images on their next use.
   */
  imageBuilderVersion?: string;
  /**
   * Require authentication on web endpoints and tunnels in environments
   * that inherit the workspace default.
   */
  blockUnauthenticatedResources?: boolean;
}

export interface WorkspaceSettingsAttributes {
  /** The workspace's default environment. */
  defaultEnvironment: string | undefined;
  /** The workspace's image builder version. */
  imageBuilderVersion: string | undefined;
  /** Settings found before the first deploy, restored on destroy. */
  original: {
    defaultEnvironment: string | undefined;
    imageBuilderVersion: string | undefined;
  };
}

/**
 * Workspace-wide Modal settings: the default environment, the image builder
 * version, and whether endpoints in inheriting environments require
 * authentication.
 *
 * A workspace has one set of settings, so declare this resource once. It
 * captures the settings it finds on first deploy and restores them when
 * destroyed.
 *
 * ### Configuring the workspace
 * **Example:** Pin the image builder and default environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Settings = Modal.WorkspaceSettings("Settings", {
 *   defaultEnvironment: Agents,
 *   imageBuilderVersion: "2025.06",
 * });
 * ```
 *
 * @resource
 * @product Workspace
 */
export const WorkspaceSettings = declarable<WorkspaceSettings>()(
  Resource<WorkspaceSettings>("Modal.WorkspaceSettings"),
);

export type WorkspaceSettings = Resource<
  "Modal.WorkspaceSettings",
  WorkspaceSettingsProps,
  WorkspaceSettingsAttributes,
  never,
  Providers
>;

export const WorkspaceSettingsProvider = () =>
  Provider.effect(
    WorkspaceSettings,
    Effect.gen(function* () {
      const observe = workspace.workspaceSettings({});

      return {
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const current = yield* observe;
          return {
            ...output,
            defaultEnvironment: current.defaultEnvironmentName || undefined,
            imageBuilderVersion: current.imageBuilderVersion || undefined,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe
          const current = yield* observe;
          const original = output?.original ?? {
            defaultEnvironment: current.defaultEnvironmentName || undefined,
            imageBuilderVersion: current.imageBuilderVersion || undefined,
          };
          // Sync each setting against the observed value.
          const defaultEnvironment = envNameOf(news.defaultEnvironment);
          if (
            defaultEnvironment !== undefined &&
            defaultEnvironment !== current.defaultEnvironmentName
          ) {
            yield* workspace.workspaceSetDefaultEnvironment({
              environmentName: defaultEnvironment,
            });
          }
          if (
            news.imageBuilderVersion !== undefined &&
            news.imageBuilderVersion !== current.imageBuilderVersion
          ) {
            yield* workspace.workspaceSetImageBuilderVersion({
              newImageBuilderVersion: news.imageBuilderVersion,
            });
          }
          if (news.blockUnauthenticatedResources !== undefined) {
            yield* workspace.workspaceSetDefaultEnvironmentSettings({
              blockUnauthenticatedResources: news.blockUnauthenticatedResources
                ? "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_BLOCK"
                : "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_ALLOW",
            });
          }
          const final = yield* observe;
          return {
            defaultEnvironment: final.defaultEnvironmentName || undefined,
            imageBuilderVersion: final.imageBuilderVersion || undefined,
            original,
          };
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          // Restore what was there before Alchemy managed the settings.
          const current = yield* observe;
          if (
            olds.defaultEnvironment !== undefined &&
            output.original.defaultEnvironment !== undefined &&
            current.defaultEnvironmentName !== output.original.defaultEnvironment
          ) {
            yield* workspace.workspaceSetDefaultEnvironment({
              environmentName: output.original.defaultEnvironment,
            });
          }
          if (
            olds.imageBuilderVersion !== undefined &&
            output.original.imageBuilderVersion !== undefined &&
            current.imageBuilderVersion !== output.original.imageBuilderVersion
          ) {
            yield* workspace.workspaceSetImageBuilderVersion({
              newImageBuilderVersion: output.original.imageBuilderVersion,
            });
          }
          if (olds.blockUnauthenticatedResources !== undefined) {
            yield* workspace.workspaceSetDefaultEnvironmentSettings({
              blockUnauthenticatedResources:
                "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_UNSPECIFIED",
            });
          }
        }),
      };
    }),
  );
