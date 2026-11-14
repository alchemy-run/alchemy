import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as persistent from "@distilled.cloud/modal/persistent";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

// Persistent sandboxes are a Modal beta. A workspace outside it gets
// `PersistentSandboxesNotAvailable` (PERMISSION_DENIED, "Persistent Sandboxes
// are not available for this workspace yet"); set MODAL_TEST_PERSISTENT_SANDBOX=1
// on a workspace in the beta to run the lifecycle instead.
const entitled = !!process.env.MODAL_TEST_PERSISTENT_SANDBOX;

const deployBox = (workdir: string) =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("PersistentEnv", {});
    const target = yield* Modal.App("PersistentApp", { environment });
    return yield* Modal.PersistentSandbox("Box", {
      app: target,
      image: "debian:bookworm-slim",
      workdir,
    });
  });

test.provider.skipIf(entitled)(
  "a workspace outside the beta gets PersistentSandboxesNotAvailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Modal.App("PersistentProbeApp", {}));
      const error = yield* persistent
        .createPersistentSandbox({ appId: app.appId, definition: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PersistentSandboxesNotAvailable");
      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:sandbox", "live"], timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "create a persistent sandbox, replace it on change, and terminate it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const box = yield* stack.deploy(deployBox("/root"));
      const found = yield* persistent.getPersistentSandbox({
        persistentSandboxId: box.persistentSandboxId,
      });
      expect(found.persistentSandboxId).toBe(box.persistentSandboxId);

      // Unchanged props keep the box.
      const same = yield* stack.deploy(deployBox("/root"));
      expect(same.persistentSandboxId).toBe(box.persistentSandboxId);

      // A new definition is a new box.
      const replaced = yield* stack.deploy(deployBox("/tmp"));
      expect(replaced.persistentSandboxId).not.toBe(box.persistentSandboxId);

      yield* stack.destroy();
      const after = yield* persistent
        .getPersistentSandbox({ persistentSandboxId: replaced.persistentSandboxId })
        .pipe(Effect.catchTag("PersistentSandboxNotFound", () => Effect.succeed(undefined)));
      expect(after?.sandboxId ?? "").toBe("");
    }),
  { tags: ["provider:modal", "provider:modal:sandbox", "live"], timeout: 600_000 },
);
