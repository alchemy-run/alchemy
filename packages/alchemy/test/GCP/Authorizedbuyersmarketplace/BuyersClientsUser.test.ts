import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  hasGcpCreds,
  lifecycleParent,
  logLevel,
  probeName,
  probeParent,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getBuyersClientsUsers on a missing client user fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        marketplace.getBuyersClientsUsers({ name: probeName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createBuyersClientsUsers without Marketplace access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* Effect.result(
        marketplace.createBuyersClientsUsers({
          parent: probeParent,
          body: { email: "alchemy-abm-probe@example.com" },
        }),
      );
      if (Result.isFailure(result)) {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(
          result.failure._tag,
        );
      } else if (result.success.name) {
        yield* marketplace
          .deleteBuyersClientsUsers({ name: result.success.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a client user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const createdOrDenied = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
              "Analyst",
              {
                parent: lifecycleParent,
                email: "analyst@example.com",
              },
            );
          }),
        ),
      );

      if (Result.isFailure(createdOrDenied)) {
        expect([
          "Forbidden",
          "NotFound",
          "BadRequest",
          "GCP.Authorizedbuyersmarketplace.BuyersClientsUserNotResolved",
        ]).toContain(createdOrDenied.failure._tag);
        yield* stack.destroy();
        return;
      }

      const created = createdOrDenied.success;
      expect(created.name).toContain("/users/");
      expect(created.parent).toEqual(lifecycleParent);
      expect(created.email).toEqual("analyst@example.com");
      expect(created.userId.length).toBeGreaterThan(0);
      expect(["INVITED", "ACTIVE", "INACTIVE"]).toContain(created.state);

      const fetched = yield* marketplace.getBuyersClientsUsers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");
      expect(fetched.email).toContain("analyst");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
            "Analyst",
            {
              parent: created.parent,
              userId: created.userId,
              email: "analyst@example.com",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.email).toEqual("analyst@example.com");
      expect(updated.userId).toEqual(created.userId);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
            "Analyst",
            {
              parent: created.parent,
              email: "analyst-v2@example.com",
            },
          );
        }),
      );

      expect(replaced.email).toEqual("analyst-v2@example.com");
      expect(replaced.parent).toEqual(created.parent);

      const fetchedReplace = yield* marketplace.getBuyersClientsUsers({
        name: replaced.name,
      });
      expect(fetchedReplace.email).toContain("analyst-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
