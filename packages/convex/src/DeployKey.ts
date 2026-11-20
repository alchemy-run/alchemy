import * as management from "@distilled.cloud/convex/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { team } from "./Credentials.ts";
import type { DeploymentAttributes } from "./Deployment.ts";
import { findStoredKey } from "./internal/keys.ts";
import { createOnce } from "./internal/retry.ts";
import { assertTeam } from "./internal/team.ts";
import type { Providers } from "./Providers.ts";

/** Convex accepted a key but its listing doesn't show it. */
export class DeployKeyNotListed extends Data.TaggedError("DeployKeyNotListed")<{
  readonly message: string;
}> {}

export interface DeployKeyProps {
  /** The deployment this key acts on. Changing it replaces the key. */
  deployment: Pick<DeploymentAttributes, "deploymentName">;
  /**
   * Key name. If omitted, a unique name is generated. Convex keeps a repeated
   * name by appending a UUID, so `name` on the attributes may differ from this.
   * Changing it replaces the key.
   */
  name?: string;
  /**
   * What the key may do, such as `deployment:deploy`. `convex deploy` needs
   * `deployment:deploy`. Changing it replaces the key.
   * @default every action
   */
  allowedActions?: string[];
  /** Timestamp in milliseconds when the key stops working. Changing it replaces the key. */
  expiresAt?: number;
}

export interface DeployKeyAttributes {
  /** Numeric key ID. */
  keyId: number;
  /** The exact name Convex stored. */
  name: string;
  /** The deployment this key acts on. */
  deploymentName: string;
  /** Numeric ID of the owning team. */
  teamId: number;
  /** The key. Convex returns it only at creation, so it lives in state. */
  value: Redacted.Redacted<string>;
  /** What the key may do. */
  allowedActions: string[];
  /** Timestamp in milliseconds when the key stops working, if ever. */
  expiresAt: number | undefined;
}

export type DeployKey = Resource<
  "Convex.DeployKey",
  DeployKeyProps,
  DeployKeyAttributes,
  never,
  Providers
>;

/**
 * A deploy key for one Convex deployment, for CI or `Convex.Functions`.
 * @see https://docs.convex.dev/management-api
 *
 * ### Rotation
 * Convex shows a key only when it is created, so an existing key can't be
 * adopted. Adopting one deletes it and creates a new one with the same name,
 * which invalidates anything still using the old value.
 *
 * ### Creating a key
 * **Example:** A key limited to deploying
 * ```typescript
 * const key = yield* Convex.DeployKey("Deploy", {
 *   deployment: prod,
 *   allowedActions: ["deployment:deploy"],
 * });
 * ```
 *
 * @resource
 * @product DeployKey
 */
export const DeployKey = Resource<DeployKey>("Convex.DeployKey");

/** Stands in for the value of a key found in Convex, which can't be read back. */
const NO_VALUE = "";

const toAttrs = Effect.fn(function* (
  key: management.PlatformDeployKeyResponse,
  deploymentName: string,
  value: Redacted.Redacted<string>,
) {
  return {
    keyId: key.id,
    name: key.name,
    deploymentName,
    teamId: yield* team,
    value,
    allowedActions: [...key.allowedActions],
    expiresAt: key.expiresAt ?? undefined,
  } satisfies DeployKeyAttributes;
});

export const DeployKeyProvider = () =>
  Provider.effect(
    DeployKey,
    Effect.gen(function* () {
      const keyName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({ id, lowercase: true, maxLength: 64, delimiter: "-" });

      const list = (deploymentName: string) =>
        management
          .listDeployKeys({ deploymentName })
          .pipe(
            Effect.catchTag("DeploymentNotFound", () =>
              Effect.succeed([] as readonly management.PlatformDeployKeyResponse[]),
            ),
          );

      return {
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          // Keys are immutable, and the new one has to exist before the old
          // one goes, so a replace creates first.
          if (
            (output !== undefined && news.deployment.deploymentName !== output.deploymentName) ||
            news.name !== olds?.name ||
            !deepEqual(news.allowedActions, olds?.allowedActions) ||
            news.expiresAt !== olds?.expiresAt
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output !== undefined) {
            const keys = yield* list(output.deploymentName);
            const key = keys.find((item) => item.name === output.name);
            return key && (yield* toAttrs(key, output.deploymentName, output.value));
          }
          if (olds === undefined) return undefined;
          const name = yield* keyName(id, olds.name);
          const deploymentName = olds.deployment.deploymentName;
          const keys = yield* list(deploymentName);
          const key = findStoredKey(keys, name);
          // During a replace this is the key being replaced. The engine deletes it
          // by name afterwards, so the new key must get a name of its own.
          if (key?.name === previous?.name) return undefined;
          if (key === undefined) return undefined;
          const attrs = yield* toAttrs(key, deploymentName, Redacted.make(NO_VALUE));
          return Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const deploymentName = news.deployment.deploymentName;
          const name = yield* keyName(id, news.name);
          const keys = yield* list(deploymentName);

          // Observe. The value is usable only if this key is still in Convex.
          const current =
            output !== undefined &&
            output.deploymentName === deploymentName &&
            Redacted.value(output.value).length > 0
              ? keys.find((item) => item.name === output.name)
              : undefined;
          if (current !== undefined) return yield* toAttrs(current, deploymentName, output!.value);

          // Ensure. With no value in hand, an existing key can only be rotated.
          // Only an adopted key is rotated. On a replace, the old key stays until
          // the engine deletes it, and the new one gets a name of its own.
          const stale = output?.name;
          if (stale !== undefined && keys.some((item) => item.name === stale)) {
            yield* session.note(`Rotating deploy key ${stale}, because its value is unknown...`);
            yield* management
              .deleteDeployKey({ deploymentName, id: stale })
              .pipe(Effect.catchTag("DeployKeyNotFound", () => Effect.void));
          }
          yield* session.note(`Creating deploy key ${name}...`);
          const { deployKey } = yield* createOnce(
            management.createDeployKey({
              deploymentName,
              name,
              allowedActions:
                news.allowedActions as management.CreateDeployKeyRequest["allowedActions"],
              expiresAt: news.expiresAt,
            }),
          );

          // Convex renames a repeated key, so read back what it stored.
          const created = findStoredKey(yield* management.listDeployKeys({ deploymentName }), name);
          if (created === undefined) {
            return yield* new DeployKeyNotListed({
              message: `Deploy key ${name} was created but is missing from the listing`,
            });
          }
          return yield* toAttrs(created, deploymentName, deployKey);
        }),
        // Keys go with their deployment, and Convex never shows their values.
        list: () => Effect.succeed([]),
        delete: Effect.fn(function* ({ output }) {
          yield* assertTeam(output.teamId, `deploy key ${output.name}`);
          yield* management
            .deleteDeployKey({ deploymentName: output.deploymentName, id: output.name })
            .pipe(Effect.catchTag(["DeployKeyNotFound", "DeploymentNotFound"], () => Effect.void));
        }),
      };
    }),
  );
