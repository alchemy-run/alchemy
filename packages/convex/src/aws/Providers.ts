import * as AWS from "@alchemy.run/aws";
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import * as Cloud from "../Providers.ts";
import { AdminKey, AdminKeyProvider } from "./AdminKey.ts";
import { StageDatabase, StageDatabaseProvider } from "./StageDatabase.ts";

/**
 * Service tag bundling the self-hosted Convex providers. Use
 * `Convex.providers()` from `@alchemy.run/convex/aws` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("ConvexAws") {}

/**
 * Build the self-hosted Convex providers Layer. It includes `AWS.providers()`, so
 * a stack needs nothing else for AWS. It also includes the Convex Cloud
 * providers, because `Convex.Functions` works with both. Those need no token
 * unless a Cloud resource is used.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Convex.providers(), state: AWS.state() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([AdminKey, StageDatabase])).pipe(
    Layer.provide(Layer.mergeAll(AdminKeyProvider(), StageDatabaseProvider())),
    Layer.provideMerge(Cloud.providers()),
    Layer.provideMerge(AWS.providers()),
  );
