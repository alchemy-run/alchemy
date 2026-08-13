import * as Lambda from "@/AWS/Lambda";
import type { ApiToken } from "@/Axiom/ApiToken.ts";
import type { Dataset } from "@/Axiom/Dataset.ts";
import { LambdaCollector } from "@/Axiom/LambdaCollector.ts";
import type { InputProps } from "@/Input.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const sandboxId = crypto.randomUUID();

export class AxiomCollectorFunction extends Lambda.Function<Lambda.Function>()(
  "AxiomCollectorFunction",
) {}

export interface AxiomCollectorOptions {
  readonly token: ApiToken;
  /** A `Dataset` resource, or the name of one that already exists. */
  readonly traces: Dataset | string;
  /** A `Dataset` resource, or the name of one that already exists. */
  readonly logs: Dataset | string;
  readonly endpoint?: string;
}

/**
 * `options` exist only at deploy time, where the Axiom resources are in
 * scope. The bundled runtime entry re-executes this module inside the
 * Lambda with none of them — and needs none: the `Telemetry` reference
 * defaults to reading the destinations bound at deploy, so the exporter is
 * already configured without a layer here.
 */
const implementation = (options?: AxiomCollectorOptions) =>
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
      options === undefined
        ? Layer.empty
        : // The whole Axiom-on-Lambda story in one call: extension layer,
          // packaged collector.yaml, ingest token, and dataset routing.
          LambdaCollector({
            token: options.token,
            traces: options.traces,
            logs: options.logs,
            endpoint: options.endpoint,
            serviceName: "otel-lambda-extension-test",
            // A live test is a deploy, not a dev run — explicit so the suite
            // never silently no-ops if the harness ever runs it in dev.
            disabled: false,
          }),
    ),
  );

export const AxiomCollectorFunctionLive = ({
  axiom,
  ...props
}: InputProps<Lambda.FunctionProps> & { axiom: AxiomCollectorOptions }) =>
  AxiomCollectorFunction.make(props, implementation(axiom));

export default AxiomCollectorFunction.make(
  { main: import.meta.url },
  implementation(),
);
