import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { mintAdminKey } from "../internal/adminKey.ts";
import { assertInstanceNameUnchanged } from "../internal/selfhosted.ts";
import type { Providers } from "./Providers.ts";

export interface AdminKeyProps {
  /** The backend's `INSTANCE_NAME`. Changing it fails, because the data lives under it. */
  instanceName: string;
  /** The backend's `INSTANCE_SECRET`. Changing it replaces the key. */
  instanceSecret: Redacted.Redacted<string>;
}

export interface AdminKeyAttributes {
  /** The name the key was minted for. */
  instanceName: string;
  /** The admin key, a root credential for the backend. */
  value: Redacted.Redacted<string>;
}

export type AdminKey = Resource<
  "Convex.AdminKey",
  AdminKeyProps,
  AdminKeyAttributes,
  never,
  Providers
>;

/**
 * An admin key for a self-hosted Convex backend. `Convex.Backend` creates one,
 * so most stacks never use this directly.
 *
 * ### How the key is made
 * The key is computed from the name and secret the way the backend's own
 * `generate_key` computes it, on the deploying machine. It needs no Docker and
 * no running backend.
 *
 * ### Safety
 * This is also what guards the data: a changed `instanceName` fails the plan
 * with `InstanceNameChanged`, before anything touches the service, because a
 * new name points the backend at a new, empty database.
 *
 * @resource
 * @product AdminKey
 */
export const AdminKey = Resource<AdminKey>("Convex.AdminKey");

export const AdminKeyProvider = () =>
  Provider.effect(
    AdminKey,
    Effect.succeed({
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        yield* assertInstanceNameUnchanged(olds?.instanceName, news.instanceName);
        if (
          olds !== undefined &&
          Redacted.value(olds.instanceSecret) !== Redacted.value(news.instanceSecret)
        ) {
          return { action: "replace" } as const;
        }
        return { action: "noop" } as const;
      }),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        if (output !== undefined) return output;
        yield* session.note(`Minting admin key for ${news.instanceName}...`);
        const value = yield* mintAdminKey(news);
        return { instanceName: news.instanceName, value };
      }),
      delete: () => Effect.void,
      // Keys aren't listed anywhere, and they stop working with their secret.
      list: () => Effect.succeed([]),
    }),
  );
