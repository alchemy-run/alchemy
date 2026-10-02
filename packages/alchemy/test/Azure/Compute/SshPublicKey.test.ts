import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  logLevel,
  PUBLIC_KEY_1,
  PUBLIC_KEY_2,
  subscriptionId,
  tags,
  untilGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getKey = (resourceGroupName: string, sshPublicKeyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetSshPublicKey({
      subscriptionId,
      resourceGroupName,
      sshPublicKeyName,
    }),
  );

// SSH public key resources are free.
const program = (props: { publicKey: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const key = yield* Azure.Compute.SshPublicKey("Admin", {
      resourceGroup: group.resourceGroupName,
      publicKey: props.publicKey,
      tags: props.tags,
    });
    const generated = yield* Azure.Compute.SshPublicKey("Generated", {
      resourceGroup: group.resourceGroupName,
      generateKeyPair: true,
    });
    return { group, key, generated };
  });

test.provider(
  "create, rotate, and delete SSH public keys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, key, generated } = yield* stack.deploy(
        program({ publicKey: PUBLIC_KEY_1, tags: { env: "test" } }),
      );
      expect(key.publicKey?.split(" ")[1]).toEqual(PUBLIC_KEY_1.split(" ")[1]);
      expect(key.privateKey).toBeUndefined();
      expect(generated.publicKey).toMatch(/^ssh-rsa /);
      expect(generated.privateKey).toBeDefined();
      expect(Redacted.value(generated.privateKey!)).toContain("PRIVATE KEY");
      const observed = yield* getKey(
        group.resourceGroupName,
        key.sshPublicKeyName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Admin");

      // In place: rotate the key and change tags. The generated private key
      // survives later deploys.
      const updated = yield* stack.deploy(
        program({ publicKey: PUBLIC_KEY_2, tags: { env: "prod" } }),
      );
      expect(updated.key.sshPublicKeyId).toEqual(key.sshPublicKeyId);
      const reobserved = yield* getKey(
        group.resourceGroupName,
        key.sshPublicKeyName,
      );
      expect(reobserved.properties?.publicKey?.split(" ")[1]).toEqual(
        PUBLIC_KEY_2.split(" ")[1],
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(updated.generated.publicKey).toEqual(generated.publicKey);
      expect(updated.generated.privateKey).toBeDefined();

      yield* stack.destroy();
      expect(
        yield* untilGone(getKey(group.resourceGroupName, key.sshPublicKeyName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
