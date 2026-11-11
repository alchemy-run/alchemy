import { DockerLive } from "@alchemy.run/docker/Docker";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiToken, ApiTokenProvider } from "./ApiToken.ts";
import { ArchilAuth } from "./AuthProvider.ts";
import { Branch, BranchProvider } from "./Branch.ts";
import { Checkpoint, CheckpointProvider } from "./Checkpoint.ts";
import * as Credentials from "./Credentials.ts";
import { Disk, DiskProvider } from "./Disk.ts";
import { DiskUser, DiskUserProvider } from "./DiskUser.ts";
import { Image, ImageProvider } from "./Image.ts";
import { DeployerKey, DeployerKeyProvider } from "./internal/DeployerKey.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { SandboxPortToken, SandboxPortTokenProvider } from "./SandboxPortToken.ts";

/**
 * Service tag bundling all Archil providers + auth + credentials. Use
 * `Archil.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Archil") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Archil providers Layer: every Archil resource, the
 * Archil AuthProvider registration (so `alchemy profile edit` can configure
 * it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Archil.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiToken,
      Branch,
      Checkpoint,
      DeployerKey,
      Disk,
      DiskUser,
      Image,
      Sandbox,
      SandboxPortToken,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiTokenProvider(),
        BranchProvider(),
        CheckpointProvider(),
        DeployerKeyProvider(),
        DiskProvider(),
        DiskUserProvider(),
        ImageProvider(),
        SandboxProvider(),
        SandboxPortTokenProvider(),
      ),
    ),
    Layer.provideMerge(Command.providers()),
    // `BuildPlan.push` builds Dockerfile images locally for Archil to pull.
    Layer.provideMerge(DockerLive),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ArchilAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
