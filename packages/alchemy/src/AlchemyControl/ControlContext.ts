import type * as Scope from "effect/Scope";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { AlchemyContext } from "../AlchemyContext.ts";
import type { ArtifactStore } from "../Artifacts.ts";
import type { CredentialsStore } from "../Auth/Credentials.ts";
import type { ProfileStore } from "../Auth/Profile.ts";
import type { Cli } from "../Cli/Cli.ts";
import type { CliKit } from "../Cli/CliKit/CliKit.ts";
import type { PlatformServices } from "../Util/PlatformServices.ts";

/** Services captured by AlchemyControl and supplied to deferred control operations. */
export type ControlContext =
  | AlchemyContext
  | ArtifactStore
  | Cli
  | CliKit
  | CredentialsStore
  | HttpClient.HttpClient
  | PlatformServices
  | ProfileStore
  | Scope.Scope;
