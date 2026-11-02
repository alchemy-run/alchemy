import * as management from "@distilled.cloud/convex/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { team } from "./Credentials.ts";
import { findStoredKey } from "./internal/keys.ts";
import { createOnce } from "./internal/retry.ts";
import { assertTeam } from "./internal/team.ts";
import type { ProjectAttributes } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/** Convex accepted a key but its listing doesn't show it. */
export class PreviewDeployKeyNotListed extends Data.TaggedError("PreviewDeployKeyNotListed")<{
  readonly message: string;
}> {}

export interface PreviewDeployKeyProps {
  /** The project previews are created in. Changing it replaces the key. */
  project: Pick<ProjectAttributes, "projectId">;
  /**
   * Key name. If omitted, a unique name is generated. Convex keeps a repeated
   * name by appending a UUID. Changing it replaces the key.
   */
  name?: string;
  /** Timestamp in milliseconds when the key stops working. Changing it replaces the key. */
  expiresAt?: number;
}

export interface PreviewDeployKeyAttributes {
  /** Numeric key ID. */
  keyId: number;
  /** The exact name Convex stored. */
  name: string;
  /** The project previews are created in. */
  projectId: number;
  /** The key. Convex returns it only at creation, so it lives in state. */
  value: Redacted.Redacted<string>;
  /** Timestamp in milliseconds when the key stops working, if ever. */
  expiresAt: number | undefined;
  /** Numeric ID of the owning team. */
  teamId: number;
}

export type PreviewDeployKey = Resource<
  "Convex.PreviewDeployKey",
  PreviewDeployKeyProps,
  PreviewDeployKeyAttributes,
  never,
  Providers
>;

/**
 * A preview deploy key. Set it as `CONVEX_DEPLOY_KEY` and `convex deploy
 * --preview-create <name>` creates a preview, which suits a hosting provider's
 * build step.
 * @see https://docs.convex.dev/production/hosting/preview-deployments
 *
 * ### Rotation
 * Convex shows a key only when it is created, so adopting an existing key
 * deletes it and creates a new one with the same name.
 *
 * ### Creating a key
 * **Example:** Preview key for a project
 * ```typescript
 * const key = yield* Convex.PreviewDeployKey("Preview", { project });
 * ```
 *
 * @resource
 * @product PreviewDeployKey
 */
export const PreviewDeployKey = Resource<PreviewDeployKey>("Convex.PreviewDeployKey");

const toAttrs = Effect.fn(function* (
  key: management.PlatformDeployKeyResponse,
  projectId: number,
  value: Redacted.Redacted<string>,
) {
  return {
    keyId: key.id,
    name: key.name,
    projectId,
    teamId: yield* team,
    value,
    expiresAt: key.expiresAt ?? undefined,
  } satisfies PreviewDeployKeyAttributes;
});

export const PreviewDeployKeyProvider = () =>
  Provider.effect(
    PreviewDeployKey,
    Effect.gen(function* () {
      const keyName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({ id, lowercase: true, maxLength: 64, delimiter: "-" });

      const list = (projectId: number) =>
        management.listPreviewDeployKeys({ projectId }).pipe(
          Effect.map((response) => response.items),
          Effect.catchTag("ProjectNotFound", () =>
            Effect.succeed([] as readonly management.PlatformDeployKeyResponse[]),
          ),
        );

      return {
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (
            (output !== undefined && news.project.projectId !== output.projectId) ||
            news.name !== olds?.name ||
            news.expiresAt !== olds?.expiresAt
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output !== undefined) {
            const keys = yield* list(output.projectId);
            const key = keys.find((item) => item.name === output.name);
            return key && (yield* toAttrs(key, output.projectId, output.value));
          }
          if (olds === undefined) return undefined;
          const name = yield* keyName(id, olds.name);
          const projectId = olds.project.projectId;
          const keys = yield* list(projectId);
          const key = findStoredKey(keys, name);
          // During a replace this is the key being replaced. The engine deletes it
          // by name afterwards, so the new key must get a name of its own.
          if (key?.name === previous?.name) return undefined;
          if (key === undefined) return undefined;
          const attrs = yield* toAttrs(key, projectId, Redacted.make(""));
          return Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const projectId = news.project.projectId;
          const name = yield* keyName(id, news.name);
          const keys = yield* list(projectId);

          // Observe. The value is usable only if this key is still in Convex.
          const current =
            output !== undefined &&
            output.projectId === projectId &&
            Redacted.value(output.value).length > 0
              ? keys.find((item) => item.name === output.name)
              : undefined;
          if (current !== undefined) return yield* toAttrs(current, projectId, output!.value);

          // Ensure. With no value in hand, an existing key can only be rotated.
          // Only an adopted key is rotated. On a replace, the old key stays until
          // the engine deletes it, and the new one gets a name of its own.
          const stale = output?.name;
          if (stale !== undefined && keys.some((item) => item.name === stale)) {
            yield* session.note(`Rotating preview key ${stale}, because its value is unknown...`);
            yield* management
              .deletePreviewDeployKey({ projectId, id: stale })
              .pipe(Effect.catchTag("PreviewDeployKeyNotFound", () => Effect.void));
          }
          yield* session.note(`Creating preview key ${name}...`);
          const { previewDeployKey } = yield* createOnce(
            management.createPreviewDeployKey({
              projectId,
              name,
              expiresAt: news.expiresAt,
            }),
          );

          // Convex renames a repeated key, so read back what it stored.
          const stored = yield* list(projectId);
          const created = findStoredKey(stored, name);
          if (created === undefined) {
            return yield* new PreviewDeployKeyNotListed({
              message: `Preview key ${name} was created but is missing from the listing`,
            });
          }
          return yield* toAttrs(created, projectId, previewDeployKey);
        }),
        // Keys go with their project, and Convex never shows their values.
        list: () => Effect.succeed([]),
        delete: Effect.fn(function* ({ output }) {
          yield* assertTeam(output.teamId, `preview key ${output.name}`);
          yield* management
            .deletePreviewDeployKey({ projectId: output.projectId, id: output.name })
            .pipe(
              Effect.catchTag(["PreviewDeployKeyNotFound", "ProjectNotFound"], () => Effect.void),
            );
        }),
      };
    }),
  );
