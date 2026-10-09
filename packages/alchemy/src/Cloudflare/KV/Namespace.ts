import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId } from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import { isInstantNamespaceLocalId } from "./InstantNamespaceLocal.ts";
import {
  createTitle,
  deleteNamespace,
  findNamespaceByTitle,
  getNamespace,
  listNamespaces,
  syncNamespaceTitle,
} from "./NamespaceProvider.ts";

export const isNamespace = (value: unknown): value is Namespace =>
  isResourceOfType(value, "Cloudflare.KV.Namespace");

export type NamespaceProps = {
  /**
   * A human-readable string name for the namespace.
   * If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
};

export type Namespace = Resource<
  "Cloudflare.KV.Namespace",
  NamespaceProps,
  {
    title: string;
    namespaceId: string;
    supportsUrlEncoding: boolean | undefined;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Workers KV namespace for key-value storage at the edge.
 *
 * KV provides eventually-consistent, low-latency reads with global
 * replication. Create a namespace as a resource, then bind it to a Worker
 * to get/put values at runtime.
 * ### Creating a Namespace
 * **Example:** Basic KV namespace
 * ```typescript
 * const kv = yield* Cloudflare.KV.Namespace("MyKV");
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Using KV inside a Worker
 * ```typescript
 * const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 * // Read a value
 * const value = yield* kv.get("my-key");
 *
 * // Write a value
 * yield* kv.put("my-key", "hello world");
 * ```
 *
 * Provide `Cloudflare.KV.ReadWriteNamespaceBinding` (native Worker
 * binding) or `Cloudflare.KV.ReadWriteNamespaceHttp` (scoped HTTP
 * token) in the worker's runtime layer. Use `Cloudflare.KV.ReadNamespace`
 * / `Cloudflare.KV.WriteNamespace` for least-privilege read- or
 * write-only access.
 *
 * @resource
 * @product KV
 * @category Storage & Databases
 */
export const Namespace = Resource<Namespace>("Cloudflare.KV.Namespace", {
  aliases: ["Cloudflare.KVNamespace"],
});

export const ProviderLive = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output && "mode" in output && output.mode === "instant") {
        return {
          action: "replace",
          // Titles are unique across modes; an unresolved title may also reuse it.
          deleteFirst: !isResolved(news) || news.title === output.title,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldTitle = output?.title ?? (yield* createTitle(id, olds.title));
      // Auto-generated titles are engine-owned: the deployed title stays
      // authoritative even if the generator would title this id differently
      // today. Only an explicit user-provided title can force a rename.
      const title = news.title ?? oldTitle;
      if (title !== oldTitle) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const title = yield* createTitle(id, news.title);
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached namespace; fall back to a title
      // scan so we recover from out-of-band deletes or partial state
      // persistence failures.
      let observed = output?.namespaceId
        ? yield* getNamespace(acct, output.namespaceId)
        : undefined;

      // Ensure — create if missing. Cloudflare returns
      // `NamespaceTitleAlreadyExists` on a concurrent create; tolerate
      // by adopting the namespace with the same title.
      if (!observed) {
        observed = yield* kv
          .createNamespace({
            accountId: acct,
            title,
          })
          .pipe(
            Effect.catchTag("NamespaceTitleAlreadyExists", () =>
              Effect.gen(function* () {
                const match = yield* findNamespaceByTitle(accountId, title, "classic");
                if (match) {
                  return match;
                }
                return yield* Effect.die(
                  `Namespace with title "${title}" already exists but could not be found`,
                );
              }),
            ),
          );
      }

      return yield* syncNamespaceTitle(acct, observed, title);
    }),
    delete: ({ output }) => deleteNamespace(output.accountId, output.namespaceId),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const namespaces = yield* listNamespaces(accountId, "classic");
      return namespaces.map((ns) => ({
        title: ns.title,
        namespaceId: ns.id,
        supportsUrlEncoding: ns.supportsUrlEncoding ?? undefined,
        accountId,
      }));
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.namespaceId) {
        return yield* kv
          .getNamespace({
            accountId: output.accountId,
            namespaceId: output.namespaceId,
          })
          .pipe(
            Effect.map((namespace) => ({
              title: namespace.title,
              namespaceId: namespace.id,
              supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
              accountId: output.accountId,
            })),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
          );
      }
      const title = yield* createTitle(id, olds?.title);
      const match = yield* findNamespaceByTitle(accountId, title, "classic");
      if (match) {
        return {
          title: match.title,
          namespaceId: match.id,
          supportsUrlEncoding: match.supportsUrlEncoding ?? undefined,
          accountId,
        };
      }
      return undefined;
    }),
  });

/**
 * Local (dev) provider — the namespace is purely virtual: a `dev:` id keyed
 * into the local workerd KV simulator. `toRuntimeBinding` lowers a
 * `kv_namespace` binding whose id is `dev:`-prefixed onto the local KV
 * service; data persists under `.alchemy/local/kv`.
 */
export const ProviderLocal = () =>
  Provider.succeed(Namespace, {
    stables: ["accountId"],
    diff: Effect.fn(function* ({ news = {}, output }) {
      const accountId = yield* localAccountId;
      if (!output?.namespaceId) return { action: "update" } as const;
      if (isInstantNamespaceLocalId(output.namespaceId)) return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      if (output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // Fall through to the engine's default prop diff (title renames
      // update in place).
    }),
    read: Effect.fn(function* ({ output }) {
      // Purely virtual — the persisted state row is the source of truth.
      return output ?? undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const accountId = yield* localAccountId;
      return {
        title: yield* createTitle(id, news.title),
        namespaceId: output?.namespaceId ?? generateLocalId(),
        supportsUrlEncoding: true,
        accountId: output?.accountId ?? accountId,
      };
    }),
    delete: Effect.fn(function* () {
      // The simulator's on-disk data is keyed by the dev id; dropping the
      // state row is enough — orphaned blobs are reclaimed with `.alchemy`.
    }),
  });

export const NamespaceProvider = () =>
  ProviderLayer.dual(Namespace, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
