import { toBinding } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import type { Secret } from "@/Cloudflare/SecretsStore/Secret.ts";
import { expect, it } from "@effect/vitest";

/**
 * A `Cloudflare.SecretsStore.Secret` passed through a Worker's `env` must
 * map to a `secrets_store_secret` binding. Before the fix it fell through
 * the `toBinding` chain to the catch-all `json` branch, so the secret was
 * never wired up as a real binding.
 */
it("maps a SecretsStore Secret env binding to secrets_store_secret", () => {
  // The mapping only reads `Type`, `secretName` and `storeId`, so a minimal
  // stub stands in for a fully-provisioned resource.
  const secret = {
    Type: "Cloudflare.SecretsStore.Secret",
    secretName: "API_KEY",
    storeId: "store-123",
  } as unknown as Secret;

  const binding = toBinding("MY_SECRET", secret);

  expect(binding).toEqual({
    type: "secrets_store_secret",
    name: "MY_SECRET",
    secretName: "API_KEY",
    storeId: "store-123",
  });
});

it("does not fall through to the json catch-all for a Secret", () => {
  const secret = {
    Type: "Cloudflare.SecretsStore.Secret",
    secretName: "API_KEY",
    storeId: "store-123",
  } as unknown as Secret;

  const binding = toBinding("MY_SECRET", secret);

  expect((binding as { type: string }).type).not.toBe("json");
});
