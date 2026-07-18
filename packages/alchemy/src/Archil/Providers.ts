import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ApiToken, ApiTokenProvider } from "./ApiToken.ts";
import { ArchilAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Disk, DiskProvider } from "./Disk.ts";
import { DiskUser, DiskUserProvider } from "./DiskUser.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Archil",
) {}

/**
 * Build a layer that registers all Archil resource providers, the Archil
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Archil from "alchemy/Archil";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const disk = yield* Archil.Disk("scratch");
 *     return { diskId: disk.diskId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Disk, DiskUser, ApiToken])).pipe(
    Layer.provide(
      Layer.mergeAll(DiskProvider(), DiskUserProvider(), ApiTokenProvider()),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(ArchilAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
