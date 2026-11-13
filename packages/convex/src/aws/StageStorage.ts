import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { STORAGE_KEYS, type StorageKey } from "../internal/selfhosted.ts";
import { deleteStagePrefix } from "../internal/stagePrefix.ts";
import type { Providers } from "./Providers.ts";

export interface StageStorageProps {
  /** The platform's shared buckets. */
  storage: Record<StorageKey, { name: string }>;
  /** The backend's instance name, which prefixes its objects. */
  instanceName: string;
}

export interface StageStorageAttributes {
  /** The instance name whose prefix this owns. */
  instanceName: string;
}

export type StageStorage = Resource<
  "Convex.StageStorage",
  StageStorageProps,
  StageStorageAttributes,
  never,
  Providers
>;

/**
 * A SQLite stage's prefix in a `Convex.Platform`'s shared buckets. It creates
 * nothing; destroying it deletes the prefix, and only that prefix. A stage on
 * the platform's database server gets the same cleanup from its stage database.
 *
 * @internal
 *
 * @resource
 * @product StageStorage
 */
export const StageStorage = Resource<StageStorage>("Convex.StageStorage");

export const StageStorageProvider = () =>
  Provider.effect(
    StageStorage,
    Effect.succeed({
      diff: Effect.fn(function* ({ olds, news }) {
        if (!isResolved(news)) return undefined;
        // Another instance name is another stage's objects.
        if (olds !== undefined && olds.instanceName !== news.instanceName) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      // The objects live in the platform's buckets and go with them.
      list: () => Effect.succeed([]),
      reconcile: Effect.fn(function* ({ news }) {
        return { instanceName: news.instanceName };
      }),
      delete: Effect.fn(function* ({ olds }) {
        for (const key of STORAGE_KEYS) {
          yield* deleteStagePrefix(olds.storage[key].name, olds.instanceName);
        }
      }),
    }),
  );
