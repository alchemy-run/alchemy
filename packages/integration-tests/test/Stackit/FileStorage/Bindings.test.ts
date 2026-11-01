import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import { Self } from "alchemy/Self";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow } from "./fileStorage.ts";
import FileStorageBindingsWorker, {
  Assets,
  Clients,
  Files,
  NETWORK_PREFIX,
} from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const MOUNT_POINT = "/mnt/assets";

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

const Stack = Alchemy.Stack(
  "StackitFileStorageBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* FileStorageBindingsWorker;
    const pool = yield* Files;
    const share = yield* Assets;
    const policy = yield* Clients;
    const network = yield* Stackit.IaaS.Network("FileStorageBindingsNetwork", {
      ipv4: { prefix: NETWORK_PREFIX },
    });
    const mount = yield* Stackit.FileStorage.MountShare(share, {
      policy,
      cidrs: network.ipv4Prefixes,
      mountPoint: MOUNT_POINT,
    }).pipe(Effect.orDie);
    const server = yield* Stackit.IaaS.Server("FileStorageBindingsServer", {
      machineType: "g1.1",
      bootVolume: {
        size: 10,
        source: { type: "image", id: ubuntuImage },
        deleteOnTermination: true,
      },
      networking: { networkId: network.networkId },
      userData: mount.userData,
    });
    return {
      url: worker.url.as<string>(),
      projectId: pool.projectId,
      region: pool.region,
      resourcePoolId: pool.resourcePoolId,
      shareId: share.shareId,
      shareName: share.name,
      mountPath: share.mountPath,
      policyId: policy.policyId,
      policyName: policy.name,
      serverId: server.serverId,
      fstabEntry: mount.fstabEntry,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The service `Binding.Host` reads, as it reads it. A runtime host provides it. */
const HostService = Self as unknown as Context.Service<ResourceLike, ResourceLike>;

describe("MountShare on a host", { tags: stackitTags("filestorage", "bindings") }, () => {
  // No cloud call, and nothing billed: the binding refuses before it touches anything.
  test(
    "fails typed at bind time on a host that can't mount NFS",
    Effect.gen(function* () {
      // Only the logical ids are read before it refuses, so these stand in for resources.
      const share = { LogicalId: "Assets" } as unknown as Stackit.FileStorage.Share;
      const policy = { LogicalId: "Clients" } as unknown as Stackit.FileStorage.ShareExportPolicy;
      const error = yield* Stackit.FileStorage.MountShare(share, {
        policy,
        cidrs: ["192.0.2.0/24"],
        mountPoint: MOUNT_POINT,
      }).pipe(
        Effect.provideService(HostService, {
          LogicalId: "Fn",
          Type: "Stackit.Functions.Function",
        } as unknown as ResourceLike),
        Effect.flip,
      );
      expect(error._tag).toEqual("Stackit.FileStorage.MountShareUnsupportedHost");
      expect(error.host).toEqual("Fn");
      expect(error.hostType).toEqual("Stackit.Functions.Function");
    }),
  );
});

// The fixture holds one pool for at least a started hour, and one server: see
// `fileStorage.ts`. The snapshot steps act on one pool, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT File Storage bindings on a Cloudflare Worker",
  { tags: [...stackitTags("filestorage", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 3_000_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_000_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while
    // to propagate: retry until the route answers `ok`, then report the last answer so a
    // real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** The names of the pool's snapshots, out of band. */
    const snapshotNames = Effect.gen(function* () {
      const { projectId, region, resourcePoolId } = yield* stack;
      const { resourcePoolSnapshots } = yield* sfs.listResourcePoolSnapshots({
        projectId: projectId!,
        region: region!,
        resourcePoolId: resourcePoolId!,
      });
      return (resourcePoolSnapshots ?? []).map((snapshot) => snapshot.snapshotName);
    });

    const SNAPSHOT = "alchemy-test-binding-snapshot";

    describe("GetResourcePool", () => {
      test.provider(
        "reads the bound pool, with its space",
        (_stack) =>
          Effect.gen(function* () {
            const { resourcePoolId } = yield* stack;
            const body = yield* call("/get-resource-pool");
            expectOk(body);
            expect(body.result.resourcePool.id).toEqual(resourcePoolId);
            expect(body.result.resourcePool.state).toEqual("created");
            expect(body.result.resourcePool.space.sizeGigabytes).toEqual(500);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListShares", () => {
      test.provider(
        "lists the shares in the bound pool",
        (_stack) =>
          Effect.gen(function* () {
            const { shareId } = yield* stack;
            const body = yield* call("/list-shares");
            expectOk(body);
            expect((body.result.shares as { id: string }[]).map((share) => share.id)).toContain(
              shareId,
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetShare", () => {
      test.provider(
        "reads the bound share, with its mount path",
        (_stack) =>
          Effect.gen(function* () {
            const { shareId, mountPath } = yield* stack;
            const body = yield* call("/get-share");
            expectOk(body);
            expect(body.result.share.id).toEqual(shareId);
            expect(body.result.share.mountPath).toEqual(mountPath);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListShareExportPolicies", () => {
      test.provider(
        "lists the project's policies, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { policyId } = yield* stack;
            const body = yield* call("/list-share-export-policies");
            expectOk(body);
            expect(
              (body.result.shareExportPolicies as { id: string }[]).map((policy) => policy.id),
            ).toContain(policyId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetShareExportPolicy", () => {
      test.provider(
        "reads the bound policy and counts the share using it",
        (_stack) =>
          Effect.gen(function* () {
            const { policyId } = yield* stack;
            const body = yield* call("/get-share-export-policy");
            expectOk(body);
            expect(body.result.shareExportPolicy.id).toEqual(policyId);
            expect(body.result.shareExportPolicy.sharesUsingExportPolicy).toEqual(1);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CreateSnapshot", () => {
      test.provider(
        "snapshots the bound pool, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-snapshot", { name: SNAPSHOT });
            expectOk(body);
            expect(body.result.resourcePoolSnapshot.snapshotName).toEqual(SNAPSHOT);
            expect(yield* snapshotNames).toContain(SNAPSHOT);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListSnapshots", () => {
      test.provider(
        "lists the bound pool's snapshots",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-snapshots");
            expectOk(body);
            expect(
              (body.result.resourcePoolSnapshots as { snapshotName: string }[]).map(
                (snapshot) => snapshot.snapshotName,
              ),
            ).toContain(SNAPSHOT);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetSnapshot", () => {
      test.provider(
        "reads one snapshot of the bound pool by name",
        (_stack) =>
          Effect.gen(function* () {
            const { resourcePoolId } = yield* stack;
            const body = yield* call("/get-snapshot", { name: SNAPSHOT });
            expectOk(body);
            expect(body.result.resourcePoolSnapshot.snapshotName).toEqual(SNAPSHOT);
            expect(body.result.resourcePoolSnapshot.resourcePoolId).toEqual(resourcePoolId);
            expect(body.result.resourcePoolSnapshot.comment).toEqual("from a binding");
          }),
        { timeout: 240_000 },
      );
    });

    describe("DeleteSnapshot", () => {
      test.provider(
        "deletes that snapshot, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/delete-snapshot", { name: SNAPSHOT });
            expectOk(body);
            const remaining = yield* snapshotNames.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (names) => !names.includes(SNAPSHOT),
                times: 12,
              }),
            );
            expect(remaining).not.toContain(SNAPSHOT);
          }),
        { timeout: 240_000 },
      );
    });

    describe("MountShare", () => {
      test.provider(
        "lets the network into the policy, and the server mounts the share",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, policyId, mountPath, serverId, fstabEntry } = yield* stack;

            // The rule, out of band: read-write for the server's network.
            const { shareExportPolicy } = yield* sfs.getShareExportPolicy({
              projectId: projectId!,
              region: region!,
              policyId: policyId!,
            });
            expect(shareExportPolicy?.rules?.length).toEqual(1);
            expect(shareExportPolicy?.rules?.[0]?.ipAcl).toEqual([NETWORK_PREFIX]);
            expect(shareExportPolicy?.rules?.[0]?.readOnly).toEqual(false);

            expect(fstabEntry).toEqual(
              `${mountPath} ${MOUNT_POINT} nfs nfsvers=4.1,_netdev,nofail 0 0`,
            );

            // The server's console: `userData` writes this once the mount is up. Package
            // installation on first boot takes minutes.
            const log = yield* iaas
              .getServerLog({ projectId: projectId!, region: region!, serverId: serverId! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("15 seconds"),
                  until: ({ output }) => (output ?? "").includes("alchemy: share mounted"),
                  times: 40,
                }),
              );
            expect(log.output).toContain("alchemy: share mounted");
          }),
        { timeout: 900_000 },
      );
    });
  },
);
