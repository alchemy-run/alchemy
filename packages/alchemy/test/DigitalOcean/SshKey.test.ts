import { createSshKey, deleteSshKey, getSshKey } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import { diffSshKey, SshKey } from "@/DigitalOcean/SshKey";
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

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:sshkey", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:sshkey", "live"];
const LIVE_TIMEOUT = 180_000;

describe("diffSshKey", { tags: UNIT_TAGS }, () => {
  const olds = { name: KEY_NAME, publicKey: PUBLIC_KEY };

  it("ignores surrounding whitespace in publicKey", () => {
    expect(diffSshKey({ ...olds, publicKey: `${PUBLIC_KEY}\n` }, olds)).toBe(undefined);
  });

  it("ignores a changed comment", () => {
    const recommented = PUBLIC_KEY.replace("alchemy-test-fixture", "laptop");
    expect(diffSshKey({ ...olds, publicKey: recommented }, olds)).toBe(undefined);
  });

  it("leaves a rename to the engine's update", () => {
    expect(diffSshKey({ ...olds, name: RENAMED_KEY_NAME }, olds)).toBe(undefined);
  });

  it("replaces on new key material", () => {
    expect(diffSshKey({ ...olds, publicKey: PUBLIC_KEY_2 }, olds)).toEqual({
      action: "replace",
    });
  });
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

      const foreign = yield* createSshKey({
        name: FOREIGN_KEY_NAME,
        public_key: PUBLIC_KEY_3,
      }).pipe(Effect.map((response) => response.ssh_key));
      yield* Effect.addFinalizer(() => deleteSshKeyIfExists(foreign.id).pipe(Effect.orDie));

      const refused = yield* stack
        .deploy(SshKey("Adopted", { name: KEY_NAME, publicKey: PUBLIC_KEY_3 }))
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(OwnedBySomeoneElse);
      expect((yield* readSshKey(foreign.id)).name).toEqual(FOREIGN_KEY_NAME);

      const adopted = yield* stack.deploy(
        SshKey("Adopted", { name: KEY_NAME, publicKey: PUBLIC_KEY_3 }).pipe(adopt(true)),
      );
      expect(adopted.sshKeyId).toEqual(foreign.id);
      expect(adopted.name).toEqual(KEY_NAME);
      expect((yield* readSshKey(foreign.id)).name).toEqual(KEY_NAME);

      yield* stack.destroy();

      expect(yield* isSshKeyGone(foreign.id)).toBe(true);
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
