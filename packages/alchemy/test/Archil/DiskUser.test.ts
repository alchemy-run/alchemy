import * as Archil from "@/Archil";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Archil.providers() });

const hasArchil = !!process.env.ARCHIL_API_KEY;

test.provider.skipIf(!hasArchil)(
  "add and remove disk users (token + awssts)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { disk, tokenUser, stsUser } = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* Archil.Disk("UserDisk");
          const tokenUser = yield* Archil.DiskUser("TokenUser", {
            disk,
            user: { type: "token", nickname: "alchemy-test" },
          });
          const stsUser = yield* Archil.DiskUser("StsUser", {
            disk,
            user: {
              type: "awssts",
              principal: "arn:aws:iam::123456789012:role/alchemy-test-role",
            },
          });
          return { disk, tokenUser, stsUser };
        }),
      );

      expect(tokenUser.type).toBe("token");
      expect(tokenUser.nickname).toBe("alchemy-test");
      expect(tokenUser.identifier).toBeTruthy();
      // Token users get a one-time generated disk token.
      expect(tokenUser.diskToken).toBeDefined();
      expect(Redacted.value(tokenUser.diskToken!).length).toBeGreaterThan(0);

      expect(stsUser.type).toBe("awssts");
      expect(stsUser.principal).toBe(
        "arn:aws:iam::123456789012:role/alchemy-test-role",
      );

      // Out-of-band observe: both users are on the disk.
      const observed = yield* Archil.getDisk({
        region: disk.region,
        diskId: disk.diskId,
      });
      const identifiers = (observed.authorizedUsers ?? []).map(
        (u) => u.identifier,
      );
      expect(identifiers).toContain(tokenUser.identifier);
      expect(identifiers).toContain(stsUser.identifier);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
