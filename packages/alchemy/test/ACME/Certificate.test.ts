import * as ACME from "@/ACME";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Jose } from "@distilled.cloud/acme";
import * as acme from "@distilled.cloud/acme/acme";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { dockerAvailable, startPebble, stopPebble } from "./Pebble.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: ACME.providers(),
});

const SUITE = "certificate";
const pebble = beforeAll(startPebble(SUITE, { acme: 14200, management: 8200 }));
afterAll(stopPebble(SUITE));

const NAMES = ["*.acme.example.test", "acme.example.test"];

test.provider.skipIf(!dockerAvailable)(
  "issues a wildcard over DNS-01, keeps it, renews on schedule, re-issues on change and revokes on delete",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* pebble;
      yield* stack.destroy();

      const program = (
        identifiers: string[],
        extra: Partial<ACME.CertificateProps> = {},
      ) =>
        Effect.gen(function* () {
          const account = yield* ACME.Account("Pebble", {
            ca: env.ca,
            termsOfServiceAgreed: true,
          });
          const cert = yield* ACME.Certificate("Wildcard", {
            account,
            identifiers,
            solver: env.solver,
            revokeOnDelete: true,
            // Pebble issues ~6-day certificates; the default 30-day window
            // would renew on every deploy.
            renewBefore: "1 day",
            ...extra,
          });
          return { account, cert };
        });

      const first = yield* stack.deploy(program(NAMES));
      const parsed = yield* ACME.parseCertificate(first.cert.certificate);
      expect([...parsed.dnsNames].sort()).toEqual([...NAMES].sort());
      // Pebble (like Let's Encrypt) drops the CSR subject; SANs are what count.
      expect(first.cert.serial).toBe(parsed.serial);
      expect(first.cert.issuer).toContain("Pebble");
      expect(first.cert.notAfter).toBe(parsed.notAfter.toISOString());
      expect(Date.parse(first.cert.notAfter)).toBeGreaterThan(Date.now());
      expect(first.cert.identifiers).toEqual(NAMES);
      expect(first.cert.keyAlgorithm).toBe("ES256");
      expect(first.cert.directoryUrl).toBe(env.directoryUrl);
      expect(first.cert.certificateUrl).toContain("/certZ/");
      // Chain is leaf first, then Pebble's intermediate.
      expect(ACME.splitPemChain(first.cert.chain).length).toBeGreaterThan(1);
      expect(first.cert.chain.startsWith(first.cert.certificate.trim())).toBe(
        true,
      );
      expect(Redacted.value(first.cert.privateKey)).toContain(
        "BEGIN PRIVATE KEY",
      );

      // Unchanged props: nothing is re-issued.
      const again = yield* stack.deploy(program(NAMES));
      expect(again.cert.serial).toBe(first.cert.serial);
      expect(Redacted.value(again.cert.privateKey)).toBe(
        Redacted.value(first.cert.privateKey),
      );

      // Renewal is a diff decision against `notAfter`.
      const provider = yield* Provider.findProvider(ACME.Certificate);
      // `diff` sees resolved props: the account ref is its attributes.
      const props = {
        account: first.account,
        identifiers: NAMES,
        solver: env.solver,
        revokeOnDelete: true,
      } as unknown as ACME.CertificateProps;
      const diffAt = (notAfter: string) =>
        provider.diff!({
          id: "Wildcard",
          fqn: "Wildcard",
          instanceId: "instance",
          olds: props,
          news: props,
          oldBindings: [],
          newBindings: [],
          output: { ...first.cert, notAfter },
        });
      const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const far = new Date(Date.now() + 80 * 86_400_000).toISOString();
      expect(yield* diffAt(soon)).toEqual({ action: "update" });
      expect(yield* diffAt(far)).toEqual({ action: "noop" });

      // A shorter window re-issues on the next deploy.
      const renewed = yield* stack.deploy(
        program(NAMES, { renewBefore: "3650 days" }),
      );
      expect(renewed.cert.serial).not.toBe(first.cert.serial);
      expect(renewed.cert.identifiers).toEqual(NAMES);

      // Changing the names re-issues.
      const changed = yield* stack.deploy(program(["acme.example.test"]));
      expect(changed.cert.serial).not.toBe(renewed.cert.serial);
      expect(
        (yield* ACME.parseCertificate(changed.cert.certificate)).dnsNames,
      ).toEqual(["acme.example.test"]);

      // Delete revokes: a second revocation signed by the certificate key
      // is refused with the typed `alreadyRevoked`.
      yield* stack.destroy();
      const certificateKey = yield* ACME.privateKeyToJwk(
        changed.cert.privateKey,
      );
      const revokedAgain = yield* acme
        .revokeCertificate({
          certificate: Jose.base64url(ACME.fromPem(changed.cert.certificate)),
        })
        .pipe(
          Effect.provide(
            ACME.accountLayer({ ca: env.ca, accountKey: certificateKey }),
          ),
          Effect.result,
        );
      expect(Result.isFailure(revokedAgain)).toBe(true);
      if (Result.isFailure(revokedAgain)) {
        expect(revokedAgain.failure._tag).toBe("AcmeAlreadyRevoked");
      }
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!dockerAvailable)(
  "fails typed when no solver is registered for the descriptor",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* pebble;
      yield* stack.destroy();
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const account = yield* ACME.Account("Pebble", {
              ca: env.ca,
              termsOfServiceAgreed: true,
            });
            return yield* ACME.Certificate("Unsolvable", {
              account,
              identifiers: ["unsolvable.example.test"],
              solver: { type: "Nope.DNS" },
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).toContain("ACME.DnsSolverNotRegistered");
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
