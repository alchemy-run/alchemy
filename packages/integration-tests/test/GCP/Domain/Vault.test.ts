import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { caseNames, type CaseResults } from "../../Domain/vault/cases.ts";
import { expectProbe } from "../bindingHost.ts";
import DomainVaultHost from "./fixtures/vault-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DomainVault");

let baseUrl: string;

const passed = Object.fromEntries(caseNames.map((name) => [name, true]));

/**
 * Run a pairing's cases. The host's grants on a fresh database and key take
 * a while to apply, and until then a case reports the refusal: run again
 * while any case was refused.
 */
const cases = (probe: string) =>
  Effect.suspend(() => expectProbe<CaseResults>(baseUrl, probe)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (results) =>
        !Object.values(results).some(
          (result) => typeof result === "string" && /forbidden|permission/i.test(result),
        ),
      times: 18,
    }),
  );

// A Vault's keys on Google Cloud: kept in Firestore, wrapped under Cloud KMS or a root key of your own.
describe(
  "Domain Vault on GCP",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:firestore",
      "provider:gcp:kms",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* DomainVaultHost;
            return { uri: host.uri };
          }),
        );
        baseUrl = out.uri!;
      }),
      { timeout: 900_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    test(
      "keys in Firestore, wrapped under a Cloud KMS key",
      Effect.gen(function* () {
        expect(yield* cases("firestoreKms")).toEqual(passed);
      }),
      { timeout: 300_000 },
    );
    test(
      "keys in Firestore, wrapped under a root key",
      Effect.gen(function* () {
        expect(yield* cases("firestoreRoot")).toEqual(passed);
      }),
      { timeout: 300_000 },
    );
  },
);
