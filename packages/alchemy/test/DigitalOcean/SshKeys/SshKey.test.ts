import * as DigitalOcean from "@/DigitalOcean";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { sshKeysGet } from "@distilled.cloud/digitalocean/sshKeys";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DigitalOcean credentials resolve via the AuthProvider (env method reads
// DIGITALOCEAN_TOKEN / DIGITALOCEAN_ACCESS_TOKEN). Without a token the suite
// can't talk to the real API, so skipIf-gate the live tests.
const hasDigitalOceanCreds = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

// Out-of-band verification context: raw distilled calls, credentials from
// env — independent of the provider layer under test.
const outOfBand = Effect.provide(
  Layer.mergeAll(DigitalOcean.CredentialsFromEnv, FetchHttpClient.layer),
);

// Dedicated throwaway keypair generated for this suite — the public half is
// data, not a secret. Deterministic so re-runs reconcile the same key.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEM4cCPMnwhTuD9GA2uL3sgFjD6DqMnJW+iKNkPEPfHJ alchemy-test-fixture";
const KEY_NAME = "alchemy-test-ssh-key";
const RENAMED = "alchemy-test-ssh-key-renamed";

test.provider.skipIf(!hasDigitalOceanCreds)(
  "ssh key lifecycle: create, rename in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.SshKey("TestKey", {
            name: KEY_NAME,
            publicKey: PUBLIC_KEY,
          });
        }),
      );
      expect(created.name).toEqual(KEY_NAME);
      expect(created.publicKey).toEqual(PUBLIC_KEY);
      expect(created.fingerprint).toMatch(/^([0-9a-f]{2}:)+[0-9a-f]{2}$/);

      // Out-of-band: the key exists in the real account.
      const remote = yield* sshKeysGet({
        ssh_key_identifier: String(created.sshKeyId),
      }).pipe(outOfBand);
      expect(remote.ssh_key?.name).toEqual(KEY_NAME);

      // Same logical id, new name — diff classifies `name` as an in-place
      // update, so the physical key id must survive.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.SshKey("TestKey", {
            name: RENAMED,
            publicKey: PUBLIC_KEY,
          });
        }),
      );
      expect(renamed.sshKeyId).toEqual(created.sshKeyId);
      expect(renamed.name).toEqual(RENAMED);

      // list() hydrates the exact read/Attributes shape.
      const provider = yield* Provider.findProvider(DigitalOcean.SshKey);
      const all = yield* provider.list();
      expect(all.find((k) => k.sshKeyId === created.sshKeyId)?.name).toEqual(
        RENAMED,
      );

      yield* stack.destroy();

      // Typed wait-until-gone: the key must actually be deleted.
      const gone = yield* sshKeysGet({
        ssh_key_identifier: String(created.sshKeyId),
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
