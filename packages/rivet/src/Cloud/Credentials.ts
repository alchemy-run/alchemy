import type { CredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RivetCloudCredentials } from "./AuthProvider.ts";

/**
 * Rivet Cloud credentials, resolved on first use from the `RivetCloud`
 * profile or from `RIVET_CLOUD_TOKEN` and `RIVET_CLOUD_CLUSTER`.
 * `Rivet.providers()` provides it; nothing resolves it unless a
 * `RivetCloud.ControlPlane` is deployed.
 */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<RivetCloudCredentials, CredentialsUnavailable>
>()("RivetCloud.Credentials") {}
