import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { App, AppProvider } from "./App.ts";
import { FlyAuth } from "./AuthProvider.ts";
import { AttachBucketLive, Bucket, BucketProvider } from "./Bucket.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { CheckpointHttp } from "./CheckpointHttp.ts";
import * as Credentials from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import { IpAssignment, IpAssignmentProvider } from "./IpAssignment.ts";
import { Machine, MachineProvider } from "./Machine.ts";
import { AttachLive, Redis, RedisProvider } from "./Redis.ts";
import { DecryptHttp } from "./DecryptHttp.ts";
import { EncryptHttp } from "./EncryptHttp.ts";
import { ExecHttp } from "./ExecHttp.ts";
import { GetSecretHttp } from "./GetSecretHttp.ts";
import { ListSecretsHttp } from "./ListSecretsHttp.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { SecretKey, SecretKeyProvider } from "./SecretKey.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { SignHttp } from "./SignHttp.ts";
import { Sprite, SpriteProvider } from "./Sprite.ts";
import { VerifyHttp } from "./VerifyHttp.ts";
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
      Bucket,
      Certificate,
      IpAssignment,
      Machine,
      Redis,
      Secret,
      SecretKey,
      Service,
      Sprite,
      VolumeSnapshot,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        BucketProvider(),
        CertificateProvider(),
        IpAssignmentProvider(),
        MachineProvider(),
        RedisProvider(),
        SecretProvider(),
        SecretKeyProvider(),
        ServiceProvider(),
        SpriteProvider(),
        VolumeSnapshotProvider(),
      ),
    ),
    Layer.provideMerge(MountVolumeLive),
    Layer.provideMerge(AttachBucketLive),
    Layer.provideMerge(AttachLive),
    Layer.provideMerge(CheckpointHttp),
    Layer.provideMerge(ExecHttp),
    Layer.provideMerge(GetSecretHttp),
    Layer.provideMerge(ListSecretsHttp),
    Layer.provideMerge(WriteSecretHttp),
    Layer.provideMerge(EncryptHttp),
    Layer.provideMerge(DecryptHttp),
    Layer.provideMerge(SignHttp),
    Layer.provideMerge(VerifyHttp),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FlyAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
