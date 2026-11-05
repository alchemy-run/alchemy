import * as DigitalOcean from "@alchemy.run/digitalocean";
import { parseAuthorizedKey } from "@alchemy.run/digitalocean/internal/authorizedKey";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { SshKey, SshKeyMaterialChanged } from "@alchemy.run/digitalocean/SshKey";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createSshKey, deleteSshKey, getSshKey } from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { KeyPair } from "alchemy/KeyPair";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { forgetAttributes, isGone, logLevel, skipLive } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// Test-only keys. None of them is a secret. Constant values let a re-run
// find the same keys.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEM4cCPMnwhTuD9GA2uL3sgFjD6DqMnJW+iKNkPEPfHJ alchemy-test-fixture";
const PUBLIC_KEY_FINGERPRINT = "51:a8:37:e1:49:1f:46:1e:f6:4a:ae:fb:50:ee:4d:ec";
const RECOMMENTED_PUBLIC_KEY = PUBLIC_KEY.replace("alchemy-test-fixture", "laptop");
const PUBLIC_KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICWTCIoRFf5BedQK+A/oGtObZyAPlYSbZLMmeRiwZ2ev alchemy-test-fixture-2";
const PUBLIC_KEY_3 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILuAqbbgp5Yz/caY7cwcj0lbGODK+PAq47mq3nJC6VK2 alchemy-test-fixture-3";
const PUBLIC_KEY_4 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAV67tVaQb+YwtSBJhokmT/Z5Vs0B1RT+mqfJxLjOaav alchemy-test-fixture-4";
const PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGsBJaqkj3S2BLLVdjz63qz9QMJVQTrIiKNJZgC9eL7A\n-----END PRIVATE KEY-----\n";

const KEY_NAME = "alchemy-test-ssh-key";
const RENAMED_KEY_NAME = "alchemy-test-ssh-key-renamed";
const OTHER_KEY_NAME = "alchemy-test-ssh-key-other";
const FOREIGN_KEY_NAME = "alchemy-test-ssh-key-foreign";
const PAIR_KEY_NAME = "alchemy-test-ssh-key-pair";
const ROTATED_KEY_NAME = "alchemy-test-ssh-key-rotated";

const RSA_LINE =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDBMjcyOR7Gx9x6biAirxMZf2E6XqNUqyKHyBu9pI4J2PIfLShd2GK+fgR1frvbGT3f2X6Cec8PjaFRnSZpZ+ARn+L0AD/NYt0XZO2kBL77gpOSx01uWfpJVhUYeiCwMnmIH3Aa5lezseN/fwP/fPfdSKUa7HrTo31IA8ZBpfitMKeeD/v7ysS+0f7hadHogf5l5imKByKyno/tFRWMCX+vipim6xAD1aqB8B9KwJxqJF/eSrbWnDYKKZhZad/GiALiY5/ErTNr78HutjpBuskCYkDDI5sM4rWhQ50UooTqRkHn4NB+bGibI9d2rLlyAZfNs+20ZDiTKrQAbUaXZDWj";
const RSA_FINGERPRINT = "84:8c:9b:d6:2c:0c:ab:98:ba:1f:64:7a:f3:0d:10:48";

// PEM forms of test-only keys, with the `authorized_keys` line and MD5
// fingerprint that `ssh-keygen` reports for each.
const PEM_KEYS = [
  {
    format: "ed25519",
    pem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAjrvE5NhGpeM7CT8W3rF64OP+OwFnfEY4t4MZDAmrdU=\n-----END PUBLIC KEY-----\n",
    line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAI67xOTYRqXjOwk/Ft6xeuDj/jsBZ3xGOLeDGQwJq3V",
    fingerprint: "be:82:ee:4c:8c:16:ae:49:2a:2a:fd:3b:6b:72:80:06",
  },
  {
    format: "rsa",
    pem:
      "-----BEGIN PUBLIC KEY-----\n" +
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwTI3Mjkexsfcem4gIq8T\n" +
      "GX9hOl6jVKsih8gbvaSOCdjyHy0oXdhivn4EdX672xk939l+gnnPD42hUZ0maWfg\n" +
      "EZ/i9AA/zWLdF2TtpAS++4KTksdNbln6SVYVGHogsDJ5iB9wGuZXs7Hjf38D/3z3\n" +
      "3UilGux606N9SAPGQaX4rTCnng/7+8rEvtH+4WnR6IH+ZeYpigcisp6P7RUVjAl/\n" +
      "r4qYpusQA9WqgfAfSsCcaiRf3kq21pw2CimYWWnfxogC4mOfxK0za+/B7rY6QbrJ\n" +
      "AmJAwyObDOK1oUOdFKKE6kZB5+DQfmxomyPXdqy5cgGXzbPttGQ4kyq0AG1Gl2Q1\n" +
      "owIDAQAB\n" +
      "-----END PUBLIC KEY-----\n",
    line: RSA_LINE,
    fingerprint: RSA_FINGERPRINT,
  },
  {
    format: "rsa PKCS#1",
    pem:
      "-----BEGIN RSA PUBLIC KEY-----\n" +
      "MIIBCgKCAQEAwTI3Mjkexsfcem4gIq8TGX9hOl6jVKsih8gbvaSOCdjyHy0oXdhi\n" +
      "vn4EdX672xk939l+gnnPD42hUZ0maWfgEZ/i9AA/zWLdF2TtpAS++4KTksdNbln6\n" +
      "SVYVGHogsDJ5iB9wGuZXs7Hjf38D/3z33UilGux606N9SAPGQaX4rTCnng/7+8rE\n" +
      "vtH+4WnR6IH+ZeYpigcisp6P7RUVjAl/r4qYpusQA9WqgfAfSsCcaiRf3kq21pw2\n" +
      "CimYWWnfxogC4mOfxK0za+/B7rY6QbrJAmJAwyObDOK1oUOdFKKE6kZB5+DQfmxo\n" +
      "myPXdqy5cgGXzbPttGQ4kyq0AG1Gl2Q1owIDAQAB\n" +
      "-----END RSA PUBLIC KEY-----\n",
    line: RSA_LINE,
    fingerprint: RSA_FINGERPRINT,
  },
  {
    format: "ecdsa",
    pem:
      "-----BEGIN PUBLIC KEY-----\n" +
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKR7ubS+21Zn7nJW4TtjzdSTVf0ie\n" +
      "GF4rSVLCutfx4nkW/YhsA2sbaFqg7rGOiMVx2hvvK2RJGpuiADPt1J4thg==\n" +
      "-----END PUBLIC KEY-----\n",
    line: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBCke7m0vttWZ+5yVuE7Y83Uk1X9InhheK0lSwrrX8eJ5Fv2IbANrG2haoO6xjojFcdob7ytkSRqbogAz7dSeLYY=",
    fingerprint: "50:67:93:5f:bb:87:b3:12:ce:ba:ae:7c:f3:da:e6:05",
  },
] as const;

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:sshkey", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:sshkey", "live"];
const LIVE_TIMEOUT = 240_000;

const fingerprintOf = (publicKey: string) =>
  Option.map(parseAuthorizedKey(publicKey), (key) => key.fingerprint);

describe("parseAuthorizedKey", { tags: UNIT_TAGS }, () => {
  it("keeps an authorized_keys line, trimmed", () => {
    expect(parseAuthorizedKey(`  ${PUBLIC_KEY}\n`)).toEqual(
      Option.some({ line: PUBLIC_KEY, fingerprint: PUBLIC_KEY_FINGERPRINT }),
    );
  });

  it.each(PEM_KEYS)(
    "converts a PEM $format key to the line ssh-keygen produces",
    ({ pem, line, fingerprint }) => {
      expect(parseAuthorizedKey(pem)).toEqual(Option.some({ line, fingerprint }));
    },
  );

  it.each([
    { input: "a PEM private key", publicKey: PRIVATE_KEY_PEM },
    { input: "a line without key material", publicKey: "ssh-ed25519" },
    { input: "key material that is not base64", publicKey: "ssh-ed25519 not-base64!! note" },
  ])("rejects $input", ({ publicKey }) => {
    expect(parseAuthorizedKey(publicKey)).toEqual(Option.none());
  });

  it("keeps the fingerprint when only the comment changes", () => {
    expect(fingerprintOf(RECOMMENTED_PUBLIC_KEY)).toEqual(fingerprintOf(PUBLIC_KEY));
  });

  it("changes the fingerprint with the key material", () => {
    expect(fingerprintOf(PUBLIC_KEY_2)).not.toEqual(fingerprintOf(PUBLIC_KEY));
  });
});

const readSshKey = (sshKeyId: number) =>
  getSshKey({ ssh_key_identifier: String(sshKeyId) }).pipe(
    Effect.map((response) => response.ssh_key),
  );

const isSshKeyGone = (sshKeyId: number) => isGone(readSshKey(sshKeyId));

const keyFromPair = (pairId: string, keyId: string, name: string) =>
  Effect.gen(function* () {
    const pair = yield* KeyPair(pairId);
    const key = yield* SshKey(keyId, { name, publicKey: pair.publicKey });
    return { key, pairPublicKey: pair.publicKey };
  });

test.provider.skipIf(skipLive)(
  "ssh key lifecycle: create, rename and re-comment in place, refuse a foreign duplicate, replace on new material, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        SshKey("TestKey", { name: KEY_NAME, publicKey: PUBLIC_KEY }),
      );
      expect(created.name).toEqual(KEY_NAME);
      expect(created.publicKey).toEqual(PUBLIC_KEY);
      expect(created.fingerprint).toEqual(PUBLIC_KEY_FINGERPRINT);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(KEY_NAME);

      const renamedKey = SshKey("TestKey", {
        name: RENAMED_KEY_NAME,
        publicKey: RECOMMENTED_PUBLIC_KEY,
      });
      const renamed = yield* stack.deploy(renamedKey);
      expect(renamed.sshKeyId).toEqual(created.sshKeyId);
      expect(renamed.name).toEqual(RENAMED_KEY_NAME);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(RENAMED_KEY_NAME);

      // The same key under another name belongs to someone else.
      const refused = yield* stack
        .deploy(
          renamedKey.pipe(
            Effect.andThen(SshKey("OtherKey", { name: OTHER_KEY_NAME, publicKey: PUBLIC_KEY })),
          ),
        )
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(OwnedBySomeoneElse);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(RENAMED_KEY_NAME);

      const replaced = yield* stack.deploy(
        SshKey("TestKey", { name: RENAMED_KEY_NAME, publicKey: PUBLIC_KEY_2 }),
      );
      expect(replaced.sshKeyId).not.toEqual(created.sshKeyId);
      expect((yield* readSshKey(replaced.sshKeyId)).public_key).toEqual(PUBLIC_KEY_2);
      expect(yield* isSshKeyGone(created.sshKeyId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isSshKeyGone(replaced.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a key registered outside alchemy needs adopt(true), then takes the chosen name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* Effect.acquireUseRelease(
        createSshKey({ name: FOREIGN_KEY_NAME, public_key: PUBLIC_KEY_3 }).pipe(
          Effect.map((response) => response.ssh_key),
        ),
        (foreignKey) =>
          Effect.gen(function* () {
            const refused = yield* stack
              .deploy(SshKey("Adopted", { name: KEY_NAME, publicKey: PUBLIC_KEY_3 }))
              .pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);
            expect((yield* readSshKey(foreignKey.id)).name).toEqual(FOREIGN_KEY_NAME);

            const adopted = yield* stack.deploy(
              SshKey("Adopted", { name: KEY_NAME, publicKey: PUBLIC_KEY_3 }).pipe(adopt(true)),
            );
            expect(adopted.sshKeyId).toEqual(foreignKey.id);
            expect(adopted.name).toEqual(KEY_NAME);
            expect((yield* readSshKey(foreignKey.id)).name).toEqual(KEY_NAME);

            yield* stack.destroy();

            expect(yield* isSshKeyGone(foreignKey.id)).toBe(true);
          }),
        (foreignKey) => ignoreNotFound(deleteSshKey({ ssh_key_identifier: String(foreignKey.id) })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a KeyPair generated in the stack registers through PEM conversion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fromPair = keyFromPair("DeployPair", "PairKey", PAIR_KEY_NAME);

      const { key, pairPublicKey } = yield* stack.deploy(fromPair);
      expect(parseAuthorizedKey(pairPublicKey)).toEqual(
        Option.some({ line: key.publicKey, fingerprint: key.fingerprint }),
      );
      expect((yield* stack.plan(fromPair)).resources.PairKey).toMatchObject({ action: "noop" });

      yield* stack.destroy();

      expect(yield* isSshKeyGone(key.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "new material from an unresolved KeyPair fails the first deploy and replaces the key on the next",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(keyFromPair("FirstPair", "RotatedKey", ROTATED_KEY_NAME));

      // The first pair stays declared, so the replacement does not also
      // remove its old dependency.
      const rotated = KeyPair("FirstPair").pipe(
        Effect.andThen(keyFromPair("SecondPair", "RotatedKey", ROTATED_KEY_NAME)),
      );
      const failure = yield* stack.deploy(rotated).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SshKeyMaterialChanged);

      const second = yield* stack.deploy(rotated);
      expect(second.key.sshKeyId).not.toEqual(first.key.sshKeyId);
      expect(parseAuthorizedKey(second.pairPublicKey)).toEqual(
        Option.some({ line: second.key.publicKey, fingerprint: second.key.fingerprint }),
      );
      expect(yield* isSshKeyGone(first.key.sshKeyId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isSshKeyGone(second.key.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "destroy recovers a generated-name key without recorded attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(SshKey("Box", { publicKey: PUBLIC_KEY_4 }));
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });

      yield* stack.destroy();

      expect(yield* isSshKeyGone(created.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
