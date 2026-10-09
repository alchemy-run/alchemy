import { createSshKey, deleteSshKey, getSshKey } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import { authorizedKey, diffSshKey, fingerprintOf, SshKey } from "@/DigitalOcean/SshKey";
import { KeyPair } from "@/KeyPair";
import * as Test from "@/Test/Alchemy";
import { forgetAttributes, isGone, logLevel, skipLive } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// Test-only key pairs. The public halves are not secrets. Constant values
// let a re-run find the same keys.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEM4cCPMnwhTuD9GA2uL3sgFjD6DqMnJW+iKNkPEPfHJ alchemy-test-fixture";
const PUBLIC_KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICWTCIoRFf5BedQK+A/oGtObZyAPlYSbZLMmeRiwZ2ev alchemy-test-fixture-2";
const PUBLIC_KEY_3 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILuAqbbgp5Yz/caY7cwcj0lbGODK+PAq47mq3nJC6VK2 alchemy-test-fixture-3";
const KEY_NAME = "alchemy-test-ssh-key";
const RENAMED_KEY_NAME = "alchemy-test-ssh-key-renamed";
const OTHER_KEY_NAME = "alchemy-test-ssh-key-other";
const FOREIGN_KEY_NAME = "alchemy-test-ssh-key-foreign";
const PAIR_KEY_NAME = "alchemy-test-ssh-key-pair";

// PEM forms of test-only keys, with the `authorized_keys` line and MD5
// fingerprint that `ssh-keygen` reports for each.
const PEM_KEYS = [
  {
    algorithm: "ed25519",
    pem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAjrvE5NhGpeM7CT8W3rF64OP+OwFnfEY4t4MZDAmrdU=\n-----END PUBLIC KEY-----\n",
    line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAI67xOTYRqXjOwk/Ft6xeuDj/jsBZ3xGOLeDGQwJq3V",
    fingerprint: "be:82:ee:4c:8c:16:ae:49:2a:2a:fd:3b:6b:72:80:06",
  },
  {
    algorithm: "rsa",
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
    line: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDBMjcyOR7Gx9x6biAirxMZf2E6XqNUqyKHyBu9pI4J2PIfLShd2GK+fgR1frvbGT3f2X6Cec8PjaFRnSZpZ+ARn+L0AD/NYt0XZO2kBL77gpOSx01uWfpJVhUYeiCwMnmIH3Aa5lezseN/fwP/fPfdSKUa7HrTo31IA8ZBpfitMKeeD/v7ysS+0f7hadHogf5l5imKByKyno/tFRWMCX+vipim6xAD1aqB8B9KwJxqJF/eSrbWnDYKKZhZad/GiALiY5/ErTNr78HutjpBuskCYkDDI5sM4rWhQ50UooTqRkHn4NB+bGibI9d2rLlyAZfNs+20ZDiTKrQAbUaXZDWj",
    fingerprint: "84:8c:9b:d6:2c:0c:ab:98:ba:1f:64:7a:f3:0d:10:48",
  },
  {
    algorithm: "ecdsa",
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
const LIVE_TIMEOUT = 180_000;

describe("authorizedKey", { tags: UNIT_TAGS }, () => {
  it.effect("keeps an authorized_keys line, trimmed", () =>
    Effect.gen(function* () {
      const key = yield* authorizedKey(`  ${PUBLIC_KEY}\n`);
      expect(key.line).toEqual(PUBLIC_KEY);
      expect(key.material).toEqual(PUBLIC_KEY.split(" ")[1]);
    }),
  );

  for (const fixture of PEM_KEYS) {
    it.effect(`converts a PEM ${fixture.algorithm} key to the line ssh-keygen produces`, () =>
      Effect.gen(function* () {
        const key = yield* authorizedKey(fixture.pem);
        expect(key.line).toEqual(fixture.line);
        expect(yield* fingerprintOf(key)).toEqual(fixture.fingerprint);
      }),
    );
  }

  it.effect("fails on a PEM private key", () =>
    Effect.gen(function* () {
      const error = yield* authorizedKey(
        "-----BEGIN PRIVATE KEY-----\nMC4C\n-----END PRIVATE KEY-----",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("DigitalOcean.SshKeyUnparseable");
    }),
  );

  it.effect("fails on a line without key material", () =>
    Effect.gen(function* () {
      const error = yield* authorizedKey("ssh-ed25519").pipe(Effect.flip);
      expect(error._tag).toEqual("DigitalOcean.SshKeyUnparseable");
    }),
  );
});

describe("diffSshKey", { tags: UNIT_TAGS }, () => {
  const olds = { name: KEY_NAME, publicKey: PUBLIC_KEY };
  const diff = (news: Partial<typeof olds>) => diffSshKey({ olds, news: { ...olds, ...news } });

  it.effect("ignores surrounding whitespace in publicKey", () =>
    Effect.gen(function* () {
      expect(yield* diff({ publicKey: `${PUBLIC_KEY}\n` })).toBe(undefined);
    }),
  );

  it.effect("ignores a changed comment", () =>
    Effect.gen(function* () {
      const recommented = PUBLIC_KEY.replace("alchemy-test-fixture", "laptop");
      expect(yield* diff({ publicKey: recommented })).toBe(undefined);
    }),
  );

  it.effect("ignores a change of format for the same material", () =>
    Effect.gen(function* () {
      const [ed25519] = PEM_KEYS;
      const sameMaterial = yield* diffSshKey({
        olds: { ...olds, publicKey: ed25519.line },
        news: { ...olds, publicKey: ed25519.pem },
      });
      expect(sameMaterial).toBe(undefined);
    }),
  );

  it.effect("leaves a rename to the engine's update", () =>
    Effect.gen(function* () {
      expect(yield* diff({ name: RENAMED_KEY_NAME })).toBe(undefined);
    }),
  );

  it.effect("replaces on new key material", () =>
    Effect.gen(function* () {
      expect(yield* diff({ publicKey: PUBLIC_KEY_2 })).toEqual({ action: "replace" });
    }),
  );
});

const readSshKey = (sshKeyId: number) =>
  getSshKey({ ssh_key_identifier: String(sshKeyId) }).pipe(
    Effect.map((response) => response.ssh_key),
  );

const isSshKeyGone = (sshKeyId: number) =>
  isGone(getSshKey({ ssh_key_identifier: String(sshKeyId) }));

const deleteSshKeyIfExists = (sshKeyId: number) =>
  deleteSshKey({ ssh_key_identifier: String(sshKeyId) }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
  );

test.provider.skipIf(skipLive)(
  "ssh key lifecycle: create, rename in place, refuse a foreign duplicate, replace on new material, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        SshKey("TestKey", { name: KEY_NAME, publicKey: PUBLIC_KEY }),
      );
      expect(created.name).toEqual(KEY_NAME);
      expect(created.publicKey).toEqual(PUBLIC_KEY);
      expect(created.fingerprint).toMatch(/^([0-9a-f]{2}:)+[0-9a-f]{2}$/);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(KEY_NAME);

      const renamed = yield* stack.deploy(
        SshKey("TestKey", { name: RENAMED_KEY_NAME, publicKey: PUBLIC_KEY }),
      );
      expect(renamed.sshKeyId).toEqual(created.sshKeyId);
      expect(renamed.name).toEqual(RENAMED_KEY_NAME);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(RENAMED_KEY_NAME);

      // The same key under another name belongs to someone else. The deploy
      // must fail and must not rename the key.
      const refused = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* SshKey("TestKey", { name: RENAMED_KEY_NAME, publicKey: PUBLIC_KEY });
            return yield* SshKey("OtherKey", { name: OTHER_KEY_NAME, publicKey: PUBLIC_KEY });
          }),
        )
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(OwnedBySomeoneElse);
      expect((yield* readSshKey(created.sshKeyId)).name).toEqual(RENAMED_KEY_NAME);

      const replaced = yield* stack.deploy(
        SshKey("TestKey", { name: RENAMED_KEY_NAME, publicKey: PUBLIC_KEY_2 }),
      );
      expect(replaced.sshKeyId).not.toEqual(created.sshKeyId);
      expect(replaced.publicKey).toEqual(PUBLIC_KEY_2);
      expect((yield* readSshKey(replaced.sshKeyId)).fingerprint).toEqual(replaced.fingerprint);
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

      const foreignKey = yield* createSshKey({
        name: FOREIGN_KEY_NAME,
        public_key: PUBLIC_KEY_3,
      }).pipe(Effect.map((response) => response.ssh_key));
      yield* Effect.addFinalizer(() => deleteSshKeyIfExists(foreignKey.id).pipe(Effect.orDie));

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
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a KeyPair generated in the stack registers through PEM conversion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fromPair = Effect.gen(function* () {
        const pair = yield* KeyPair("DeployPair");
        return yield* SshKey("PairKey", { name: PAIR_KEY_NAME, publicKey: pair.publicKey });
      });

      const registered = yield* stack.deploy(fromPair);
      expect(registered.publicKey).toMatch(/^ssh-ed25519 /);
      expect((yield* readSshKey(registered.sshKeyId)).fingerprint).toEqual(registered.fingerprint);

      const unchanged = yield* stack.deploy(fromPair);
      expect(unchanged.sshKeyId).toEqual(registered.sshKeyId);

      yield* stack.destroy();

      expect(yield* isSshKeyGone(registered.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "destroy recovers a generated-name key without recorded attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(SshKey("Box", { publicKey: PUBLIC_KEY_2 }));
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });

      yield* stack.destroy();

      expect(yield* isSshKeyGone(created.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
