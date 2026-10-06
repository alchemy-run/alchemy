import { getSshKey } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import { diffSshKey, SshKey } from "@/DigitalOcean/SshKeys/SshKey";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { isGone, logLevel, outOfBand, skipLive } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// Test-only key pairs. The public halves are not secrets. Constant values
// let a re-run find the same keys.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEM4cCPMnwhTuD9GA2uL3sgFjD6DqMnJW+iKNkPEPfHJ alchemy-test-fixture";
const PUBLIC_KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICWTCIoRFf5BedQK+A/oGtObZyAPlYSbZLMmeRiwZ2ev alchemy-test-fixture-2";
const KEY_NAME = "alchemy-test-ssh-key";
const RENAMED_KEY_NAME = "alchemy-test-ssh-key-renamed";
const OTHER_KEY_NAME = "alchemy-test-ssh-key-other";

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:sshkey", "local"];

describe("diffSshKey", { tags: UNIT_TAGS }, () => {
  const olds = { name: KEY_NAME, publicKey: PUBLIC_KEY };

  it("ignores surrounding whitespace in publicKey", () => {
    expect(diffSshKey({ ...olds, publicKey: `${PUBLIC_KEY}\n` }, olds)).toBe(undefined);
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
  getSshKey({ ssh_key_identifier: String(sshKeyId) }).pipe(outOfBand);

const isSshKeyGone = (sshKeyId: number) =>
  isGone(getSshKey({ ssh_key_identifier: String(sshKeyId) }));

test.provider.skipIf(skipLive)(
  "ssh key lifecycle: create, rename in place, refuse a foreign duplicate, replace on new material, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SshKey("TestKey", {
            name: KEY_NAME,
            publicKey: PUBLIC_KEY,
          });
        }),
      );
      expect(created.name).toEqual(KEY_NAME);
      expect(created.publicKey).toEqual(PUBLIC_KEY);
      expect(created.fingerprint).toMatch(/^([0-9a-f]{2}:)+[0-9a-f]{2}$/);

      const remote = yield* readSshKey(created.sshKeyId);
      expect(remote.ssh_key.name).toEqual(KEY_NAME);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SshKey("TestKey", {
            name: RENAMED_KEY_NAME,
            publicKey: PUBLIC_KEY,
          });
        }),
      );
      expect(renamed.sshKeyId).toEqual(created.sshKeyId);
      expect(renamed.name).toEqual(RENAMED_KEY_NAME);

      const provider = yield* Provider.findProvider(SshKey);
      const all = yield* provider.list();
      expect(all.find((key) => key.sshKeyId === created.sshKeyId)?.name).toEqual(RENAMED_KEY_NAME);

      // The same key under another name belongs to someone else. The deploy
      // must fail and must not rename the key.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* SshKey("TestKey", {
              name: RENAMED_KEY_NAME,
              publicKey: PUBLIC_KEY,
            });
            return yield* SshKey("OtherKey", {
              name: OTHER_KEY_NAME,
              publicKey: PUBLIC_KEY,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);
      const untouched = yield* readSshKey(created.sshKeyId);
      expect(untouched.ssh_key.name).toEqual(RENAMED_KEY_NAME);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SshKey("TestKey", {
            name: RENAMED_KEY_NAME,
            publicKey: PUBLIC_KEY_2,
          });
        }),
      );
      expect(replaced.sshKeyId).not.toEqual(created.sshKeyId);
      expect(replaced.publicKey).toEqual(PUBLIC_KEY_2);
      expect(yield* isSshKeyGone(created.sshKeyId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isSshKeyGone(replaced.sshKeyId)).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:sshkey", "live"],
    timeout: 180_000,
  },
);
