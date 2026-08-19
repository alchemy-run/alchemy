import type {
  AppSecrets,
  SecretsListError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { App } from "./App.ts";

/**
 * List Fly.io App secrets. Scoped to an {@link App} — Fly's list API
 * is `GET /apps/{app}/secrets`, not a single Secret. The App is
 * fixed by `ListSecrets(app)`; calls take no `app_name`. Provide
 * {@link ListSecretsHttp} on the Action / Service Effect.
 *
 * Plaintext is only returned from inside a Machine in the same App.
 *
 * @binding
 *
 * @section Listing secrets
 * @example List secrets on an App
 * ```typescript
 * const list = yield* Fly.ListSecrets(Site);
 * const { secrets } = yield* list();
 * ```
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "Fly.ListSecrets",
  (
    app: App,
  ) => Effect.Effect<
    () => Effect.Effect<AppSecrets, SecretsListError, RuntimeContext>
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>("Fly.ListSecrets");
