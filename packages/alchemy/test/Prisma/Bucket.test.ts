import { getBucket, updateBucket } from "@distilled.cloud/prisma/management";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { adopt, OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy";
import { AlchemyContext } from "@/AlchemyContext";
import * as Prisma from "@/Prisma";
import { Bucket, BucketProvider, type BucketProps } from "@/Prisma/Bucket";
import {
  BucketAccessKey,
  BucketAccessKeyProvider,
  type BucketAccessKeyProps,
} from "@/Prisma/BucketAccessKey";
import { PrismaApiError, PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import type {
  Bucket as ApiBucket,
  BucketKey as ApiBucketKey,
  BucketKeyWithSecret,
} from "@/Prisma/Types";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { dispatchTo, makeFakeManagementApi, unhandled } from "./fixtures/FakeManagementApi.ts";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  patchStateAttr,
} from "./fixtures/Live.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const instanceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// physicalBucketAccessKeyName(logical id "BucketAccessKey", instanceId above)
const expectedKeyName = "BucketAccessKey-aaaaaaaaaaaa";

const apiBucket = (id: string, name: string): ApiBucket & { logicalId: string | null } => ({
  id,
  type: "bucket",
  url: `https://api.prisma.test/v1/buckets/${id}`,
  name,
  providerName: "aws",
  status: "ready",
  createdAt,
  project: { id: "project-1", url: "https://api.prisma.test/v1/projects/project-1", name: "app" },
  branchId: null,
  // Stamped with the resource's fqn, as the provider leaves it.
  logicalId: "Bucket",
});

const bucketAttrs = (id: string, name: string): Bucket["Attributes"] => ({
  bucketId: id,
  name,
  projectId: "project-1",
  createdAt,
  logicalId: "Bucket",
});

const apiBucketKey = (id: string, name = expectedKeyName): ApiBucketKey => ({
  id,
  type: "bucketKey",
  name,
  valueHint: "AKIA...",
  role: "read_write",
  createdAt,
});

const apiBucketKeyWithSecret = (id: string): BucketKeyWithSecret => ({
  ...apiBucketKey(id),
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "one-time-secret",
  endpoint: "https://s3.prisma.test",
  bucketName: "user-bucket-1",
});

const persistedKeyAttrs = (id: string): BucketAccessKey["Attributes"] => ({
  bucketAccessKeyId: id,
  bucketId: "bucket-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: Redacted.make("one-time-secret"),
  endpoint: "https://s3.prisma.test",
  bucketName: "user-bucket-1",
});

const apiNotFound = (path: string) =>
  new PrismaApiError({ method: "GET", path, status: 404, message: "HTTP 404" });

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

/**
 * Serve the Management API's bucket routes from the same hermetic
 * client-shaped handlers this suite already declares. `dispatchTo` maps each
 * handler's result onto the wire (see the fixture).
 */
const bucketApi = (client: any) =>
  makeFakeManagementApi((request) => {
    // segments[0] is the "v1" prefix.
    const [head, bucketId, tail, keyId] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as any;
    const { call, callVoid, list } = dispatchTo(request);

    if (head === "projects" && tail === "branches" && request.method === "GET") {
      // Without branches the logical-ID lookup resolves no default branch.
      return call(client.listBranches ?? (() => Effect.succeed([])), [], list);
    }
    if (head !== "buckets") return unhandled(request);
    if (bucketId === undefined) {
      return request.method === "GET"
        ? call(client.listBuckets, [Object.fromEntries(new URLSearchParams(request.search))], list)
        : call(client.createBucket, [body]);
    }
    if (tail === "keys") {
      if (keyId !== undefined) {
        return callVoid(client.deleteBucketKey, [bucketId, keyId]);
      }
      return request.method === "GET"
        ? call(client.listBucketKeys, [bucketId, { limit: 100 }], list)
        : call(client.createBucketKey, [bucketId, body]);
    }
    if (request.method === "GET") return call(client.getBucket, [bucketId]);
    if (request.method === "PATCH") {
      return call(client.updateBucket, [bucketId, body]);
    }
    if (request.method === "DELETE") {
      return callVoid(client.deleteBucket, [bucketId]);
    }
    return unhandled(request);
  });

const bucketLayer = (client: PrismaManagementClient) =>
  BucketProvider().pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(bucketApi(client).layer),
  );

const bucketKeyLayer = (client: PrismaManagementClient) =>
  BucketAccessKeyProvider().pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(bucketApi(client).layer),
  );

const reconcileInput = <Props, Attributes>(
  id: string,
  news: Props,
  output?: Attributes,
  olds?: Props,
) => ({ id, fqn: id, instanceId, news, olds, output, session: undefined as never, bindings: [] });

const diffInput = <Props, Attributes>(id: string, olds: Props, news: Props, output?: Attributes) =>
  ({ id, fqn: id, instanceId, olds, news, output }) as never;

describe(
  "Prisma Bucket provider",
  { tags: ["unit", "provider:prisma", "provider:prisma:bucket", "local"] },
  () => {
    it.effect("creates a bucket when none is persisted", () => {
      let creates = 0;
      const client = {
        createBucket: (input: { projectId: string; name?: string; branchId?: string }) =>
          Effect.sync(() => {
            creates += 1;
            expect(input.projectId).toBe("project-1");
            expect(input.name).toBe("uploads");
            expect(input.branchId).toBeUndefined();
            return apiBucket("bucket-1", "uploads");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("Bucket", { project: "project-1", name: "uploads" }),
        );

        expect(creates).toBe(1);
        expect(attrs).toEqual(bucketAttrs("bucket-1", "uploads"));
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("returns the observed bucket without creating again", () => {
      let creates = 0;
      const client = {
        getBucket: (id: string) => Effect.succeed(apiBucket(id, "uploads")),
        createBucket: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucket("bucket-2", "uploads");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput(
            "Bucket",
            { project: "project-1", name: "uploads" },
            bucketAttrs("bucket-1", "uploads"),
          ),
        );

        expect(creates).toBe(0);
        expect(attrs.bucketId).toBe("bucket-1");
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("refuses convergence when the bucket moved projects", () => {
      const client = {
        getBucket: (id: string) =>
          Effect.succeed({
            ...apiBucket(id, "uploads"),
            project: {
              id: "project-other",
              url: "https://api.prisma.test/v1/projects/project-other",
              name: "other",
            },
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const result = yield* provider
          .reconcile(
            reconcileInput(
              "Bucket",
              { project: "project-1", name: "uploads" },
              bucketAttrs("bucket-1", "uploads"),
            ),
          )
          .pipe(Effect.flip);

        expect(String(result)).toContain("Refusing to claim convergence");
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("recreates the bucket when the persisted one is gone", () => {
      let creates = 0;
      const client = {
        getBucket: (id: string) => Effect.fail(apiNotFound(`/v1/buckets/${id}`)),
        createBucket: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucket("bucket-2", "uploads");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput(
            "Bucket",
            { project: "project-1", name: "uploads" },
            bucketAttrs("bucket-1", "uploads"),
          ),
        );

        expect(creates).toBe(1);
        expect(attrs.bucketId).toBe("bucket-2");
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("read refreshes from the API and reports a gone bucket", () => {
      const client = {
        getBucket: (id: string) =>
          id === "bucket-1"
            ? Effect.succeed(apiBucket(id, "uploads"))
            : Effect.fail(apiNotFound(`/v1/buckets/${id}`)),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Provider.findProvider(Bucket);
        const observed = yield* provider.read!({
          id: "Bucket",
          fqn: "Bucket",
          instanceId,
          olds: { project: "project-1", name: "uploads" },
          output: bucketAttrs("bucket-1", "uploads"),
        });
        expect(observed).toEqual(bucketAttrs("bucket-1", "uploads"));

        const gone = yield* provider.read!({
          id: "Bucket",
          fqn: "Bucket",
          instanceId,
          olds: { project: "project-1", name: "uploads" },
          output: bucketAttrs("bucket-2", "uploads"),
        });
        expect(gone).toBeUndefined();
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect(
      "replaces on a project change and updates name, branch, or logical ID in place",
      () => {
        const client = {} as unknown as PrismaManagementClient;
        const olds: BucketProps = { project: "project-1", name: "uploads" };
        const output = bucketAttrs("bucket-1", "uploads");

        return Effect.gen(function* () {
          const provider = yield* Bucket.Provider;

          expect(
            yield* provider.diff!(
              diffInput("Bucket", olds, { project: "project-2", name: "uploads" }, output),
            ),
          ).toEqual({ action: "replace" });
          expect(
            yield* provider.diff!(
              diffInput("Bucket", olds, { project: "project-1", name: "renamed" }, output),
            ),
          ).toEqual({ action: "update" });
          expect(
            yield* provider.diff!(
              diffInput(
                "Bucket",
                olds,
                { project: "project-1", name: "uploads", branchId: "branch-1" },
                output,
              ),
            ),
          ).toEqual({ action: "update" });
          expect(
            yield* provider.diff!(
              diffInput(
                "Bucket",
                olds,
                { project: "project-1", name: "uploads", logicalId: "uploads" },
                output,
              ),
            ),
          ).toEqual({ action: "update" });
          expect(yield* provider.diff!(diffInput("Bucket", olds, olds, output))).toBeUndefined();
        }).pipe(Effect.provide(bucketLayer(client)));
      },
    );

    it.effect("creates a bucket with its logical ID", () => {
      const inputs: unknown[] = [];
      const client = {
        listBuckets: () => Effect.succeed([]),
        createBucket: (input: { logicalId?: string }) =>
          Effect.sync(() => {
            inputs.push(input);
            return {
              ...apiBucket("bucket-1", "uploads"),
              branchId: "branch-1",
              logicalId: input.logicalId,
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("Bucket", {
            project: "project-1",
            name: "uploads",
            branchId: "branch-1",
            logicalId: "uploads",
          }),
        );

        expect(inputs).toEqual([
          {
            projectId: "project-1",
            name: "uploads",
            branchId: "branch-1",
            logicalId: "uploads",
          },
        ]);
        expect(attrs.logicalId).toBe("uploads");
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect(
      "cold read finds the bucket by its logical ID as unowned and ignores a same-named one",
      () => {
        const listed: unknown[] = [];
        const buckets = [
          { ...apiBucket("bucket-named", "uploads"), branchId: "branch-1", logicalId: null },
          {
            ...apiBucket("bucket-declared", "renamed-in-console"),
            branchId: "branch-1",
            logicalId: "uploads",
          },
        ];
        const client = {
          listBuckets: (query: { logicalId?: string }) =>
            Effect.sync(() => {
              listed.push(query);
              return buckets.filter(
                (bucket) =>
                  query.logicalId === undefined ||
                  ("logicalId" in bucket && bucket.logicalId === query.logicalId),
              );
            }),
        } as unknown as PrismaManagementClient;
        const read = (logicalId?: string) =>
          Effect.gen(function* () {
            const provider = yield* Provider.findProvider(Bucket);
            return yield* provider.read!({
              id: "Bucket",
              fqn: "Bucket",
              instanceId,
              olds: {
                project: "project-1",
                name: "uploads",
                branchId: "branch-1",
                ...(logicalId === undefined ? {} : { logicalId }),
              },
              output: undefined,
            });
          });

        return Effect.gen(function* () {
          // A logical ID does not prove ownership; adoption is required.
          const found = yield* read("uploads");
          expect(Unowned.is(found)).toBe(true);
          expect({ ...found }).toEqual({
            ...bucketAttrs("bucket-declared", "renamed-in-console"),
            logicalId: "uploads",
          });
          expect(listed).toEqual([
            {
              projectId: "project-1",
              logicalId: "uploads",
              branchId: "branch-1",
            },
          ]);

          expect(yield* read("other")).toBeUndefined();
          // Without an explicit logical ID the lookup uses the fqn, never the name.
          expect(yield* read()).toBeUndefined();
          expect(listed).toHaveLength(3);
          expect(listed[2]).toEqual({
            projectId: "project-1",
            logicalId: "Bucket",
            branchId: "branch-1",
          });
        }).pipe(Effect.provide(bucketLayer(client)));
      },
    );

    it.effect("moves and renames in place, then sets the logical ID in a second call", () => {
      const patches: unknown[] = [];
      let observed: Record<string, unknown> = {
        ...apiBucket("bucket-1", "uploads"),
        branchId: "branch-1",
        logicalId: null,
      };
      const client = {
        getBucket: () => Effect.sync(() => observed),
        updateBucket: (_id: string, body: Record<string, unknown>) =>
          Effect.sync(() => {
            patches.push(body);
            const { displayName, ...rest } = body;
            observed = {
              ...observed,
              ...rest,
              ...(displayName === undefined ? {} : { name: displayName }),
            };
            return observed;
          }),
        createBucket: () => Effect.die("must converge in place"),
        deleteBucket: () => Effect.die("must converge in place"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput(
            "Bucket",
            {
              project: "project-1",
              name: "renamed",
              branchId: "branch-2",
              logicalId: "uploads",
            },
            bucketAttrs("bucket-1", "uploads"),
            { project: "project-1", name: "uploads", branchId: "branch-1" },
          ),
        );

        expect(patches).toEqual([
          { displayName: "renamed", branchId: "branch-2" },
          { logicalId: "uploads" },
        ]);
        expect(attrs).toEqual({
          ...bucketAttrs("bucket-1", "renamed"),
          logicalId: "uploads",
        });
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("names the logical ID and branch on a duplicate", () => {
      const client = {
        listBuckets: () => Effect.succeed([]),
        createBucket: () =>
          Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: "/v1/buckets",
              status: 409,
              message: "HTTP 409",
            }),
          ),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        const error = yield* provider
          .reconcile(
            reconcileInput("Bucket", {
              project: "project-1",
              branchId: "branch-1",
              logicalId: "uploads",
            }),
          )
          .pipe(Effect.flip);

        expect(String(error)).toContain("logical ID 'uploads'");
        expect(String(error)).toContain("branch 'branch-1'");
      }).pipe(Effect.provide(bucketLayer(client)));
    });

    it.effect("delete verifies identity and tolerates a gone bucket", () => {
      let deletes = 0;
      const client = {
        getBucket: (id: string) =>
          id === "bucket-1"
            ? Effect.succeed(apiBucket(id, "uploads"))
            : Effect.fail(apiNotFound(`/v1/buckets/${id}`)),
        deleteBucket: (id: string) =>
          Effect.sync(() => {
            deletes += 1;
          }).pipe(Effect.andThen(Effect.fail(apiNotFound(`/v1/buckets/${id}`)))),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Bucket.Provider;
        yield* provider.delete({
          id: "Bucket",
          fqn: "Bucket",
          instanceId,
          olds: { project: "project-1", name: "uploads" },
          output: bucketAttrs("bucket-1", "uploads"),
          session: undefined as never,
        } as never);
        expect(deletes).toBe(1);

        // Already gone: delete is a no-op.
        yield* provider.delete({
          id: "Bucket",
          fqn: "Bucket",
          instanceId,
          olds: { project: "project-1", name: "uploads" },
          output: bucketAttrs("bucket-2", "uploads"),
          session: undefined as never,
        } as never);
        expect(deletes).toBe(1);

        // Drifted to another project: refuse to delete.
        const drifted = yield* provider
          .delete({
            id: "Bucket",
            fqn: "Bucket",
            instanceId,
            olds: { project: "project-1", name: "uploads" },
            output: { ...bucketAttrs("bucket-1", "uploads"), projectId: "p2" },
            session: undefined as never,
          } as never)
          .pipe(Effect.flip);
        expect(String(drifted)).toContain("Refusing to delete");
      }).pipe(Effect.provide(bucketLayer(client)));
    });
  },
);

describe(
  "Prisma BucketAccessKey provider",
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:bucket",
      "provider:prisma:bucketaccesskey",
      "local",
    ],
  },
  () => {
    it.effect("creates a key under its deterministic name and redacts the secret", () => {
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([]),
        createBucketKey: (bucketId: string, input: { name?: string; role: string }) =>
          Effect.sync(() => {
            creates += 1;
            expect(bucketId).toBe("bucket-1");
            expect(input.name).toBe(expectedKeyName);
            expect(input.role).toBe("read_write");
            return apiBucketKeyWithSecret("key-1");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("BucketAccessKey", { bucket: "bucket-1", role: "read_write" as const }),
        );

        expect(creates).toBe(1);
        expect(attrs.bucketAccessKeyId).toBe("key-1");
        expect(attrs.bucketId).toBe("bucket-1");
        expect(attrs.accessKeyId).toBe("AKIAEXAMPLE");
        expect(Redacted.value(attrs.secretAccessKey)).toBe("one-time-secret");
        expect(attrs.endpoint).toBe("https://s3.prisma.test");
        // The provider-side S3 bucket name, not the friendly display name.
        expect(attrs.bucketName).toBe("user-bucket-1");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("revokes an orphaned key from a lost create response before recreating", () => {
      // Simulates a crash after POST /keys but before state persist: the
      // retry sees no output, finds the deterministic name already taken,
      // revokes it (its secret is unrecoverable), and mints a fresh key.
      let deletes = 0;
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([apiBucketKey("key-orphan")]),
        deleteBucketKey: (bucketId: string, keyId: string) =>
          Effect.sync(() => {
            deletes += 1;
            expect(bucketId).toBe("bucket-1");
            expect(keyId).toBe("key-orphan");
          }),
        createBucketKey: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucketKeyWithSecret("key-2");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("BucketAccessKey", { bucket: "bucket-1", role: "read_write" as const }),
        );

        expect(deletes).toBe(1);
        expect(creates).toBe(1);
        expect(attrs.bucketAccessKeyId).toBe("key-2");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("fails with a tagged error when two keys share the recovery name", () => {
      // Two keys under the deterministic name leave nothing to recover:
      // picking either could revoke a key another deploy is using.
      const client = {
        listBucketKeys: () => Effect.succeed([apiBucketKey("key-a"), apiBucketKey("key-b")]),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const error = yield* provider
          .reconcile(
            reconcileInput("BucketAccessKey", { bucket: "bucket-1", role: "read_write" as const }),
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("AmbiguousBucketAccessKeyError");
        expect(error.message).toContain("refusing to select one arbitrarily");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("returns persisted attributes while the key exists, without re-creating", () => {
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([apiBucketKey("key-1")]),
        createBucketKey: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucketKeyWithSecret("key-2");
          }),
      } as unknown as PrismaManagementClient;

      const persisted = persistedKeyAttrs("key-1");

      return Effect.gen(function* () {
        const provider = yield* Provider.findProvider(BucketAccessKey);
        const attrs = yield* provider.reconcile(
          reconcileInput(
            "BucketAccessKey",
            { bucket: "bucket-1", role: "read_write" as const },
            persisted,
            { bucket: "bucket-1", role: "read_write" as const },
          ),
        );

        // The secret is returned exactly once at creation; persisted state
        // stays authoritative while the key exists.
        expect(creates).toBe(0);
        expect(attrs).toBe(persisted);

        const observed = yield* provider.read!({
          id: "BucketAccessKey",
          fqn: "BucketAccessKey",
          instanceId,
          olds: { bucket: "bucket-1", role: "read_write" as const },
          output: persisted,
        });
        expect(observed).toBe(persisted);
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("mints fresh credentials when the key was revoked", () => {
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([]),
        createBucketKey: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucketKeyWithSecret("key-2");
          }),
      } as unknown as PrismaManagementClient;

      const persisted = persistedKeyAttrs("key-1");

      return Effect.gen(function* () {
        const provider = yield* Provider.findProvider(BucketAccessKey);

        const observed = yield* provider.read!({
          id: "BucketAccessKey",
          fqn: "BucketAccessKey",
          instanceId,
          olds: { bucket: "bucket-1", role: "read_write" as const },
          output: persisted,
        });
        expect(observed).toBeUndefined();

        const attrs = yield* provider.reconcile(
          reconcileInput(
            "BucketAccessKey",
            { bucket: "bucket-1", role: "read_write" as const },
            persisted,
            { bucket: "bucket-1", role: "read_write" as const },
          ),
        );
        expect(creates).toBe(1);
        expect(attrs.bucketAccessKeyId).toBe("key-2");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("replaces on bucket, role, or name changes", () => {
      const client = {} as unknown as PrismaManagementClient;
      const olds: BucketAccessKeyProps = { bucket: "bucket-1", role: "read_write" };
      const output = persistedKeyAttrs("key-1");

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;

        expect(
          yield* provider.diff!(
            diffInput(
              "BucketAccessKey",
              olds,
              { bucket: "bucket-2", role: "read_write" as const },
              output,
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* provider.diff!(
            diffInput(
              "BucketAccessKey",
              olds,
              { bucket: "bucket-1", role: "read" as const },
              output,
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* provider.diff!(
            diffInput(
              "BucketAccessKey",
              olds,
              { bucket: "bucket-1", role: "read_write" as const, name: "next" },
              output,
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* provider.diff!(diffInput("BucketAccessKey", olds, olds, output)),
        ).toBeUndefined();
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });

    it.effect("delete tolerates keys already revoked by bucket cascade", () => {
      let deletes = 0;
      const client = {
        deleteBucketKey: (bucketId: string, keyId: string) =>
          Effect.sync(() => {
            deletes += 1;
            expect(bucketId).toBe("bucket-1");
            expect(keyId).toBe("key-1");
          }).pipe(Effect.andThen(Effect.fail(apiNotFound("/v1/buckets/bucket-1/keys/key-1")))),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        yield* provider.delete({
          id: "BucketAccessKey",
          fqn: "BucketAccessKey",
          instanceId,
          olds: { bucket: "bucket-1", role: "read_write" },
          output: persistedKeyAttrs("key-1"),
          session: undefined as never,
        } as never);

        expect(deletes).toBe(1);
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    });
  },
);

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:bucket",
  "provider:prisma:branch",
  "provider:prisma:project",
  "live",
];

const observeBucket = (bucketId: string) =>
  getBucket({ bucketId }).pipe(Effect.map((response) => response.data));

const expectBucketGone = (bucketId: string) =>
  expectGone(
    getBucket({ bucketId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const bucketStack = (props: { name?: string; logicalId?: string; onBranch?: boolean } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const branch = yield* Prisma.Branch("Feature", { project, gitName: "feature/bucket" });
    const bucket = yield* Prisma.Bucket("Uploads", {
      project,
      ...(props.name === undefined ? {} : { name: props.name }),
      ...(props.logicalId === undefined ? {} : { logicalId: props.logicalId }),
      ...(props.onBranch ? { branchId: branch.branchId } : {}),
    });
    return { project, branch, bucket };
  });

live.test.provider(
  "creates a bucket under its fqn logical ID and renames, moves, and rebinds it in place",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(initial.bucket.logicalId).toBe("Uploads");
    const created = yield* observeBucket(initial.bucket.bucketId);
    expect(created.project.id).toBe(initial.project.projectId);
    expect(created.name).toBe("uploads");
    expect(created.logicalId).toBe("Uploads");

    const renamed = yield* stack.deploy(bucketStack({ name: "uploads-renamed" }));
    expect(renamed.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).name).toBe("uploads-renamed");

    // A branch move keeps the bucket and its logical ID.
    const moved = yield* stack.deploy(bucketStack({ name: "uploads-renamed", onBranch: true }));
    expect(moved.bucket.bucketId).toBe(initial.bucket.bucketId);
    const onBranch = yield* observeBucket(initial.bucket.bucketId);
    expect(onBranch.branchId).toBe(initial.branch.branchId);
    expect(onBranch.logicalId).toBe("Uploads");

    const overridden = yield* stack.deploy(
      bucketStack({ name: "uploads-renamed", onBranch: true, logicalId: "media" }),
    );
    expect(overridden.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBe("media");

    const reverted = yield* stack.deploy(bucketStack({ name: "uploads-renamed", onBranch: true }));
    expect(reverted.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBe("Uploads");

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "after lost state, adoption finds the bucket by its logical ID despite a Console rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    yield* updateBucket({ bucketId: initial.bucket.bucketId, displayName: "renamed-in-console" });
    yield* forgetState(stack, "Uploads");

    // A bucket has no generated name, so nothing proves it is ours.
    const refused = yield* failureOf(stack.deploy(bucketStack({ name: "uploads" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Feature", { project, gitName: "feature/bucket" });
        const bucket = yield* Prisma.Bucket("Uploads", { project, name: "uploads" }).pipe(
          adopt(true),
        );
        return { project, branch, bucket };
      }),
    );
    expect(adopted.bucket.bucketId).toBe(initial.bucket.bucketId);
    const observed = yield* observeBucket(initial.bucket.bucketId);
    expect(observed.name).toBe("uploads");
    expect(observed.logicalId).toBe("Uploads");

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "sets the logical ID on a bucket deployed before logical IDs existed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    yield* updateBucket({ bucketId: initial.bucket.bucketId, logicalId: null });
    yield* patchStateAttr(stack, "Uploads", { logicalId: null });
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBeNull();

    const stamped = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(stamped.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect(stamped.bucket.logicalId).toBe("Uploads");
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBe("Uploads");

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "replaces the bucket when its project changes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    // Both projects exist before the move, so the new project ID is known at plan time.
    const resources = (target: "first" | "second") =>
      Effect.gen(function* () {
        const first = yield* Prisma.Project("First", { createDatabase: false });
        const second = yield* Prisma.Project("Second", { createDatabase: false });
        const bucket = yield* Prisma.Bucket("Uploads", {
          project: target === "first" ? first : second,
          name: "uploads",
        });
        return { first, second, bucket };
      });

    const initial = yield* stack.deploy(resources("first"));
    const replaced = yield* stack.deploy(resources("second"));
    expect(replaced.bucket.bucketId).not.toBe(initial.bucket.bucketId);
    expect(replaced.bucket.projectId).toBe(initial.second.projectId);
    const observed = yield* observeBucket(replaced.bucket.bucketId);
    expect(observed.project.id).toBe(initial.second.projectId);
    expect(observed.logicalId).toBe("Uploads");
    yield* expectBucketGone(initial.bucket.bucketId);

    yield* stack.destroy();
    yield* expectBucketGone(replaced.bucket.bucketId);
    yield* expectProjectGone(initial.first.projectId);
    yield* expectProjectGone(initial.second.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "rejects a logical ID that another bucket on the branch holds",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (secondLogicalId: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.Bucket("First", { project, logicalId: "shared" });
        const second = yield* Prisma.Bucket("Second", { project, logicalId: secondLogicalId });
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources("second"));
    const failure = yield* failureOf(stack.deploy(resources("shared")));
    expect(failure.text).toContain("logical ID 'shared'");
    expect((yield* observeBucket(initial.first.bucketId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectBucketGone(initial.second.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);
