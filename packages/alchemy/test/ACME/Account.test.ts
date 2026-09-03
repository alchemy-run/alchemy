import * as ACME from "@/ACME";
import * as Test from "@/Test/Alchemy";
import * as acme from "@distilled.cloud/acme/acme";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { dockerAvailable, startPebble, stopPebble } from "./Pebble.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: ACME.providers(),
});

const SUITE = "account";
const pebble = beforeAll(startPebble(SUITE, { acme: 14100, management: 8100 }));
afterAll(stopPebble(SUITE));

/** `newAccount` with `onlyReturnExisting`, out of band, as the stored key. */
const lookup = (
  ca: ACME.CertificateAuthority,
  privateKey: Redacted.Redacted<string>,
) =>
  acme
    .newAccount({ onlyReturnExisting: true })
    .pipe(
      Effect.provide(ACME.accountLayer({ ca, accountKey: privateKey })),
      Effect.result,
    );

test.provider.skipIf(!dockerAvailable)(
  "creates an account, keeps its key, updates contacts and deactivates",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* pebble;
      yield* stack.destroy();

      const program = (contact: string[]) =>
        Effect.gen(function* () {
          return yield* ACME.Account("Pebble", {
            ca: env.ca,
            contact,
            termsOfServiceAgreed: true,
          });
        });

      const first = yield* stack.deploy(program(["mailto:first@example.test"]));
      expect(first.directoryUrl).toBe(env.directoryUrl);
      expect(first.accountUrl).toContain("/my-account/");
      expect(first.status).toBe("valid");
      expect(first.contact).toEqual(["mailto:first@example.test"]);
      expect(first.keyAlgorithm).toBe("ES256");
      expect(Redacted.isRedacted(first.privateKey)).toBe(true);
      const jwk = JSON.parse(Redacted.value(first.privateKey)) as {
        kty: string;
      };
      expect(jwk.kty).toBe("EC");

      // Out of band: the CA knows the key.
      const found = yield* lookup(env.ca, first.privateKey);
      expect(Result.isSuccess(found)).toBe(true);
      if (Result.isSuccess(found)) {
        expect(found.success.location).toBe(first.accountUrl);
      }

      // Same props: nothing changes, the key and URL are stable.
      const again = yield* stack.deploy(program(["mailto:first@example.test"]));
      expect(again.accountUrl).toBe(first.accountUrl);
      expect(Redacted.value(again.privateKey)).toBe(
        Redacted.value(first.privateKey),
      );

      // Contacts sync in place.
      const updated = yield* stack.deploy(
        program(["mailto:second@example.test"]),
      );
      expect(updated.accountUrl).toBe(first.accountUrl);
      expect(updated.contact).toEqual(["mailto:second@example.test"]);

      yield* stack.destroy();

      // Deactivated accounts are refused, typed.
      const gone = yield* lookup(env.ca, first.privateKey);
      expect(Result.isFailure(gone)).toBe(true);
      if (Result.isFailure(gone)) {
        expect(["AcmeUnauthorized", "AcmeAccountDoesNotExist"]).toContain(
          gone.failure._tag,
        );
      }
    }),
  { timeout: 90_000 },
);

test.provider.skipIf(!dockerAvailable)(
  "changing the CA or key algorithm replaces the account",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* pebble;
      yield* stack.destroy();
      const first = yield* stack.deploy(
        ACME.Account("Replaced", { ca: env.ca, termsOfServiceAgreed: true }),
      );
      const plan = yield* stack.plan(
        ACME.Account("Replaced", {
          ca: env.ca,
          termsOfServiceAgreed: true,
          keyAlgorithm: "RS256",
        }),
      );
      expect(JSON.stringify(plan)).toContain("replace");
      const replaced = yield* stack.deploy(
        ACME.Account("Replaced", {
          ca: env.ca,
          termsOfServiceAgreed: true,
          keyAlgorithm: "RS256",
        }),
      );
      expect(replaced.keyAlgorithm).toBe("RS256");
      expect(replaced.accountUrl).not.toBe(first.accountUrl);
      expect(
        (JSON.parse(Redacted.value(replaced.privateKey)) as { kty: string })
          .kty,
      ).toBe("RSA");
      // The old account was deactivated by the replacement.
      const old = yield* lookup(env.ca, first.privateKey);
      expect(Result.isFailure(old)).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 90_000 },
);
