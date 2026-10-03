import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { resolveAzureCredentials } from "./Credentials.ts";

/**
 * Overrides the default Azure location (e.g. `westeurope`) for every
 * resource created without an explicit `location`. Provide it on the
 * stack's providers layer:
 *
 * ```typescript
 * providers: Azure.providers().pipe(
 *   Layer.provideMerge(Azure.location("westeurope")),
 * ),
 * ```
 */
export class Location extends Context.Service<Location, string>()(
  "Azure::Location",
) {}

/** Layer that sets the default Azure location for a stack. */
export const location = (name: string) => Layer.succeed(Location, name);

/**
 * Fully-resolved Azure environment for a stack: the subscription resources
 * are created in, the Entra tenant, and the default location.
 */
export interface AzureEnvironmentShape {
  subscriptionId: string;
  tenantId: string;
  /**
   * Default location for resources created without an explicit one: an
   * `Azure.Location` override, else the profile's location, else `eastus`.
   */
  location: string;
}

export class AzureEnvironment extends Context.Service<
  AzureEnvironment,
  Effect.Effect<AzureEnvironmentShape>
>()("Azure::Environment") {
  static current = AzureEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * Build the `AzureEnvironment` layer from the Alchemy AuthProvider.
 * The `Location` override is captured when the layer is built, since
 * provider lifecycles run in the providers' context.
 */
export const environmentFromAuthProvider = () =>
  Layer.effect(
    AzureEnvironment,
    Effect.gen(function* () {
      const resolved = yield* resolveAzureCredentials;
      const override = yield* Effect.serviceOption(Location);
      return resolved.pipe(
        Effect.map((creds) => ({
          subscriptionId: creds.subscriptionId,
          tenantId: creds.tenantId,
          location: Option.getOrElse(override, () => creds.location),
        })),
        Effect.orDie,
      );
    }),
  );
