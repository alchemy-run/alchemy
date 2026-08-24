import type {
  GetTerminalConfigurationsConfigurationError,
  GetTerminalConfigurationsConfigurationRequest,
  GetTerminalConfigurationsConfigurationResponse,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TerminalConfiguration } from "./TerminalConfiguration.ts";

export interface RetrieveTerminalConfigurationRequest extends Omit<
  GetTerminalConfigurationsConfigurationRequest,
  "configuration"
> {}

/**
 * Retrieve a bound Stripe Terminal Configuration over HTTP.
 *
 * ### Reading a Terminal Configuration
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTerminalConfiguration(config);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveTerminalConfiguration extends Binding.Service<
  RetrieveTerminalConfiguration,
  "Stripe.RetrieveTerminalConfiguration",
  (
    configuration: TerminalConfiguration,
  ) => Effect.Effect<
    (
      request?: RetrieveTerminalConfigurationRequest,
    ) => Effect.Effect<
      GetTerminalConfigurationsConfigurationResponse,
      GetTerminalConfigurationsConfigurationError,
      RuntimeContext
    >
  >
> {}

export const RetrieveTerminalConfiguration =
  Binding.Service<RetrieveTerminalConfiguration>(
    "Stripe.RetrieveTerminalConfiguration",
  );
