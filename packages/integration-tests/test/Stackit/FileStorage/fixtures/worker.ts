import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The network `MountShare` lets in. Set in the pool's ACL too: a policy only narrows it. */
export const NETWORK_PREFIX = "10.231.60.0/24";

export const Files = Stackit.FileStorage.ResourcePool("FileStorageBindingsPool", {
  availabilityZone: "eu01-1",
  performanceClass: "Standard",
  sizeGigabytes: 500,
  ipAcl: [NETWORK_PREFIX],
});

/** No rules of its own: `MountShare` adds the network's. */
export const Clients = Stackit.FileStorage.ShareExportPolicy("FileStorageBindingsPolicy", {});

export const Assets = Effect.gen(function* () {
  const pool = yield* Files;
  const policy = yield* Clients;
  return yield* Stackit.FileStorage.Share("FileStorageBindingsShare", {
    resourcePoolId: pool.resourcePoolId,
    spaceHardLimitGigabytes: 10,
    exportPolicyName: policy.name,
  });
});

/**
 * A Cloudflare Worker with every File Storage binding that has a runtime call. One route
 * per binding; each answers `{ ok, result | error }` so a failure surfaces the STACKIT
 * error in the test.
 */
export default class FileStorageBindingsWorker extends Cloudflare.Worker<FileStorageBindingsWorker>()(
  "StackitFileStorageBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const pool = yield* Files;
    const share = yield* Assets;
    const policy = yield* Clients;
    const getResourcePool = yield* Stackit.FileStorage.GetResourcePool(pool);
    const listShares = yield* Stackit.FileStorage.ListShares(pool);
    const getShare = yield* Stackit.FileStorage.GetShare(share);
    const listPolicies = yield* Stackit.FileStorage.ListShareExportPolicies(policy);
    const getPolicy = yield* Stackit.FileStorage.GetShareExportPolicy(policy);
    const listSnapshots = yield* Stackit.FileStorage.ListSnapshots(pool);
    const getSnapshot = yield* Stackit.FileStorage.GetSnapshot(pool);
    const createSnapshot = yield* Stackit.FileStorage.CreateSnapshot(pool);
    const deleteSnapshot = yield* Stackit.FileStorage.DeleteSnapshot(pool);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const name = url.searchParams.get("name") ?? "";
        switch (url.pathname) {
          case "/get-resource-pool":
            return yield* respond(getResourcePool({}));
          case "/list-shares":
            return yield* respond(listShares({}));
          case "/get-share":
            return yield* respond(getShare({}));
          case "/list-share-export-policies":
            return yield* respond(listPolicies());
          case "/get-share-export-policy":
            return yield* respond(getPolicy({}));
          case "/list-snapshots":
            return yield* respond(listSnapshots({}));
          case "/get-snapshot":
            return yield* respond(getSnapshot({ snapshotName: name }));
          case "/create-snapshot":
            return yield* respond(createSnapshot({ name, comment: "from a binding" }));
          case "/delete-snapshot":
            return yield* respond(deleteSnapshot({ snapshotName: name }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.FileStorage.GetResourcePoolHttp,
        Stackit.FileStorage.ListSharesHttp,
        Stackit.FileStorage.GetShareHttp,
        Stackit.FileStorage.ListShareExportPoliciesHttp,
        Stackit.FileStorage.GetShareExportPolicyHttp,
        Stackit.FileStorage.ListSnapshotsHttp,
        Stackit.FileStorage.GetSnapshotHttp,
        Stackit.FileStorage.CreateSnapshotHttp,
        Stackit.FileStorage.DeleteSnapshotHttp,
      ),
    ),
  ),
) {}
