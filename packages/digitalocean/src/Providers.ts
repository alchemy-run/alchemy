import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { KeyPair, KeyPairProvider } from "alchemy/KeyPair";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { DigitalOceanAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import { DomainRecord, DomainRecordProvider } from "./DomainRecord.ts";
import { Droplet, DropletProvider } from "./Droplet.ts";
import { Firewall, FirewallProvider } from "./Firewall.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectResources, ProjectResourcesProvider } from "./ProjectResources.ts";
import { ReservedIp, ReservedIpProvider } from "./ReservedIp.ts";
import { ReservedIpAssignment, ReservedIpAssignmentProvider } from "./ReservedIpAssignment.ts";
import { SshKey, SshKeyProvider } from "./SshKey.ts";
import { Tag, TagProvider } from "./Tag.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeAttachment, VolumeAttachmentProvider } from "./VolumeAttachment.ts";
import { Vpc, VpcProvider } from "./Vpc.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("DigitalOcean") {}

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
 * import * as DigitalOcean from "@alchemy.run/digitalocean";
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
    Provider.collection([
      Droplet,
      Firewall,
      SshKey,
      Volume,
      VolumeAttachment,
      Vpc,
      ReservedIp,
      ReservedIpAssignment,
      Domain,
      DomainRecord,
      Project,
      ProjectResources,
      Tag,
      KeyPair,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DropletProvider(),
        FirewallProvider(),
        SshKeyProvider(),
        VolumeProvider(),
        VolumeAttachmentProvider(),
        VpcProvider(),
        ReservedIpProvider(),
        ReservedIpAssignmentProvider(),
        DomainProvider(),
        DomainRecordProvider(),
        ProjectProvider(),
        ProjectResourcesProvider(),
        TagProvider(),
        KeyPairProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(DigitalOceanAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
