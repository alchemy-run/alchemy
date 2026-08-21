import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/fly-io";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasFlyCreds = !!process.env.FLY_API_TOKEN;

const listTigris = () =>
  Effect.gen(function* () {
    const rows: Array<{ id: string; name: string | null; options: unknown }> =
      [];
    let after: string | undefined;
    for (let i = 0; i < 8; i++) {
      const page = yield* Services.addons.addOns({
        type: "tigris",
        first: 50,
        after,
      });
      for (const edge of page.edges ?? []) {
        if (edge?.node != null) rows.push(edge.node);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor ?? undefined;
      if (after === undefined || after.length === 0) break;
    }
    return rows;
  });

const findAddOn = (addOnId: string, name: string) =>
  listTigris().pipe(
    Effect.map(
      (addOns) =>
        addOns.find((addOn) => addOn.id === addOnId) ??
        addOns.find((addOn) => addOn.name === name),
    ),
  );

const waitUntilBucketGone = (addOnId: string, name: string) =>
  findAddOn(addOnId, name).pipe(
    Effect.map((addOn) =>
      addOn === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAppGone = (appName: string) =>
  Services.machines.appsShow({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const listedSecrets = (appName: string) =>
  Services.machines
    .secretsList({
      app_name: appName,
      show_secrets: false,
    })
    .pipe(
      Effect.map(
        (res) => new Set((res.secrets ?? []).map((secret) => secret.name)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(new Set<string>())),
    );

test.provider.skipIf(!hasFlyCreds)(
  "create, update, and destroy a tigris bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data");
        }),
      );

      expect(created.addOnId).toEqual(expect.any(String));
      expect(created.addOnId.length).toBeGreaterThan(0);
      expect(created.name).toEqual(expect.any(String));
      expect(created.name.length).toBeGreaterThan(0);
      expect(created.public).toEqual(false);

      const fetched = yield* findAddOn(created.addOnId, created.name);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(created.addOnId);
      expect(fetched?.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data", {
            public: true,
          });
        }),
      );

      expect(updated.addOnId).toEqual(created.addOnId);
      expect(updated.name).toEqual(created.name);

      const refetched = yield* findAddOn(updated.addOnId, updated.name);
      expect(refetched).toBeDefined();
      expect(refetched?.id).toEqual(created.addOnId);

      const provider = yield* Provider.findProvider(Fly.Bucket);
      const all = yield* provider.list();
      const listed = all.find((row) => row.addOnId === created.addOnId);
      expect(listed).toBeDefined();
      expect(listed?.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilBucketGone(created.addOnId, created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds)(
  "replace when the name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data");
        }),
      );

      const nextName = sanitizeReplaceName(created.name);
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data", {
            name: nextName,
          });
        }),
      );

      expect(replaced.name).toEqual(nextName);
      expect(replaced.addOnId).not.toEqual(created.addOnId);

      const oldGone = yield* findAddOn(created.addOnId, created.name);
      expect(oldGone).toBeUndefined();
      const next = yield* findAddOn(replaced.addOnId, replaced.name);
      expect(next).toBeDefined();
      expect(next?.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilBucketGone(replaced.addOnId, replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasFlyCreds)(
  "attach writes tigris secrets onto an app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const bucket = yield* Fly.Bucket("Data");
          return { app, bucket };
        }),
      );

      const plain = (value: Redacted.Redacted<string> | undefined) =>
        value !== undefined ? Redacted.value(value) : undefined;
      const values: Record<string, string> = {
        BUCKET_NAME: out.bucket.name,
      };
      const accessKeyId = plain(out.bucket.accessKeyId);
      const secretAccessKey = plain(out.bucket.secretAccessKey);
      const endpoint = plain(out.bucket.endpoint);
      const region = plain(out.bucket.region);
      if (accessKeyId !== undefined) values.AWS_ACCESS_KEY_ID = accessKeyId;
      if (secretAccessKey !== undefined) {
        values.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      }
      if (endpoint !== undefined) values.AWS_ENDPOINT_URL_S3 = endpoint;
      if (region !== undefined) values.AWS_REGION = region;
      if (accessKeyId === undefined) {
        yield* Fly.attachBucketSecrets(out.app.appName, [
          { name: out.bucket.name },
        ]);
      } else {
        yield* Services.machines.secretsUpdate({
          app_name: out.app.appName,
          values,
        });
      }

      const names = yield* listedSecrets(out.app.appName);
      expect(names.has("BUCKET_NAME")).toEqual(true);
      if (accessKeyId !== undefined) {
        expect(names.has("AWS_ACCESS_KEY_ID")).toEqual(true);
        expect(names.has("AWS_SECRET_ACCESS_KEY")).toEqual(true);
      }

      yield* stack.destroy();

      const bucketGone = yield* waitUntilBucketGone(
        out.bucket.addOnId,
        out.bucket.name,
      );
      expect(bucketGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const sanitizeReplaceName = (name: string): string => {
  const clipped = name.length >= 30 ? name.slice(0, 29) : name;
  return `${clipped}x`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
};
