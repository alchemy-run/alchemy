import type {
  GetTerminalReadersReaderError,
  GetTerminalReadersReaderRequest,
  GetTerminalReadersReaderResponse,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TerminalReader } from "./TerminalReader.ts";

export interface RetrieveTerminalReaderRequest extends Omit<
  GetTerminalReadersReaderRequest,
  "reader"
> {}

/**
 * Retrieve a bound Stripe Terminal Reader over HTTP.
 *
 * ### Reading a Reader
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTerminalReader(reader);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveTerminalReader extends Binding.Service<
  RetrieveTerminalReader,
  "Stripe.RetrieveTerminalReader",
  (
    reader: TerminalReader,
  ) => Effect.Effect<
    (
      request?: RetrieveTerminalReaderRequest,
    ) => Effect.Effect<
      GetTerminalReadersReaderResponse,
      GetTerminalReadersReaderError,
      RuntimeContext
    >
  >
> {}

export const RetrieveTerminalReader = Binding.Service<RetrieveTerminalReader>(
  "Stripe.RetrieveTerminalReader",
);
