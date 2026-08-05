import * as Lambda from "@/AWS/Lambda";
import type { Input, InputProps } from "@/Input.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  EXPORT_DELAY_VAR,
  OTLP_ENDPOINT_VAR,
  otelExtensionCollectorConfig,
} from "./otel-collector-config.ts";

const sandboxId = crypto.randomUUID();

export class OtelExtensionFunction extends Lambda.Function<Lambda.Function>()(
  "OtelExtensionFunction",
) {}

export interface OtelExtensionFunctionOptions {
  /**
   * Backend the Collector extension exports to. An `Input` because it is
   * normally another Function's `functionUrl` Output, resolved when the
   * binding is applied.
   */
  readonly remoteOtlpEndpoint: Input<string>;
  /** Milliseconds the test receiver stalls each remote export by. */
  readonly remoteExportDelayMs: number;
}

/**
 * Deploy-time-only values: this same Effect is re-executed inside the
 * bundled Lambda, where `host.bind` is a no-op and the collector
 * environment is already in `process.env`.
 */
const implementation = (options?: OtelExtensionFunctionOptions) =>
  Effect.gen(function* () {
    const work = Effect.fn("lambda.extension.child-span")(function* (
      marker: string,
    ) {
      yield* Effect.annotateCurrentSpan("telemetry.marker", marker);
      yield* Effect.log("lambda-extension-work-log").pipe(
        Effect.annotateLogs("telemetry.marker", marker),
      );
      return marker;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const marker = yield* work(
          url.searchParams.get("marker") ?? crypto.randomUUID(),
        );
        return yield* HttpServerResponse.json({ marker, sandboxId });
      }),
    };
  }).pipe(
    Effect.provide(
      Lambda.Collector({
        config: otelExtensionCollectorConfig,
        serviceName: "otel-lambda-extension-test",
        // A live test is a deploy, not a dev run — but be explicit so the
        // suite never silently no-ops if the harness ever runs it in dev.
        disabled: false,
        env: {
          OPENTELEMETRY_EXTENSION_LOG_LEVEL: "debug",
          [OTLP_ENDPOINT_VAR]: options?.remoteOtlpEndpoint ?? "",
          [EXPORT_DELAY_VAR]: String(options?.remoteExportDelayMs ?? 0),
        },
      }),
    ),
  );

export const OtelExtensionFunctionLive = ({
  collector,
  ...props
}: InputProps<Lambda.FunctionProps> & {
  collector: OtelExtensionFunctionOptions;
}) => OtelExtensionFunction.make(props, implementation(collector));

export default OtelExtensionFunction.make(
  { main: import.meta.url },
  implementation(),
);
