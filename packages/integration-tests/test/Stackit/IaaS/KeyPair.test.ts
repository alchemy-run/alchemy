import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT, PUBLIC_KEY_1, PUBLIC_KEY_2 } from "./compute.ts";

const { test } = makeStackitTest();

// Key pairs are free and user-scoped (no project, no region): ungated.
const options = { tags: stackitTags("iaas", "keypair"), timeout: 180_000 } as const;

const presence = (keypairName: string) =>
  iaas.getKeyPair({ keypairName }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

test.provider(
  "create, relabel, replace on a new key, and delete a key pair",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.KeyPair("Key", { publicKey: PUBLIC_KEY_1, labels: { env: "test" } }),
      );
      expect(created.name).toEqual(expect.stringMatching(/^[a-z0-9@._-]+$/));
      expect(created.publicKey).toContain("AAAAIG8xNYM2E5N5");
      expect(created.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getKeyPair({ keypairName: created.name });
      expect(fetched.publicKey).toContain("AAAAIG8xNYM2E5N5");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        "alchemy.id": "Key",
        env: "test",
      });

      // Labels update in place, keeping the key pair.
      const relabeled = yield* stack.deploy(
        Stackit.IaaS.KeyPair("Key", { publicKey: PUBLIC_KEY_1, labels: { env: "prod" } }),
      );
      expect(relabeled.name).toEqual(created.name);
      const refetched = yield* iaas.getKeyPair({ keypairName: created.name });
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A different key replaces the key pair under a new generated name.
      const replaced = yield* stack.deploy(
        Stackit.IaaS.KeyPair("Key", { publicKey: PUBLIC_KEY_2, labels: { env: "prod" } }),
      );
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.publicKey).toContain("AAAAIHyIWWlb");
      yield* expectGone(presence(created.name));
      const fresh = yield* iaas.getKeyPair({ keypairName: replaced.name });
      expect(fresh.publicKey).toContain("AAAAIHyIWWlb");

      yield* stack.destroy();
      yield* expectGone(presence(replaced.name));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new key under an explicit name replaces the key pair in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-test-keypair-explicit";

      const created = yield* stack.deploy(
        Stackit.IaaS.KeyPair("Named", { name, publicKey: PUBLIC_KEY_1 }),
      );
      expect(created.name).toEqual(name);

      // Same name, different key: delete-first replacement.
      const replaced = yield* stack.deploy(
        Stackit.IaaS.KeyPair("Named", { name, publicKey: PUBLIC_KEY_2 }),
      );
      expect(replaced.name).toEqual(name);
      const fetched = yield* iaas.getKeyPair({ keypairName: name });
      expect(fetched.publicKey).toContain("AAAAIHyIWWlb");

      yield* stack.destroy();
      yield* expectGone(presence(name));
    }).pipe(logLevel),
  options,
);
