import * as Redacted from "effect/Redacted";
import * as Output from "../Output.ts";
import type { ApiToken } from "./ApiToken.ts";
import type { Dataset } from "./Dataset.ts";

/**
 * Compose the OTLP headers value Axiom's ingest endpoints expect —
 * `Authorization=Bearer <token>,X-Axiom-Dataset=<dataset>` — from an ingest
 * {@link ApiToken} and the target {@link Dataset}, in the standard
 * `OTEL_EXPORTER_OTLP_*_HEADERS` format.
 *
 * The result is a `Redacted` Output: binding it into a Function/Worker env
 * var produces a secret binding, so the bearer never appears in plaintext
 * runtime config.
 *
 * @example
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", {
 *   main: "./src/worker.ts",
 *   env: {
 *     OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces.otelTracesEndpoint,
 *     OTEL_EXPORTER_OTLP_TRACES_HEADERS: Axiom.otlpHeaders(ingest, traces),
 *   },
 * });
 * ```
 */
export const otlpHeaders = (
  token: ApiToken,
  dataset: Dataset,
): Output.Output<Redacted.Redacted<string>> =>
  Output.all(token.token, dataset.name).pipe(
    Output.map(
      ([bearer, name]) =>
        Redacted.make(
          `Authorization=Bearer ${Redacted.value(bearer)},X-Axiom-Dataset=${name}`,
        ) as Redacted.Redacted<string>,
    ),
  );
