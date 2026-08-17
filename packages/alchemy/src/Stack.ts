/**
 * The `Stack` SERVICE — the identity every runtime and engine module
 * depends on: name, stage, and the resource/binding/action registries a
 * stack evaluation accumulates.
 *
 * This module is an import-graph LEAF (types + one Context tag + a pure
 * helper): safe for foreign-bundled server code (the `alchemy/Serve`
 * bridges `Layer.succeed` it from env markers) and for every engine
 * module alike. The `Alchemy.Stack(...)` CONSTRUCTOR — the engine half
 * whose graph wires the CLI, auth, and platform layers — lives in
 * `StackBuilder.ts` and is assembled over this same tag, so the public
 * fused symbol is both callable and yieldable with one identity.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type * as Scope from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { ActionLike } from "./Action.ts";
import type { AlchemyContext } from "./AlchemyContext.ts";
import type { ArtifactStore } from "./Artifacts.ts";
import type { AuthProviders } from "./Auth/AuthProvider.ts";
import type { CredentialsStore } from "./Auth/Credentials.ts";
import type { AlchemyProfile } from "./Auth/Profile.ts";
import type { Cli } from "./Cli/Cli.ts";
import type { PlatformServices } from "./Util/PlatformServices.ts";
import type { Provider, ProviderCollectionLike } from "./Provider.ts";
import type { Stage } from "./Stage.ts";
import type { State } from "./State/State.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";

export type Stack = Context.ServiceClass.Shape<
  "Stack",
  Omit<StackSpec, "output">
>;

/** The `Stack` service tag. */
export const Stack = Context.Service<Stack, Omit<StackSpec, "output">>()(
  "Stack",
);

export interface StackSpec<Output = any> {
  name: string;
  stage: string;
  // @internal
  resources: {
    [logicalId: string]: ResourceLike;
  };
  bindings: {
    [logicalId: string]: ResourceBinding[];
  };
  /** Tasks registered on the stack, keyed by FQN. */
  actions: {
    [logicalId: string]: ActionLike;
  };
  output: Output;
}

/**
 * Retract a speculatively-declared resource from a stack under
 * construction — the sanctioned way for a composite to withdraw a
 * declaration it made only to OBSERVE the user program's evaluation
 * (e.g. an effectful Website's sibling Handlers Lambda, declared so
 * event-source listeners have a host to register against, then
 * retracted when the evaluation registered none).
 *
 * Contract: only the declaring composite may retract, only during stack
 * evaluation (before plan), and only when nothing else can reference the
 * row — no exposed handle, no binding FROM another resource. Both the
 * resource row and its collected binding rows are withdrawn.
 * @internal
 */
export const retractResource = (
  stack: Pick<StackSpec, "resources" | "bindings">,
  fqn: string,
): void => {
  delete stack.resources[fqn];
  delete stack.bindings[fqn];
};

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const CurrentStack = Effect.serviceOption(Stack).pipe(
  Effect.map(Option.getOrUndefined),
);

export type StackServices =
  | Stack
  | Stage
  | Scope.Scope
  | FileSystem
  | Path
  | AlchemyContext
  | HttpClient
  | ChildProcessSpawner
  | AuthProviders
  | AlchemyProfile
  | ArtifactStore
  | CredentialsStore
  | Cli;

export type ProviderServices =
  | ProviderCollectionLike
  | Provider<any>
  | EnvironmentLike
  | CredentialsLike
  | DockerLike;

// tagged type to allow types like AWSEnvironment/AWS Region to bubble through
export interface EnvironmentLike {
  readonly kind: "Environment";
}

// tagged type to allow types like AWS Credentials to bubble through
export interface CredentialsLike {
  readonly kind: "Credentials";
}

export interface DockerLike {
  readonly key: "@alchemy/Docker";
}

export type StackEffect<A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  | PlatformServices
  | HttpClient
  | Scope.Scope
  | AuthProviders
  | AlchemyContext
  | Cli
  | AlchemyProfile
  | CredentialsStore
  | ArtifactStore
  | State
  | Req
>;

export interface CompiledStack<
  Output = any,
  Services = any,
> extends StackSpec<Output> {
  services: Context.Context<Services>;
}
