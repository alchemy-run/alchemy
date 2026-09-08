import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import { CertRequest, CertRequestProvider } from "../CertRequest.ts";
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { DigitalOceanAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Droplet, DropletProvider } from "./Droplets/Droplet.ts";
import { Firewall, FirewallProvider } from "./Firewalls/Firewall.ts";
import { SshKey, SshKeyProvider } from "./SshKeys/SshKey.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "DigitalOcean",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all DigitalOcean resource providers, the
 * DigitalOcean `AuthProvider`, the resolved `Credentials`, and an
 * `HttpClient`. Include this from your stack alongside other cloud
 * `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as DigitalOcean from "alchemy/DigitalOcean";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: DigitalOcean.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const host = yield* DigitalOcean.Droplet("app", {
 *       region: "sfo3",
 *       size: "s-2vcpu-4gb",
 *       image: "ubuntu-24-04-x64",
 *     });
 *     return { ip: host.ipv4 };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([CertRequest, KeyPair, Droplet, Firewall, SshKey]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        CertRequestProvider(),
        KeyPairProvider(),
        DropletProvider(),
        FirewallProvider(),
        SshKeyProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(DigitalOceanAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
