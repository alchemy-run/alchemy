import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectGone } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const passwordExists = (serviceAccountId: string, serviceAccountPasswordId: string) =>
  galaxy.serviceAccount.getServiceAccount({ serviceAccountId }).pipe(
    Effect.map((account) =>
      account.passwords.some(
        (password) => password.serviceAccountPasswordId === serviceAccountPasswordId,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create a password once, keep it across deploys, and rotate it by replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (description: string) =>
        Effect.gen(function* () {
          const account = yield* StarburstGalaxy.ServiceAccount("Account", {});
          const password = yield* StarburstGalaxy.ServiceAccountPassword("Password", {
            serviceAccount: account.serviceAccountId,
            description,
          });
          return { account, password };
        });

      const first = yield* stack.deploy(app("first"));
      const accountId = first.account.serviceAccountId;
      const firstId = first.password.serviceAccountPasswordId;
      const prefix = Redacted.value(first.password.passwordPrefix);
      const secret = Redacted.value(first.password.password);
      expect(prefix.length).toBeGreaterThan(0);
      expect(secret.length).toBeGreaterThan(0);
      // Galaxy's documented composition of the Trino credential.
      expect(Redacted.value(first.password.trinoPassword)).toBe(`GXY$${prefix}${secret}`);
      const listed = yield* passwordExists(accountId, firstId);
      expect(listed).toBe(true);

      // An unchanged redeploy keeps the password and its secret.
      const again = yield* stack.deploy(app("first"));
      expect(again.password.serviceAccountPasswordId).toBe(firstId);
      expect(Redacted.value(again.password.trinoPassword)).toBe(`GXY$${prefix}${secret}`);

      // A change replaces the password: a new secret, and the old password goes.
      const rotated = yield* stack.deploy(app("rotated"));
      const rotatedId = rotated.password.serviceAccountPasswordId;
      expect(rotatedId).not.toBe(firstId);
      expect(Redacted.value(rotated.password.trinoPassword)).not.toBe(`GXY$${prefix}${secret}`);
      const rotatedListed = yield* passwordExists(accountId, rotatedId);
      expect(rotatedListed).toBe(true);
      yield* expectGone(passwordExists(accountId, firstId));

      yield* stack.destroy();
      yield* expectGone(passwordExists(accountId, rotatedId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:service-account", "live"],
    timeout: 150_000,
  },
);
