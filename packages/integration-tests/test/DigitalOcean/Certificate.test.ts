import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getCertificate } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { CERTIFICATE_ONE, CERTIFICATE_TWO } from "./fixtures/certificates.ts";
import { forgetAttributes, isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:certificate", "live"];
const LIVE_TIMEOUT = 180_000;

const isCertificateGone = (certificateId: string) =>
  isGone(getCertificate({ certificate_id: certificateId }));

test.provider(
  "custom certificate: upload, replace create-first on new material, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const uploaded = yield* stack.deploy(
        DigitalOcean.Certificate("Cert", { type: "custom", ...CERTIFICATE_ONE }),
      );
      expect(uploaded).toMatchObject({ type: "custom", state: "verified" });
      expect(uploaded.dnsNames).toEqual(["alchemy-one.example.com"]);
      expect(uploaded.sha1Fingerprint).toMatch(/^[0-9a-f]{40}$/);

      const planned = yield* stack.plan(
        DigitalOcean.Certificate("Cert", { type: "custom", ...CERTIFICATE_TWO }),
      );
      expect(planned.resources.Cert).toMatchObject({ action: "replace", deleteFirst: false });

      const replaced = yield* stack.deploy(
        DigitalOcean.Certificate("Cert", { type: "custom", ...CERTIFICATE_TWO }),
      );
      expect(replaced.certificateId).not.toEqual(uploaded.certificateId);
      expect(replaced.dnsNames).toEqual(["alchemy-two.example.com"]);
      expect(yield* isCertificateGone(uploaded.certificateId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isCertificateGone(replaced.certificateId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a certificate with a chosen name is deleted before its replacement takes the name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "certificate");

      const first = yield* stack.deploy(
        DigitalOcean.Certificate("Named", { name, type: "custom", ...CERTIFICATE_ONE }),
      );
      expect(first.name).toEqual(name);

      const second = yield* stack.deploy(
        DigitalOcean.Certificate("Named", { name, type: "custom", ...CERTIFICATE_TWO }),
      );
      expect(second.certificateId).not.toEqual(first.certificateId);
      expect(second.name).toEqual(name);
      expect(yield* isCertificateGone(first.certificateId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isCertificateGone(second.certificateId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a generated-name certificate whose attributes were lost is found by its name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const declared = DigitalOcean.Certificate("Box", { type: "custom", ...CERTIFICATE_ONE });

      const created = yield* stack.deploy(declared);
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });
      expect((yield* stack.deploy(declared)).certificateId).toEqual(created.certificateId);

      yield* stack.destroy();

      expect(yield* isCertificateGone(created.certificateId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
