/**
 * Dev-mode (`alchemy dev`) providers for `Vercel.EdgeConfig` and
 * `Vercel.EdgeConfigToken` — registry-style local emulation per the
 * ProviderMode doctrine (in-memory rows, NO `LocalProvider.make`).
 *
 * - **EdgeConfig** rows live in {@link LocalEdgeConfigState}: the declared
 *   `items` map is seeded into the registry with a content digest, and the
 *   registry is served over a local HTTP endpoint speaking the exact
 *   data-plane read protocol (see `LocalEdgeConfigState.ts`). Ids carry the
 *   `dev:ecfg_` marker — proof no cloud call ran. The optional `schema` is
 *   NOT enforced locally (validation is a management-API concern; local
 *   items only change via deploy).
 * - **EdgeConfigToken** mints `dev:ectok_…` read tokens against the local
 *   endpoint and yields a `http://localhost:<port>/{edgeConfigId}?token=…`
 *   connection string — the exact shape the alchemy read clients and
 *   `@vercel/edge-config` accept. When the token targets a REAL Edge Config
 *   (an `Alchemy.remote()` config bound during dev — the mixed
 *   local-Function/live-EdgeConfig stack), it delegates to the live
 *   lifecycle ({@link makeEdgeConfigTokenService}) so the locally running
 *   Function still receives a real `https://edge-config.vercel.com/…`
 *   connection string.
 *
 * Because item changes converge in the registry (served live by the local
 * endpoint), an items-only redeploy updates reads WITHOUT restarting the
 * consuming Function — the connection string, and therefore the Function's
 * env, is unchanged.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { sha256 } from "../../Util/sha256.ts";
import { stableStringify } from "../../Util/stable.ts";
import { LOCAL_ENTRY_URL } from "../LocalRuntime.ts";
import { EdgeConfig } from "./EdgeConfig.ts";
import {
  EdgeConfigToken,
  makeEdgeConfigTokenService,
} from "./EdgeConfigToken.ts";
import {
  computeLocalDigest,
  isLocalEdgeConfigId,
  LOCAL_EDGE_CONFIG_ID_PREFIX,
  LOCAL_EDGE_CONFIG_TOKEN_PREFIX,
  LocalEdgeConfigState,
  type LocalEdgeConfigEntry,
} from "./LocalEdgeConfigState.ts";

/**
 * A provider running behind the RPC sidecar receives `session` as plain
 * data — capnweb strips its method stubs — so `note` may arrive `null`.
 * Fall back to a log line (still surfaced in the sidecar output) and hand
 * the delegated live lifecycle a callable session.
 */
const rpcSafeSession = (
  session: ScopedPlanStatusSession,
): ScopedPlanStatusSession =>
  typeof session?.note === "function"
    ? session
    : { ...session, note: (note: string) => Effect.log(note) };

/** Live-parity item normalization: `undefined`-valued keys are dropped. */
const pruneItems = (items: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(items).filter(([, value]) => value !== undefined),
  );

const toEdgeConfigAttributes = (
  entry: LocalEdgeConfigEntry,
): EdgeConfig["Attributes"] => ({
  edgeConfigId: entry.edgeConfigId,
  slug: entry.slug,
  digest: entry.digest,
  createdAt: entry.createdAt,
  ownerId: "dev",
  itemCount: entry.itemCount,
  sizeInBytes: entry.sizeInBytes,
});

export const LocalEdgeConfigProvider = () =>
  RpcProvider.effect(
    EdgeConfig,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const state = yield* LocalEdgeConfigState;
      return {
        stables: [
          "edgeConfigId" as const,
          "createdAt" as const,
          "ownerId" as const,
        ],
        diff: Effect.fn(function* ({ news = {}, output }) {
          // Greenfield — or a row without a local identity (cannot occur in
          // practice: Vercel shipped provider modes from day one) — mints a
          // fresh `dev:` id in reconcile.
          if (
            output?.edgeConfigId === undefined ||
            !isLocalEdgeConfigId(output.edgeConfigId)
          ) {
            return { action: "update" } as const;
          }
          if (!isResolved(news)) return undefined;
          const entry = Option.getOrUndefined(
            MutableHashMap.get(state.configs, output.edgeConfigId),
          );
          // Fresh sidecar session: the registry is empty even though state
          // says `created` — reconcile re-registers (and re-serves) it.
          if (entry === undefined) return { action: "update" } as const;
          if ((news.slug ?? output.slug) !== entry.slug) {
            return { action: "update" } as const;
          }
          if (
            news.items !== undefined &&
            stableStringify(pruneItems(news.items)) !==
              stableStringify(entry.items)
          ) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.edgeConfigId === undefined) return undefined;
          const entry = Option.getOrUndefined(
            MutableHashMap.get(state.configs, output.edgeConfigId),
          );
          return entry === undefined
            ? undefined
            : toEdgeConfigAttributes(entry);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news = {}, output }) {
          // Auto-generated slugs are engine-owned: prefer the deployed slug
          // (matching the live provider); only an explicit `news.slug`
          // renames.
          const slug =
            news.slug ??
            output?.slug ??
            (yield* createPhysicalName({ id, maxLength: 64 }));
          // The id survives renames (live parity: slugs are labels, ids are
          // identity). Derived from the FQN so distinct stacks sharing one
          // sidecar can never collide; never carry a live `ecfg_…` id onto
          // a local row.
          const edgeConfigId =
            output?.edgeConfigId !== undefined &&
            isLocalEdgeConfigId(output.edgeConfigId)
              ? output.edgeConfigId
              : `${LOCAL_EDGE_CONFIG_ID_PREFIX}${(yield* sha256(fqn)).slice(0, 24)}`;
          const existing = Option.getOrUndefined(
            MutableHashMap.get(state.configs, edgeConfigId),
          );
          // Declared items converge exactly; undeclared items are left
          // unmanaged (live parity) — a fresh registry entry starts empty.
          const items = pruneItems(news.items ?? existing?.items ?? {});
          const digest = yield* computeLocalDigest(items);
          const sizeInBytes = yield* Effect.sync(
            () => new TextEncoder().encode(stableStringify(items)).length,
          );
          const entry: LocalEdgeConfigEntry = {
            edgeConfigId,
            slug,
            items,
            digest,
            createdAt:
              existing?.createdAt ??
              output?.createdAt ??
              (yield* Clock.currentTimeMillis),
            itemCount: Object.keys(items).length,
            sizeInBytes,
          };
          MutableHashMap.set(state.configs, edgeConfigId, entry);
          return toEdgeConfigAttributes(entry);
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(state.configs, output.edgeConfigId);
          // Read tokens cascade with their config (live parity).
          for (const [token, target] of state.tokens) {
            if (target === output.edgeConfigId) {
              MutableHashMap.remove(state.tokens, token);
            }
          }
        }),
      };
    }),
  );

export const LocalEdgeConfigTokenProvider = () =>
  RpcProvider.effect(
    EdgeConfigToken,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const state = yield* LocalEdgeConfigState;
      const live = makeEdgeConfigTokenService();
      return {
        stables: ["edgeConfigId" as const],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const oldEdgeConfigId = output?.edgeConfigId ?? olds?.edgeConfigId;
          // Moving the token to another Edge Config is a replacement
          // (matching the live diff) — including local↔live moves.
          if (
            news.edgeConfigId !== undefined &&
            oldEdgeConfigId !== undefined &&
            news.edgeConfigId !== oldEdgeConfigId
          ) {
            return { action: "replace" } as const;
          }
          const target = news.edgeConfigId ?? oldEdgeConfigId;
          if (!isLocalEdgeConfigId(target)) {
            // Live target (an `Alchemy.remote()` Edge Config): the default
            // props-diff semantics — identical to the live provider's
            // remaining behaviour.
            return undefined;
          }
          if (output === undefined) return { action: "update" } as const;
          // The minted connection string must point at THIS session's local
          // data plane: a fresh sidecar serves on a new port (and starts
          // with an empty token registry), so re-mint when stale.
          const serverUrl = yield* state.serverUrl;
          const registered =
            Option.getOrUndefined(
              MutableHashMap.get(state.tokens, Redacted.value(output.token)),
            ) === target;
          const connection = Redacted.value(output.connectionString);
          if (!registered || !connection.startsWith(`${serverUrl}/`)) {
            return { action: "update" } as const;
          }
          if (news.label !== undefined && news.label !== output.label) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          if (!isLocalEdgeConfigId(output.edgeConfigId)) {
            return yield* live.read({ output });
          }
          const registered =
            Option.getOrUndefined(
              MutableHashMap.get(state.tokens, Redacted.value(output.token)),
            ) === output.edgeConfigId;
          return registered ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const safeSession = rpcSafeSession(session);
          const edgeConfigId = news.edgeConfigId ?? output?.edgeConfigId;
          if (
            edgeConfigId === undefined ||
            !isLocalEdgeConfigId(edgeConfigId)
          ) {
            // A real Edge Config bound during dev (`Alchemy.remote()`) — the
            // token must be real too; delegate to the live lifecycle (which
            // also owns the `edgeConfigId === undefined` die).
            return yield* live.reconcile({
              id,
              news,
              output,
              session: safeSession,
            });
          }
          const serverUrl = yield* state.serverUrl;
          const label =
            news.label ??
            output?.label ??
            (yield* createPhysicalName({ id, maxLength: 52 }));
          // Observe-and-keep (live parity): reuse the persisted token value
          // while it still targets the same config, so dependent env rows —
          // and therefore Function restarts — never churn.
          const kept =
            output !== undefined &&
            output.edgeConfigId === edgeConfigId &&
            Redacted.value(output.token).startsWith(
              LOCAL_EDGE_CONFIG_TOKEN_PREFIX,
            )
              ? output
              : undefined;
          const token =
            kept !== undefined
              ? Redacted.value(kept.token)
              : yield* Effect.sync(
                  () =>
                    `${LOCAL_EDGE_CONFIG_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
                );
          MutableHashMap.set(state.tokens, token, edgeConfigId);
          if (kept === undefined) {
            yield* safeSession.note(
              `Created local Edge Config token: ${label}`,
            );
          }
          return {
            tokenId:
              kept?.tokenId ??
              `dev:ectokid_${token.slice(LOCAL_EDGE_CONFIG_TOKEN_PREFIX.length)}`,
            edgeConfigId,
            label,
            createdAt: kept?.createdAt ?? (yield* Clock.currentTimeMillis),
            token: Redacted.make(token),
            connectionString: Redacted.make(
              `${serverUrl}/${edgeConfigId}?token=${token}`,
            ),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (!isLocalEdgeConfigId(output.edgeConfigId)) {
            return yield* live.delete({
              output,
              session: rpcSafeSession(session),
            });
          }
          MutableHashMap.remove(state.tokens, Redacted.value(output.token));
        }),
      };
    }),
  );
