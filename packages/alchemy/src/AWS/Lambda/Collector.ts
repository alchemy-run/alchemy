/**
 * The OpenTelemetry Collector as a Lambda extension, wired in one call.
 *
 * Effect's telemetry exports over OTLP/HTTP to a Collector running *inside*
 * the execution environment, and the Collector owns the remote export:
 *
 * ```text
 * Effect telemetry -> OTLP/HTTP on localhost -> Collector extension -> backend
 * ```
 *
 * The handler's invocation-scoped exporter flushes to loopback, which is
 * fast and local. The Collector's `decouple` processor then ships to the
 * remote backend on the extension's own lifecycle, so backend latency does
 * not sit in front of the response. Delivery is best-effort, not durable —
 * a frozen or reclaimed environment can drop what is still queued, and a
 * slow backend can still consume billed duration or delay environment
 * reuse. Business-critical events belong in durable storage written by the
 * handler.
 *
 * @packageDocumentation
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import { layerOtlp } from "../../Telemetry.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Function, FunctionArchitecture } from "./Function.ts";
import { LayerVersion } from "./LayerVersion.ts";

/**
 * Narrow the ambient binding host to a Lambda Function.
 *
 * Deliberately NOT `isBindingHost`: that predicate also admits ECS Tasks and
 * Kubernetes workloads, which share the `{ env, policyStatements }` contract
 * but have no notion of a layer. The Collector ships as a layer, so a
 * Lambda Function is the only host it can attach to.
 */
const isLambdaFunction = (value: unknown): value is Function =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "AWS.Lambda.Function";

/**
 * A resource passed to the layer: either the module-scope declaration (an
 * Effect that resolves to the instance, so the same declaration shared by
 * several Functions registers exactly one resource) or an already-yielded
 * instance.
 */
type CollectorConfigInput =
  | LayerVersion
  | Effect.Effect<LayerVersion, never, any>;

/**
 * Where the Collector's local OTLP receiver listens. The in-process
 * exporter and the packaged `collector.yaml` must agree on this, so it is
 * one constant rather than two settings.
 */
const LOOPBACK_ENDPOINT = "http://127.0.0.1:4318";

/** Path the extension reads its configuration from inside `/opt`. */
const CONFIG_URI = "/opt/collector.yaml";

/**
 * AWS account that publishes the upstream `opentelemetry-collector` Lambda
 * layers. Same id in every commercial region.
 */
const COLLECTOR_PUBLISHER_ACCOUNT_ID = "184161586896";

/**
 * The upstream release this version of alchemy is pinned to. Pinned rather
 * than tracked so an upstream publish can never change a deployment
 * implicitly — override via {@link CollectorExtension} to move.
 */
export const COLLECTOR_RELEASE = "0_22_0";

/** Published layer version of {@link COLLECTOR_RELEASE}. */
export const COLLECTOR_LAYER_VERSION = 1;

/**
 * Pinning and ARN derivation for the managed Collector extension layer.
 * Every field has a default; override only what your account needs.
 */
export interface CollectorExtension {
  /**
   * Upstream collector release, as it appears in the layer name.
   * @default "0_22_0"
   */
  release?: string;
  /**
   * Published layer version for {@link release} in this region.
   * @default 1
   */
  layerVersion?: number;
  /**
   * Account publishing the layer.
   * @default "184161586896"
   */
  publisherAccountId?: string;
  /**
   * ARN partition — set for `aws-cn` / `aws-us-gov`.
   * @default "aws"
   */
  partition?: string;
  /**
   * Region the layer is resolved in. Layer ARNs are region-scoped and a
   * Function can only attach layers from its own region.
   * @default the deploy region (`AWS.AWSEnvironment.current`)
   */
  region?: string;
  /**
   * Instruction set the extension binary must match.
   * @default the host Function's `architecture` prop (`"x86_64"` when unset)
   */
  architecture?: FunctionArchitecture;
}

/**
 * A fully-resolved layer version ARN, bypassing derivation entirely. Use
 * this for a mirrored/private copy of the extension, or a region where the
 * upstream layer version differs.
 */
export interface CollectorExtensionArn {
  layerVersionArn: Input<string>;
}

export interface CollectorProps {
  /**
   * The Collector configuration.
   *
   * A directory path is packaged into an `AWS.Lambda.LayerVersion` for you
   * — it must contain `collector.yaml`, since that is where the extension
   * reads from under `/opt`. Pass an existing `LayerVersion` declaration
   * instead to share one config layer across several Functions.
   */
  config: string | CollectorConfigInput;
  /**
   * Values the configuration's `${env:...}` placeholders read — backend
   * endpoints, dataset names, ingest tokens. `Redacted` values bind as
   * secrets, exactly like {@link layerOtlp} headers, so a token passed here
   * never lands in plaintext state.
   */
  env?: Record<
    string,
    Input<string> | Input<Redacted.Redacted<string>> | undefined
  >;
  /** Managed extension layer pinning, or a resolved ARN to use verbatim. */
  extension?: CollectorExtension | CollectorExtensionArn;
  /**
   * Where the in-process exporter sends OTLP, which must match the
   * `otlp` receiver in the configuration.
   * @default "http://127.0.0.1:4318"
   */
  endpoint?: string;
  /**
   * Attach nothing and export nothing.
   *
   * Defaults to `true` during `alchemy dev`: the extension is a real
   * published layer on a real Lambda, so it cannot run against a local
   * emulator, and a dev iteration should not be shipping spans to a
   * production backend. Set `false` to opt a dev run back in.
   * @default true in dev, false otherwise
   */
  disabled?: boolean;
  /**
   * The exported `service.name`.
   * @default the deployed Function's physical name
   */
  serviceName?: Input<string>;
}

const isArnOverride = (
  extension: CollectorProps["extension"],
): extension is CollectorExtensionArn =>
  extension !== undefined && "layerVersionArn" in extension;

/**
 * Build the managed extension layer's ARN.
 *
 * The upstream layers are published per architecture under the *Go* name
 * for it (`amd64`), not Lambda's (`x86_64`), so the two vocabularies have
 * to be translated. Exported for tests; callers use {@link Collector}.
 */
export const collectorExtensionLayerArn = (options: {
  region: string;
  architecture: FunctionArchitecture;
  release?: string;
  layerVersion?: number;
  publisherAccountId?: string;
  partition?: string;
}): string => {
  if (options.region.trim() === "") {
    throw new Error(
      "AWS.Lambda.Collector: a region is required to derive the extension layer ARN",
    );
  }
  const layerArchitecture =
    options.architecture === "x86_64" ? "amd64" : options.architecture;
  const release = options.release ?? COLLECTOR_RELEASE;
  const version = options.layerVersion ?? COLLECTOR_LAYER_VERSION;
  const account = options.publisherAccountId ?? COLLECTOR_PUBLISHER_ACCOUNT_ID;
  const partition = options.partition ?? "aws";
  return `arn:${partition}:lambda:${options.region}:${account}:layer:opentelemetry-collector-${layerArchitecture}-${release}:${version}`;
};

/**
 * Resource declarations are Effects — yield them to get the instance, so a
 * declaration shared across Functions registers one resource.
 */
const instance = (
  resource: CollectorConfigInput,
): Effect.Effect<LayerVersion> =>
  Effect.isEffect(resource)
    ? (resource as Effect.Effect<LayerVersion>)
    : Effect.succeed(resource);

/**
 * Run the OpenTelemetry Collector as a Lambda extension and point this
 * Function's telemetry at it.
 *
 * Building the layer attaches the pinned managed extension layer and your
 * configuration layer to the host Function through the binding channel,
 * binds the extension's environment, and installs the in-process OTLP
 * exporter aimed at loopback. It composes with any other telemetry layer
 * merged alongside it — destinations accumulate rather than clobber.
 *
 * @section Attaching the Collector
 * @example Bring your own collector.yaml
 * ```typescript
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, architecture: "arm64" },
 *   Effect.gen(function* () {
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       AWS.Lambda.Collector({
 *         config: fileURLToPath(new URL("./collector-config", import.meta.url)),
 *         env: { COLLECTOR_EXPORTER_OTLP_ENDPOINT: backend.url },
 *       }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @example Secrets in the collector environment
 * ```typescript
 * AWS.Lambda.Collector({
 *   config: collectorConfig,
 *   // `Redacted` binds through the secret channel — never plaintext state.
 *   env: { AXIOM_INGEST_TOKEN: token.value, AXIOM_TRACES_DATASET: "traces" },
 * })
 * ```
 *
 * @section Sharing one configuration layer
 * @example One LayerVersion, several Functions
 * ```typescript
 * // Declared once at module scope: yielding the same declaration from two
 * // Functions registers a single LayerVersion.
 * const collectorConfig = AWS.Lambda.LayerVersion("CollectorConfig", {
 *   path: fileURLToPath(new URL("./collector-config", import.meta.url)),
 *   compatibleArchitectures: ["arm64"],
 * });
 *
 * AWS.Lambda.Collector({ config: collectorConfig });
 * ```
 *
 * @section Pinning and overrides
 * @example Move to another upstream release
 * ```typescript
 * AWS.Lambda.Collector({
 *   config: collectorConfig,
 *   extension: { release: "0_23_0", layerVersion: 1 },
 * })
 * ```
 *
 * @example A mirrored or private extension layer
 * ```typescript
 * AWS.Lambda.Collector({
 *   config: collectorConfig,
 *   extension: { layerVersionArn: mirroredLayer.layerVersionArn },
 * })
 * ```
 *
 * @example Deploy the layer in a fixed region
 * ```typescript
 * // Layer ARNs are region-scoped; override when the deploy region and the
 * // Function's region are derived separately.
 * AWS.Lambda.Collector({
 *   config: collectorConfig,
 *   extension: { region: "us-east-1", architecture: "arm64" },
 * })
 * ```
 *
 * @section Dev mode
 * @example Opt a dev run back into real export
 * ```typescript
 * // The extension is a published layer on a real Lambda, so it is disabled
 * // during `alchemy dev` by default.
 * AWS.Lambda.Collector({ config: collectorConfig, disabled: false })
 * ```
 */
export const Collector = (props: CollectorProps): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // `AlchemyContext.dev` is the engine's single source of truth for dev
      // mode — the same flag the local providers and `Alchemy.remote()`
      // resolve against — never a raw env var, which is not set for
      // programmatic runs. Read optionally: this same Effect is re-executed
      // inside the deployed bundle, where the engine's context is absent.
      const dev = Option.match(yield* Effect.serviceOption(AlchemyContext), {
        onNone: () => false,
        onSome: (context) => context.dev,
      });
      if (props.disabled ?? dev) {
        // Nothing bound means nothing to read back, so the runtime half of
        // `layerOtlp` resolves zero destinations and exports nothing — the
        // decision made here at deploy time holds at runtime for free.
        return Layer.empty;
      }

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Resolve the host BEFORE declaring the configuration layer: a wrong
        // host should fail without having registered a resource for a
        // Function that can never use it.
        const host = yield* Binding.Host;
        if (!isLambdaFunction(host)) {
          return yield* Effect.die(
            new Error(
              `AWS.Lambda.Collector: unsupported host ${host?.Type ?? "(none)"} — the Collector runs as a Lambda extension layer, so it is only attachable to an AWS.Lambda.Function`,
            ),
          );
        }

        const configLayer = yield* instance(
          typeof props.config === "string"
            ? LayerVersion("CollectorConfig", {
                path: props.config,
                description: "OpenTelemetry Collector configuration",
              })
            : props.config,
        );

        const extension = props.extension;
        const extensionArn = isArnOverride(extension)
          ? extension.layerVersionArn
          : collectorExtensionLayerArn({
              // Cast per the AWS binding-layer idiom: the deploy environment
              // is provided by the stack, and erasing the requirement keeps
              // this a `Layer<never>` for the caller.
              region:
                extension?.region ??
                (yield* AWSEnvironment.current as unknown as Effect.Effect<{
                  region: string;
                }>).region,
              architecture: extension?.architecture ?? architectureOf(host),
              release: extension?.release,
              layerVersion: extension?.layerVersion,
              publisherAccountId: extension?.publisherAccountId,
              partition: extension?.partition,
            });

        yield* host.bind`AWS.Lambda.Collector(${configLayer})`({
          // The managed extension first: `/opt` is populated in layer order,
          // so the extension binary lands before the config beside it.
          layers: [extensionArn, configLayer],
          env: {
            OPENTELEMETRY_COLLECTOR_CONFIG_URI: CONFIG_URI,
            ...props.env,
          },
        });
      }

      // The app exports to loopback only; the extension owns remote export.
      return layerOtlp({
        url: props.endpoint ?? LOOPBACK_ENDPOINT,
        serviceName: props.serviceName,
      });
      // Named so publishing the config layer and binding the extension are
      // attributable in a deploy trace rather than anonymous work under
      // whichever Function happened to build this layer.
    }).pipe(Effect.withSpan("AWS.Lambda.Collector")),
  ) as Layer.Layer<never>;

/**
 * The architecture the extension binary has to match.
 *
 * Read from the host Function's props, mirroring the provider's own
 * `"x86_64"` default for an unset `architecture`. An `Output`-valued
 * architecture cannot be resolved at bind time (the ARN is a string built
 * now), so it fails loudly and points at the explicit override.
 */
const architectureOf = (host: Function): FunctionArchitecture => {
  const architecture = host.Props?.architecture ?? "x86_64";
  if (architecture !== "x86_64" && architecture !== "arm64") {
    throw new Error(
      `AWS.Lambda.Collector: cannot derive the extension layer ARN from ${String(host.LogicalId)}'s architecture — set \`extension.architecture\` explicitly`,
    );
  }
  return architecture;
};
