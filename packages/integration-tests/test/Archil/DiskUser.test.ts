import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Archil.providers() });

const users = (diskId: string) =>
  archil.getDisk({ id: diskId }).pipe(
    Effect.map(({ data }) => (data.authorizedUsers ?? []).map((u) => u.identifier)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as Array<string | undefined>)),
  );

/**
 * The disk's users once `identifier` is listed: for a few seconds after a
 * user is added, some `getDisk` reads still list the disk without it.
 */
const usersWith = (diskId: string, identifier: string) =>
  users(diskId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (ids) => ids.includes(identifier),
      times: 20,
    }),
  );

test.provider(
  "disk user mints a token for one disk, re-mints on rename, and is revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (nickname?: string) =>
        Effect.gen(function* () {
          const disk = yield* Archil.Disk("Shared", {});
          const user = yield* Archil.DiskUser("Reader", { disk: disk.diskId, nickname });
          return { disk, user };
        });

      const { disk, user } = yield* stack.deploy(app());
      expect(user.type).toBe("token");
      expect(Redacted.value(user.token!).length).toBeGreaterThan(0);
      expect(yield* usersWith(disk.diskId, user.identifier)).toContain(user.identifier);

      const renamed = yield* stack.deploy(app("reader-2"));
      expect(renamed.user.identifier).not.toBe(user.identifier);
      const current = yield* usersWith(disk.diskId, renamed.user.identifier);
      expect(current).toContain(renamed.user.identifier);
      expect(current).not.toContain(user.identifier);

      // Destroying only the user leaves the disk with no extra users.
      yield* stack.deploy(Archil.Disk("Shared", {}));
      expect(yield* users(disk.diskId)).not.toContain(renamed.user.identifier);

      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:diskuser", "live"], timeout: 180_000 },
);

/** Run object calls signed with a disk user's S3 keys, as a host would. */
const withKeys = (user: Archil.DiskUserAttributes) =>
  Effect.provide(
    Layer.mergeAll(
      Objects.objectCredentialsFromKeys({
        region: "aws-us-east-1",
        accessKeyId: user.accessKeyId!,
        secretAccessKey: user.secretAccessKey!,
      }),
      FetchHttpClient.layer,
    ),
  );

const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "succeeded"),
    Effect.catch((e) => Effect.succeed(e._tag)),
  );

test.provider(
  "s3 users reach one disk, read-only keys can't write, and token limits are kept",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // A day-aligned expiry a month out, so redeploys in one run agree.
      const day = 24 * 60 * 60 * 1000;
      const expiresAt = new Date(Math.floor(Date.now() / day) * day + 30 * day)
        .toISOString()
        .replace(".000Z", "Z");
      const app = (readerReadOnly: boolean) =>
        Effect.gen(function* () {
          const disk = yield* Archil.Disk("Keys", {});
          const other = yield* Archil.Disk("Other", {});
          const writer = yield* Archil.DiskUser("Writer", { disk: disk.diskId, type: "s3" });
          const reader = yield* Archil.DiskUser("Reader", {
            disk: disk.diskId,
            type: "s3",
            readOnly: readerReadOnly,
          });
          const limited = yield* Archil.DiskUser("Limited", {
            disk: disk.diskId,
            readOnly: true,
            oneUse: true,
            expiresAt,
          });
          return { disk, other, writer, reader, limited };
        });

      const { disk, other, writer, reader, limited } = yield* stack.deploy(app(true));
      expect(writer.type).toBe("s3");
      expect(writer.accessKeyId).toBe(writer.identifier);
      expect(Redacted.value(writer.secretAccessKey!).length).toBeGreaterThan(0);
      expect(reader.readOnly).toBe(true);

      const ref = { disk: disk.diskId };
      yield* Objects.putObject(ref, "keys.txt", "signed").pipe(withKeys(writer));
      expect(yield* Objects.getObjectText(ref, "keys.txt").pipe(withKeys(reader))).toBe("signed");
      expect(
        yield* failureTag(Objects.putObject(ref, "nope.txt", "x").pipe(withKeys(reader))),
      ).toBe("ObjectAccessDenied");
      expect(
        yield* failureTag(
          Objects.putObject({ disk: other.diskId }, "nope.txt", "x").pipe(withKeys(writer)),
        ),
      ).toBe("ObjectAccessDenied");

      const observed = yield* archil.getDisk({ id: disk.diskId }).pipe(
        Effect.map(({ data }) =>
          (data.authorizedUsers ?? []).find((u) => u.identifier === limited.identifier),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (u) => u !== undefined,
          times: 20,
        }),
      );
      expect(observed?.readOnly).toBe(true);
      expect(observed?.oneUse).toBe(true);
      expect(observed?.expiresAt).toBe(expiresAt);

      // Archil can't change a user: a new readOnly replaces the key.
      const widened = yield* stack.deploy(app(false));
      expect(widened.reader.identifier).not.toBe(reader.identifier);
      expect(widened.reader.readOnly).toBe(false);
      const current = yield* usersWith(disk.diskId, widened.reader.identifier);
      expect(current).toContain(widened.reader.identifier);
      expect(current).not.toContain(reader.identifier);
      yield* Objects.putObject(ref, "now.txt", "writable").pipe(withKeys(widened.reader));

      yield* stack.destroy();
      expect(yield* users(disk.diskId)).toEqual([]);
    }),
  { tags: ["provider:archil", "provider:archil:diskuser", "live"], timeout: 180_000 },
);
