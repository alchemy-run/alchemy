import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { App, AppProvider } from "./App.ts";
import { FlyAuth } from "./AuthProvider.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import * as Credentials from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import { IpAssignment, IpAssignmentProvider } from "./IpAssignment.ts";
import { Machine, MachineProvider } from "./Machine.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { ReadSecretHttp } from "./ReadSecretHttp.ts";
import { ReadWriteSecretHttp } from "./ReadWriteSecretHttp.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { SecretKey, SecretKeyProvider } from "./SecretKey.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeSnapshot, VolumeSnapshotProvider } from "./VolumeSnapshot.ts";
import { WriteSecretHttp } from "./WriteSecretHttp.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Fly",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers Fly resource providers, the Fly
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land. The collection starts empty so App / Machine / Service agents can
 * make a single minimal insertion.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Fly.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      App,
      Certificate,
      IpAssignment,
      Machine,
      Secret,
      SecretKey,
      Service,
      Volume,
      VolumeSnapshot,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        CertificateProvider(),
        IpAssignmentProvider(),
        MachineProvider(),
        SecretProvider(),
        SecretKeyProvider(),
        ServiceProvider(),
        VolumeProvider(),
        VolumeSnapshotProvider(),
      ),
    ),
    Layer.provideMerge(MountVolumeLive),
    Layer.provideMerge(ReadSecretHttp),
    Layer.provideMerge(WriteSecretHttp),
    Layer.provideMerge(ReadWriteSecretHttp),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FlyAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
