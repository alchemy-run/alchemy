import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const KEY1 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN6Ot81wrURgF58/jKCFQgEzJFjD39ibwfpeC7JLoS6d";
const KEY2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBpVICT7tXAjpo6pXw/44Wm+DYcQRexT7J8nwS9/XtnL";

const EXPIRY_A = "4102444800000000";
const EXPIRY_B = "4133980800000000";

const entitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;

const waitUntilGone = (name: string) =>
  oslogin.getUsersSshPublicKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const credentialUser = /credential for \[([^\]]+)\]/i;

const probeAccess = () =>
  oslogin.getLoginProfileUsers({ name: "users/me" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", (error) => {
      const match = credentialUser.exec(error.message);
      if (match?.[1] === undefined) {
        return Effect.succeed(error._tag);
      }
      return oslogin.getLoginProfileUsers({ name: `users/${match[1]}` }).pipe(
        Effect.as("ok" as const),
        Effect.catchTag(["Forbidden", "NotFound"], (retry) =>
          Effect.succeed(retry._tag),
        ),
      );
    }),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error._tag)),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getUsersSshPublicKeys on a missing key fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oslogin.getUsersSshPublicKeys({
          name: "users/me/sshPublicKeys/alchemy-missing-fingerprint",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createUsersSshPublicKeys without OS Login access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* oslogin
        .createUsersSshPublicKeys({
          parent: "users/me",
          body: {
            key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOSQWE/IE50EMTkE2Yw9fIy6UT+fds+rNJhQGCsxnvjB",
          },
        })
        .pipe(
          Effect.map((key) => ({
            _tag: "ok" as const,
            name: key.name,
          })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ _tag: error._tag, name: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.name) {
          yield* oslogin
            .deleteUsersSshPublicKeys({ name: result.name })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest", "Conflict"],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect([...entitlementTags]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete an SSH public key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
            key: KEY1,
            expirationTimeUsec: EXPIRY_A,
          });
        }),
      );

      expect(created.name.length).toBeGreaterThan(0);
      expect(created.fingerprint.length).toBeGreaterThan(0);
      expect(created.user.length).toBeGreaterThan(0);
      expect(created.key).toContain(KEY1.split(" ")[1]);
      expect(created.expirationTimeUsec).toEqual(EXPIRY_A);

      const fetched = yield* oslogin.getUsersSshPublicKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fingerprint).toEqual(created.fingerprint);
      expect(fetched.key).toContain("[alchemy ");
      expect(fetched.expirationTimeUsec).toEqual(EXPIRY_A);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
            key: KEY1,
            expirationTimeUsec: EXPIRY_B,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.fingerprint).toEqual(created.fingerprint);
      expect(updated.expirationTimeUsec).toEqual(EXPIRY_B);

      const fetchedUpdate = yield* oslogin.getUsersSshPublicKeys({
        name: updated.name,
      });
      expect(fetchedUpdate.expirationTimeUsec).toEqual(EXPIRY_B);
      expect(fetchedUpdate.key).toContain("[alchemy ");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
            key: KEY2,
            expirationTimeUsec: EXPIRY_B,
          });
        }),
      );

      expect(replaced.fingerprint).not.toEqual(created.fingerprint);
      expect(replaced.key).toContain(KEY2);

      const fetchedReplace = yield* oslogin.getUsersSshPublicKeys({
        name: replaced.name,
      });
      expect(fetchedReplace.fingerprint).toEqual(replaced.fingerprint);
      expect(fetchedReplace.key).toContain(KEY2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000, exclusive: true },
);
