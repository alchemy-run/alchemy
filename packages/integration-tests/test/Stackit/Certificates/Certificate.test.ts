import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CERT_A_PEM, CERT_B_PEM, KEY_A_PEM, KEY_B_PEM } from "./fixtures/certs.ts";

const { test } = makeStackitTest();

// Stored certificates have no SKU in price list v1.0.44: EUR 0 per run, so it runs ungated.
const options = { tags: stackitTags("certificates", "certificate"), timeout: 300_000 } as const;

/** Out-of-band state: the certificate, or "gone" (typed NotFound). */
const observe = (scope: { projectId: string; region: string }, id: string) =>
  certificates
    .getCertificate({ ...scope, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const pairA = { publicKey: CERT_A_PEM, privateKey: Redacted.make(KEY_A_PEM) };
const pairB = { publicKey: CERT_B_PEM, privateKey: Redacted.make(KEY_B_PEM) };

test.provider(
  "store and delete a certificate, with a no-op redeploy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const props = { ...pairA, labels: { env: "test" } };
      const created = yield* stack.deploy(Stackit.Certificates.Certificate("Tls", props));

      expect(created.certificateId.length).toBeGreaterThan(0);
      expect(created.certificateName).toMatch(/^[0-9a-z-]+$/);
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.labels).toEqual({ env: "test" });
      expect(created.data?.subjectCn).toEqual("stackit-certificates-fixture.alchemy.test");
      expect(created.data?.isSelfSigned).toEqual(true);
      // Attributes never carry the private key.
      expect(JSON.stringify(created)).not.toContain("PRIVATE KEY");

      // Out of band: the certificate exists with Alchemy's ownership labels.
      const fetched = yield* observe(scope, created.certificateId);
      expect(fetched).not.toEqual("gone");
      if (fetched !== "gone") {
        expect(fetched.name).toEqual(created.certificateName);
        expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "Tls" });
      }

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Certificates.Certificate("Tls", props));
      expect(plan.resources.Tls).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      expect(yield* observe(scope, created.certificateId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new pair or label replaces the certificate, new one first",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.Certificates.Certificate("Renewed", { ...pairA, labels: { env: "test" } }),
      );

      const plan = yield* stack.plan(
        Stackit.Certificates.Certificate("Renewed", { ...pairB, labels: { env: "test" } }),
      );
      expect(plan.resources.Renewed).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(
        Stackit.Certificates.Certificate("Renewed", { ...pairB, labels: { env: "test" } }),
      );
      expect(second.certificateId).not.toEqual(first.certificateId);
      expect(second.data?.subjectCn).toEqual("stackit-certificates-fixture-b.alchemy.test");
      expect(yield* observe(scope, first.certificateId)).toEqual("gone");

      const third = yield* stack.deploy(
        Stackit.Certificates.Certificate("Renewed", { ...pairB, labels: { env: "prod" } }),
      );
      expect(third.certificateId).not.toEqual(second.certificateId);
      expect(third.labels).toEqual({ env: "prod" });
      expect(yield* observe(scope, second.certificateId)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* observe(scope, third.certificateId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "an explicit name survives a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      yield* stack.destroy();

      const name = "alchemy-test-certificate";
      const first = yield* stack.deploy(
        Stackit.Certificates.Certificate("Named", { name, ...pairA }),
      );
      expect(first.certificateName).toEqual(name);

      const second = yield* stack.deploy(
        Stackit.Certificates.Certificate("Named", { name, ...pairB }),
      );
      expect(second.certificateName).toEqual(name);
      expect(second.certificateId).not.toEqual(first.certificateId);
      expect(yield* observe(scope, first.certificateId)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* observe(scope, second.certificateId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
