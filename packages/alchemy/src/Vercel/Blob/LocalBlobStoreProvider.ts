/**
 * The dev-mode (`alchemy dev`) provider for `Vercel.BlobStore` — emulates
 * the store on the developer's machine instead of creating it on Vercel
 * (ProviderMode doctrine; registry-style local provider, no per-resource
 * process, so plain `RpcProvider.effect` rather than `LocalProvider.make`).
 *
 * One {@link makeLocalBlobServer} per sidecar serves every local store's
 * data plane (directory-backed under `.alchemy/local/blob/{storeId}/`).
 * Store rows carry the `dev:store_…` identity marker plus the emulator's
 * endpoint + deterministic token as the `localApiUrl`/`localToken`
 * attributes — the Blob capability bindings inject those into the host
 * Function's env (`VERCEL_BLOB_API_URL` + `BLOB_READ_WRITE_TOKEN`, the
 * probe-verified override), so our R/W/RW clients, the async
 * `readWriteBlobFromEnv` client, and `@vercel/blob` all hit the emulator
 * unchanged. Project connections are a deliberate no-op locally (there is
 * no platform to inject env through — the binding env IS the injection).
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { LOCAL_ENTRY_URL } from "../LocalRuntime.ts";
import {
  BlobStore,
  type BlobStoreAccess,
  type BlobStoreBinding,
  type BlobStoreEnvironment,
  type BlobStoreRegion,
} from "./BlobStore.ts";
import { makeLocalBlobServer } from "./LocalBlobServer.ts";

const DEFAULT_ACCESS: BlobStoreAccess = "public";
const DEFAULT_REGION: BlobStoreRegion = "iad1";
const ALL_ENVIRONMENTS: BlobStoreEnvironment[] = [
  "production",
  "preview",
  "development",
];

const createStoreName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const normalizeEnvironments = (
  environments: BlobStoreEnvironment[] | undefined,
): BlobStoreEnvironment[] =>
  [...new Set(environments?.length ? environments : ALL_ENVIRONMENTS)].sort();

const isLocalId = (storeId: string) => storeId.startsWith("dev:");

export const LocalBlobStoreProvider = () =>
  RpcProvider.effect(
    BlobStore,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { dotAlchemy } = yield* AlchemyContext;
      // One data-plane server per sidecar, started with the provider (the
      // dual `local` thunk builds lazily — a plain deploy never constructs
      // it unless a local-mode row needs acting on).
      const server = yield* makeLocalBlobServer({
        baseDirectory: path.join(dotAlchemy, "local", "blob"),
      });

      return {
        stables: ["storeId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if (!output?.storeId) return { action: "update" as const };
          // A real (non-`dev:`) storeId on a local-mode row is legacy
          // damage — replace so the new generation mints a true local
          // identity.
          if (!isLocalId(output.storeId)) {
            return { action: "replace" as const };
          }
          const oldName =
            output.name ?? (yield* createStoreName(id, olds.name));
          // Engine-owned names: the deployed name stays authoritative; only
          // an explicit user-provided name can force a replace.
          const name = news.name ?? oldName;
          if (name !== oldName) {
            return { action: "replace" as const };
          }
          // Access/region change in-place locally (a live replace would
          // nuke the shared directory out from under the successor), and a
          // stale emulator endpoint (fresh dev session, new port) must
          // republish attributes so bound Functions pick up the new env.
          if (
            (news.access ?? output.access ?? DEFAULT_ACCESS) !==
              (output.access ?? DEFAULT_ACCESS) ||
            (news.region ?? output.region ?? DEFAULT_REGION) !==
              (output.region ?? DEFAULT_REGION) ||
            output.localApiUrl !== server.url
          ) {
            return { action: "update" as const };
          }
          // No-op path: make sure the store is registered with THIS
          // session's server anyway (idempotent; hydrates a previous
          // session's directory) so the data plane serves it.
          yield* server.openStore({
            storeId: output.storeId,
            access: (output.access ?? DEFAULT_ACCESS) as BlobStoreAccess,
          });
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.storeId || !isLocalId(output.storeId)) return undefined;
          const handle = yield* server.openStore({
            storeId: output.storeId,
            access: (output.access ?? DEFAULT_ACCESS) as BlobStoreAccess,
          });
          return {
            ...output,
            localApiUrl: server.url,
            localToken: Redacted.make(handle.token),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, bindings }) {
          const name = output?.name ?? (yield* createStoreName(id, news.name));
          const access = (news.access ?? DEFAULT_ACCESS) as BlobStoreAccess;
          // Never carry a real (non-`dev:`) id forward onto a local row.
          const storeId =
            output?.storeId && isLocalId(output.storeId)
              ? output.storeId
              : `dev:store_${name}`;
          const handle = yield* server.openStore({ storeId, access });
          // Connections are a no-op locally — echo the desired project list
          // (props ∪ binding contributions) so plans stay stable.
          const contributedProjects = (bindings ?? [])
            .filter(
              (b: ResourceBinding<BlobStoreBinding> & { action?: string }) =>
                b.action !== "delete",
            )
            .flatMap((b) => b?.data?.projects ?? []);
          const projectIds = [
            ...new Set([...(news.projects ?? []), ...contributedProjects]),
          ].sort();
          return {
            storeId,
            name,
            access,
            region: news.region ?? DEFAULT_REGION,
            projectIds,
            envVarEnvironments: normalizeEnvironments(news.envVarEnvironments),
            localApiUrl: server.url,
            localToken: Redacted.make(handle.token),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent: deregisters and removes the store directory. A
          // legacy live id never had a local directory — dropStore's
          // removal is best-effort and the live store (if any) is not
          // touched from the local provider.
          yield* server.dropStore(output.storeId);
        }),
      };
    }),
  );
