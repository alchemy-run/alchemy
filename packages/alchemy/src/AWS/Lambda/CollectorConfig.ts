/**
 * The Lambda Collector's configuration, as combinators over generated
 * `effect/Schema` codecs rather than hand-authored interfaces.
 *
 * The codecs come from `@distilled.cloud/otel-collector`, which compiles the
 * JSON Schemas reflected out of the collector's own Go config structs into one
 * codec per component, whose TYPE side is camelCase + `Duration.Duration` and
 * whose ENCODED side is the snake_case, Go-duration-string form the
 * collector's loader reads. The `service` block, which is not a component and
 * therefore has no reflected schema, is hand-authored there as a manual spec
 * and compiled the same way — so nothing in this file re-types the collector.
 *
 * Three properties follow from that, and they are why the configuration is
 * written here rather than as a `collector.yaml` on disk:
 *
 * - **Field coverage is not a promise, it is a build artifact.** A field is
 *   missing only if the collector build does not have it.
 * - **Validation is eager and located.** A typo is caught at the declaration
 *   site, in the constructor call that made it, with a JSON path — not at
 *   emission, and not by the extension crash-looping after a green deploy.
 * - **Emission is the encoder.** {@link collector} does not re-walk a config
 *   deciding how to render each leaf; the codec already produced the wire
 *   shape. What is left is only what a codec cannot do: resolving the
 *   references that are not strings yet.
 *
 * ## Everything a section holds is derived from a reference
 *
 * There is one rule, applied twice. You never write a config SECTION and then
 * a list of names into it; you write values, hand the values to whatever uses
 * them, and the section is whatever got used:
 *
 * - a {@link pipeline} holds receiver/processor/exporter VALUES, so
 *   `receivers:`, `processors:` and `exporters:` are derived from the
 *   pipelines;
 * - an exporter's `auth.authenticator` holds an extension VALUE, so
 *   `extensions:` and `service.extensions` are derived from the exporters.
 *
 * Deduplication is by **reference identity** in both cases: one `sigv4Auth`
 * value shared by two exporters is one entry in `extensions:`, exactly as one
 * exporter value shared by two pipelines is one entry in `exporters:`. A
 * component that no one references cannot be declared, and a name that
 * references nothing cannot be written.
 *
 * ## The static/dynamic split
 *
 * A codec can only validate values it can see. Several kinds of leaf are not
 * strings yet at declaration time:
 *
 * - an `Output` (or `Effect`) that resolves at deploy;
 * - a `Redacted`, whose material must never reach the config file, because the
 *   config layer is an ordinary downloadable Lambda layer;
 * - a `Config` primitive — `Config.redacted("AXIOM_TOKEN")` — which does not
 *   carry a value at all, but NAMES one the deployed environment provides;
 * - an {@link interpolate} template, which is the two of those plus literal
 *   text, concatenated;
 * - an {@link Extension} value, whose component id is not decided until
 *   `collector()` sees what name it was declared under.
 *
 * Note what is NOT in that list: a `${env:...}` string. That syntax is this
 * module's output, never its input — a reference is written as the value it
 * refers to, and the emitter decides how it renders.
 *
 * So every generated interface carries a `Str` type parameter over its *plain
 * string* leaves, and the constructors instantiate it at
 * {@link CollectorInput}: `Exporter.otlpHttp` takes
 * `OtlpHttpExporter<CollectorInput>`. Enums, numbers, booleans and durations
 * are `Str`-free and stay closed — an `Output<string>` is not a spelling of
 * `basic | normal | detailed`.
 *
 * At construction each such leaf is swapped for a unique **sentinel string**,
 * so the codec still validates the whole structure (the sentinel satisfies the
 * `string` the schema expects), and the reference is parked. At emission a
 * deferred sentinel becomes `${env:NAME}` — the name GENERATED from the config
 * path when the deploy owns the value, or the name the `Config` already
 * carries when the environment does — while an extension sentinel becomes the
 * component id the extension ended up declared under. Only in the first case
 * is anything handed to the Function's environment.
 *
 * @packageDocumentation
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  Exporters,
  Extensions,
  Processors,
  Receivers,
  Service,
  type ServicePipelineId,
  type ServiceTelemetry as GeneratedServiceTelemetry,
} from "@distilled.cloud/otel-collector/layer-collector-0.22.0";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { isPlainObject } from "../../Util/data.ts";

// ---------------------------------------------------------------------------
// Dynamic leaves
// ---------------------------------------------------------------------------

/**
 * A string leaf whose value is not known here: another resource's attribute,
 * or a secret.
 *
 * A value of this kind is resolved at DEPLOY time and never written into the
 * emitted file: the emitter binds it to a generated environment variable and
 * hands the value to the Function's environment.
 */
export type CollectorValue = Input<string> | Input<Redacted.Redacted<string>>;

/**
 * A reference to a variable the DEPLOYED environment provides.
 *
 * `Config.redacted("AXIOM_TOKEN")` says "read `AXIOM_TOKEN` where this runs".
 * The emitter renders `${env:AXIOM_TOKEN}` — the same name, no rewriting — and
 * binds nothing, because the variable is not this configuration's to provide.
 *
 * Only a PRIMITIVE with a name is accepted; see {@link collectorVariableName}
 * for what "primitive" means and why a derived config cannot be one.
 */
export type CollectorVariable =
  | Config.Config<string>
  | Config.Config<Redacted.Redacted<string>>;

/**
 * Everything a plain-string leaf accepts.
 *
 * This is the argument every generated interface's `Str` parameter is
 * instantiated at, so EVERY plain string leaf accepts one and no judgement
 * about which leaves are "likely to need it" is part of the surface.
 *
 * The widening lives in the generator rather than in a mapped type here for
 * one reason: a mapped type is opaque to every hover and every error message.
 * `Dynamic<OtlpHttpExporter>` would erase the name of the interface AND of
 * every interface nested inside it, so one misspelt key prints the whole
 * structural expansion with `Duration` inlined to its internals. Threading
 * `Str` keeps the names: the error reads `'retries' does not exist in type
 * 'OtlpHttpExporter<CollectorInput>'`, and a hover on `.tls` reads
 * `OtlpHttpExporterTls<CollectorInput>` rather than fifteen inlined fields.
 */
export type CollectorInput =
  | CollectorValue
  | CollectorVariable
  | Interpolation
  | Extension;

/**
 * What one non-literal string leaf resolves to, after the kind of reference it
 * was written as has been decided.
 *
 * Deciding this at DECLARATION time rather than at emission is what puts a bad
 * `Config` at the constructor call that wrote it, next to the rest of that
 * component's validation, instead of at the far end of the build.
 */
export type CollectorLeaf =
  | {
      /** Resolved by the deploy; bound to a generated variable. */
      readonly _tag: "Value";
      readonly value: CollectorValue;
    }
  | {
      /** Provided by the deployed environment; rendered, never bound. */
      readonly _tag: "Variable";
      readonly name: string;
    }
  | {
      /** Literals and leaves, concatenated. */
      readonly _tag: "Interpolation";
      readonly segments: readonly (string | CollectorLeaf)[];
    };

/** Classify one non-literal leaf. Throws for a `Config` that has no name. */
const leafOf = (value: CollectorInput): CollectorLeaf =>
  Config.isConfig(value)
    ? { _tag: "Variable", name: collectorVariableName(value) }
    : isInterpolation(value)
      ? { _tag: "Interpolation", segments: value.segments }
      : { _tag: "Value", value: value as CollectorValue };

// ---------------------------------------------------------------------------
// Variable references
// ---------------------------------------------------------------------------

/**
 * The probe value a name-extraction pass feeds back as every variable's
 * content. `\0`-delimited so no plausible transformation is the identity on it
 * by accident.
 */
const PROBE = "\u0000probe\u0000";

/**
 * The environment variable a {@link CollectorVariable} names.
 *
 * `Config` in Effect 4 is opaque — it carries no AST, only a `parse` function
 * — so the name is not read off the value, it is OBSERVED: the config is
 * parsed twice against probe providers that record every path they are asked
 * for, and a primitive is exactly the config that
 *
 * 1. asks for one single-segment path,
 * 2. hands that path's content back UNCHANGED when the probe supplies it, and
 * 3. fails when the probe does not.
 *
 * Each clause rejects a different way of being derived, which is why all three
 * are checked rather than just the first: `map` fails (2) because the result is
 * no longer the probe; `orElse` and `zip`/`all` fail (1) because they ask for a
 * second path; `withDefault` and `option` fail (3) because they succeed on a
 * variable that is not there. `nested` is rejected by (1) as well — it asks for
 * a two-segment path, and an environment variable has one name.
 *
 * The alternative — matching on `Config`'s internals — would break silently on
 * an Effect release. This breaks loudly or not at all: the observation is of
 * the same public `parse` contract the runtime itself uses.
 */
export const collectorVariableName = (config: CollectorVariable): string => {
  const observe = (
    present: boolean,
  ): {
    readonly paths: (string | number)[][];
    readonly exit: Exit.Exit<unknown, unknown>;
  } => {
    const paths: (string | number)[][] = [];
    const provider = ConfigProvider.make((path) =>
      Effect.sync(() => {
        paths.push([...path]);
        return present ? ConfigProvider.makeValue(PROBE) : undefined;
      }),
    );
    return {
      paths,
      // A primitive's `parse` is synchronous. Anything that is not resolves to
      // a defect here, which lands in the same rejection below.
      exit: Effect.runSyncExit(
        (config as Config.Config<unknown>).parse(provider) as Effect.Effect<
          unknown,
          unknown
        >,
      ),
    };
  };

  const reject = (why: string): never => {
    throw new Error(
      `AWS.Lambda.Collector: this \`Config\` is not a variable reference — ${why}. ` +
        "A config leaf must name one environment variable the deployed Function " +
        "already provides, e.g. `Config.redacted(\"AXIOM_TOKEN\")` or " +
        "`Config.string(\"BACKEND_URL\")`. A derived config (`map`, `zip`, `orElse`, " +
        "`withDefault`, `option`, `nested`) has no single name to render, and a " +
        "value that should be resolved by the deploy belongs on the deploy-time " +
        "channel instead — pass the `Output`/`Redacted` itself, or compose the two " +
        "with `interpolate`.",
    );
  };

  const present = observe(true);
  const name = present.paths[0]?.[0];
  if (
    present.paths.length !== 1 ||
    present.paths[0]!.length !== 1 ||
    typeof name !== "string"
  ) {
    return reject(
      present.paths.length === 0
        ? "it reads no variable at all"
        : `it reads ${present.paths
            .map((path) => JSON.stringify(path.join(".")))
            .join(", ")} rather than one plain name`,
    );
  }
  if (Exit.isFailure(present.exit)) {
    return reject("it rejects the value of the variable it names");
  }
  const value = present.exit.value;
  const plain = Redacted.isRedacted(value)
    ? Redacted.value(value as Redacted.Redacted<string>)
    : value;
  if (plain !== PROBE) {
    return reject("it transforms the variable it reads rather than returning it");
  }

  const absent = observe(false);
  if (Exit.isSuccess(absent.exit)) {
    return reject("it still produces a value when the variable is absent");
  }
  if (absent.paths.length !== 1) {
    return reject("it falls back to another variable when the first is absent");
  }

  return name;
};

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/** Brands an {@link Interpolation} so `park` does not walk into it. */
const InterpolationTag = Symbol.for(
  "alchemy/AWS.Lambda.Collector/Interpolation",
);

/**
 * One string leaf assembled from literals and references.
 *
 * Built by {@link interpolate}, accepted anywhere a plain-string leaf is.
 */
export interface Interpolation {
  readonly [InterpolationTag]: true;
  /** Literal text, and the leaves the gaps between it resolve to. */
  readonly segments: readonly (string | CollectorLeaf)[];
}

const isInterpolation = (value: unknown): value is Interpolation =>
  typeof value === "object" && value !== null && InterpolationTag in value;

/**
 * Assemble a string leaf from literal text and references.
 *
 * A header is rarely just a token: Axiom wants `Bearer <token>`, and the
 * prefix is not part of the secret. `interpolate` is how the two are written
 * as what they are, without a hand-written `${env:...}` anywhere:
 *
 * ```typescript
 * headers: {
 *   authorization: AWS.Lambda.interpolate`Bearer ${Config.redacted("AXIOM_TOKEN")}`,
 * }
 * ```
 *
 * Each hole keeps the meaning it has on its own — the combinator adds
 * concatenation and nothing else:
 *
 * - a `Config` primitive renders `${env:NAME}`, binding nothing;
 * - an `Output` or `Redacted` binds to a generated variable, so a token still
 *   never reaches the layer archive even with a literal prefix in front of it;
 * - a plain string is baked in, exactly as the surrounding literals are.
 *
 * Nested interpolations flatten, so a fragment can be built once and reused.
 */
export const interpolate = (
  literals: TemplateStringsArray,
  ...values: readonly CollectorInput[]
): Interpolation => {
  const segments: (string | CollectorLeaf)[] = [];
  const push = (segment: string | CollectorLeaf) => {
    const last = segments[segments.length - 1];
    if (typeof segment === "string") {
      if (segment === "") return;
      if (typeof last === "string") {
        segments[segments.length - 1] = last + segment;
        return;
      }
    }
    segments.push(segment);
  };
  literals.forEach((literal, index) => {
    push(literal);
    if (index >= values.length) return;
    const value = values[index]!;
    if (isComponent(value)) {
      throw new Error(
        "AWS.Lambda.Collector: a component cannot be interpolated into a string — " +
          "an extension is referenced as a value, not spliced into one",
      );
    }
    if (isInterpolation(value)) {
      for (const segment of value.segments) push(segment);
      return;
    }
    if (typeof value === "string") {
      push(value);
      return;
    }
    push(leafOf(value));
  });
  return { [InterpolationTag]: true, segments };
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Brands a declared component so a plain-string leaf holding one can be told
 * apart from an object the codec should walk into.
 */
const ComponentTag = Symbol.for("alchemy/AWS.Lambda.Collector/Component");

/**
 * One declared, validated component instance.
 *
 * `section` is the discriminator: a value of one section is not assignable
 * where another is expected, which is what makes
 * `pipeline({ exporters: [Processor.batch({})] })` a compile error rather than
 * a config the extension rejects on boot.
 */
export interface Component<Section extends string, Type extends string> {
  readonly [ComponentTag]: true;
  readonly section: Section;
  readonly type: Type;
  /** The instance name, if one was given. */
  readonly name: string | undefined;
  /**
   * The key this instance is declared under: the bare type, or `type/name`.
   *
   * Derived from nothing but what the caller wrote — no counter, no hash, no
   * declaration order — so it is stable across deploys. Adding a second
   * exporter later cannot rename the first, which matters because the
   * generated environment-variable names are derived from these keys and a
   * rename would churn the Function's configuration.
   */
  readonly key: string;
  /** The wire-encoded config, with sentinels standing in for dynamic leaves. */
  readonly encoded: unknown;
  /** Sentinel -> the reference it stands for. */
  readonly dynamic: ReadonlyMap<string, CollectorLeaf>;
  /** Sentinel -> the extension whose component id it stands for. */
  readonly refs: ReadonlyMap<string, Extension>;
}

export type Receiver = Component<"receivers", string>;
export type Processor = Component<"processors", string>;
export type Exporter = Component<"exporters", string>;
export type Extension = Component<"extensions", string>;

const isComponent = (value: unknown): value is Component<string, string> =>
  typeof value === "object" && value !== null && ComponentTag in value;

/**
 * Sentinels are `\0`-delimited so they cannot collide with anything a caller
 * could plausibly write, and the counter is module-global so two components
 * never mint the same one.
 */
const DEFERRED = /^\u0000otel:\d+\u0000$/;
const REFERENCE = /^\u0000otelref:\d+\u0000$/;
let sentinels = 0;

const isDeferred = (value: unknown): boolean =>
  Redacted.isRedacted(value) ||
  Output.isOutput(value) ||
  Effect.isEffect(value) ||
  (typeof value === "object" &&
    value !== null &&
    !Duration.isDuration(value) &&
    !Array.isArray(value) &&
    !isPlainObject(value));

/** What a single `park` pass pulled out of a props tree. */
interface Parked {
  readonly dynamic: Map<string, CollectorLeaf>;
  readonly refs: Map<string, Extension>;
}

const emptyParked = (): Parked => ({ dynamic: new Map(), refs: new Map() });

/** Replace every non-string leaf with a sentinel, recording what it stood for. */
const park = (value: unknown, parked: Parked): unknown => {
  if (value === null || value === undefined) return value;
  if (Duration.isDuration(value)) return value;
  if (isComponent(value)) {
    if (value.section !== "extensions") {
      throw new Error(
        `AWS.Lambda.Collector: a \`${value.section}\` component was used where a value was expected — ` +
          `only extensions are referenced from another component's config`,
      );
    }
    const sentinel = `\u0000otelref:${sentinels++}\u0000`;
    parked.refs.set(sentinel, value as Extension);
    return sentinel;
  }
  // A `Config` IS an `Effect` and an `Interpolation` IS a plain object, so
  // both must be classified before the structural tests below claim them.
  if (Config.isConfig(value) || isInterpolation(value) || isDeferred(value)) {
    const sentinel = `\u0000otel:${sentinels++}\u0000`;
    parked.dynamic.set(sentinel, leafOf(value as CollectorInput));
    return sentinel;
  }
  if (Array.isArray(value))
    return value.map((element) => park(element, parked));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, park(child, parked)]),
    );
  }
  return value;
};

/**
 * `onExcessProperty: "error"` is what makes a typo an error.
 *
 * The reflector emits no `required`, so every field is optional unless a patch
 * marks it so; without excess checking a misspelt key is silently dropped and
 * the component quietly runs on defaults.
 */
const STRICT = { onExcessProperty: "error" } as const;

/**
 * A component constructor: `otlpHttp(props)` or `otlpHttp(name, props)`.
 *
 * `Props` is the generated interface ALREADY instantiated at
 * {@link CollectorInput} — `OtlpHttpExporter<CollectorInput>` — not
 * `Dynamic<OtlpHttpExporter>`. See {@link Dynamic} for why.
 *
 * Written as two overloads rather than one rest-tuple union on purpose. A
 * union'd rest signature suppresses excess-property checking on the object
 * literal, which is precisely the check that turns `send_batch_size` (the wire
 * spelling) into a compile error rather than a silently ignored key.
 */
export interface ComponentConstructor<
  Section extends string,
  Type extends string,
  Props,
> {
  (props: Props): Component<Section, Type>;
  (name: string, props: Props): Component<Section, Type>;
}

const define = <Section extends string, Type extends string>(
  section: Section,
  type: Type,
  schema: Schema.Codec<any>,
): ComponentConstructor<Section, Type, any> =>
  ((...args: [any] | [string, any]) => {
    const [name, props] = args.length === 2 ? args : [undefined, args[0]];
    const parked = emptyParked();
    let encoded: unknown;
    try {
      encoded = Schema.encodeUnknownSync(schema, STRICT)(park(props, parked));
    } catch (cause) {
      throw new Error(
        `AWS.Lambda.Collector: invalid ${type} ${section.slice(0, -1)}` +
          `${name === undefined ? "" : ` "${name}"`} — ${(cause as Error).message}`,
        { cause },
      );
    }
    return {
      [ComponentTag]: true,
      section,
      type,
      name,
      key: name === undefined ? type : `${type}/${name}`,
      encoded,
      dynamic: parked.dynamic,
      refs: parked.refs,
    };
  }) as ComponentConstructor<Section, Type, any>;

/** One `ComponentConstructor` per member of a section's closed set. */
type Constructors<Section extends string, Members> = {
  readonly [K in keyof Members]: Members[K] extends readonly [
    infer Type extends string,
    infer Props,
  ]
    ? ComponentConstructor<Section, Type, Props>
    : never;
};

/** The two receivers the pinned extension build contains. */
export const Receiver: Constructors<
  "receivers",
  {
    otlp: ["otlp", Receivers.otlp.OtlpReceiver<CollectorInput>];
    telemetryApi: [
      "telemetryapi",
      Receivers.telemetryapi.TelemetryApiReceiver<CollectorInput>,
    ];
  }
> = {
  otlp: define("receivers", "otlp", Receivers.otlp.OtlpReceiver),
  telemetryApi: define(
    "receivers",
    "telemetryapi",
    Receivers.telemetryapi.TelemetryApiReceiver,
  ),
};

/** The ten processors the pinned extension build contains. */
export const Processor: Constructors<
  "processors",
  {
    attributes: [
      "attributes",
      Processors.attributes.AttributesProcessor<CollectorInput>,
    ];
    batch: ["batch", Processors.batch.BatchProcessor<CollectorInput>];
    coldStart: [
      "coldstart",
      Processors.coldstart.ColdStartProcessor<CollectorInput>,
    ];
    decouple: [
      "decouple",
      Processors.decouple.DecoupleProcessor<CollectorInput>,
    ];
    filter: ["filter", Processors.filter.FilterProcessor<CollectorInput>];
    memoryLimiter: [
      "memory_limiter",
      Processors.memoryLimiter.MemoryLimiterProcessor<CollectorInput>,
    ];
    probabilisticSampler: [
      "probabilistic_sampler",
      Processors.probabilisticSampler.ProbabilisticSamplerProcessor<CollectorInput>,
    ];
    resource: [
      "resource",
      Processors.resource.ResourceProcessor<CollectorInput>,
    ];
    span: ["span", Processors.span.SpanProcessor<CollectorInput>];
    transform: [
      "transform",
      Processors.transform.TransformProcessor<CollectorInput>,
    ];
  }
> = {
  attributes: define(
    "processors",
    "attributes",
    Processors.attributes.AttributesProcessor,
  ),
  batch: define("processors", "batch", Processors.batch.BatchProcessor),
  coldStart: define(
    "processors",
    "coldstart",
    Processors.coldstart.ColdStartProcessor,
  ),
  decouple: define(
    "processors",
    "decouple",
    Processors.decouple.DecoupleProcessor,
  ),
  filter: define("processors", "filter", Processors.filter.FilterProcessor),
  memoryLimiter: define(
    "processors",
    "memory_limiter",
    Processors.memoryLimiter.MemoryLimiterProcessor,
  ),
  probabilisticSampler: define(
    "processors",
    "probabilistic_sampler",
    Processors.probabilisticSampler.ProbabilisticSamplerProcessor,
  ),
  resource: define(
    "processors",
    "resource",
    Processors.resource.ResourceProcessor,
  ),
  span: define("processors", "span", Processors.span.SpanProcessor),
  transform: define(
    "processors",
    "transform",
    Processors.transform.TransformProcessor,
  ),
};

/** The four exporters the pinned extension build contains. */
export const Exporter: Constructors<
  "exporters",
  {
    debug: ["debug", Exporters.debug.DebugExporter<CollectorInput>];
    otlp: ["otlp", Exporters.otlp.OtlpExporter<CollectorInput>];
    otlpHttp: ["otlphttp", Exporters.otlphttp.OtlpHttpExporter<CollectorInput>];
    prometheusRemoteWrite: [
      "prometheusremotewrite",
      Exporters.prometheusremotewrite.PrometheusRemoteWriteExporter<CollectorInput>,
    ];
  }
> = {
  debug: define("exporters", "debug", Exporters.debug.DebugExporter),
  otlp: define("exporters", "otlp", Exporters.otlp.OtlpExporter),
  otlpHttp: define(
    "exporters",
    "otlphttp",
    Exporters.otlphttp.OtlpHttpExporter,
  ),
  prometheusRemoteWrite: define(
    "exporters",
    "prometheusremotewrite",
    Exporters.prometheusremotewrite.PrometheusRemoteWriteExporter,
  ),
};

/**
 * The two extensions the pinned extension build contains.
 *
 * An extension is a VALUE, like every other component. You do not name it in a
 * list and then spell that name again at the use site; you hand the value to
 * whatever needs it — `auth: { authenticator: sigv4 }` — and `collector()`
 * derives both `extensions:` and `service.extensions` from what got handed
 * out.
 */
export const Extension: Constructors<
  "extensions",
  {
    basicAuth: [
      "basicauth",
      Extensions.basicauth.BasicAuthExtension<CollectorInput>,
    ];
    sigv4Auth: [
      "sigv4auth",
      Extensions.sigv4auth.Sigv4AuthExtension<CollectorInput>,
    ];
  }
> = {
  basicAuth: define(
    "extensions",
    "basicauth",
    Extensions.basicauth.BasicAuthExtension,
  ),
  sigv4Auth: define(
    "extensions",
    "sigv4auth",
    Extensions.sigv4auth.Sigv4AuthExtension,
  ),
};

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/** One pipeline, holding component VALUES rather than names. */
export interface Pipeline {
  readonly receivers: readonly Receiver[];
  readonly processors: readonly Processor[];
  readonly exporters: readonly Exporter[];
}

/**
 * Wire components into a pipeline.
 *
 * Because the arguments are the component values themselves, a pipeline can
 * neither reference a component that was never declared nor declare one that
 * no pipeline uses: the `receivers`/`processors`/`exporters` sections are
 * derived from the pipelines, not written alongside them and checked against
 * them afterwards.
 */
export const pipeline = (spec: {
  readonly receivers: readonly Receiver[];
  readonly processors?: readonly Processor[];
  readonly exporters: readonly Exporter[];
}): Pipeline => ({
  receivers: spec.receivers,
  processors: spec.processors ?? [],
  exporters: spec.exporters,
});

/**
 * A pipeline name: a signal, or a named pipeline for that signal.
 *
 * Generated, not hand-written — `profiles` is absent because this build's
 * collector rejects a profiles pipeline without an alpha feature gate it does
 * not enable.
 */
export type PipelineName = ServicePipelineId;

/**
 * The collector's own telemetry.
 *
 * Also generated: the `service` block has no reflected schema, so
 * `@distilled.cloud/otel-collector` carries a hand-authored spec for it and
 * compiles it with the same compiler as every component.
 */
export type ServiceTelemetry = GeneratedServiceTelemetry<CollectorInput>;

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Prefix of every generated placeholder environment variable. */
const PLACEHOLDER_PREFIX = "ALCHEMY_OTEL";

/** The result of assembling a configuration. */
export interface EmittedCollectorConfig {
  /** The file content, written to `collector.yaml` in the config layer. */
  readonly content: string;
  /** Values every generated `${env:...}` placeholder reads. */
  readonly env: Record<string, CollectorValue>;
}

/**
 * The environment variable a value at this config path is bound to.
 *
 * Derived from the path and nothing else, exactly as in `CollectorConfig.ts`:
 * rotating a secret or repointing an endpoint leaves the emitted file
 * byte-identical, so the config `LayerVersion` does not republish.
 */
export const collectorPlaceholderName = (
  path: readonly (string | number)[],
): string =>
  [PLACEHOLDER_PREFIX, ...path]
    .map((segment) =>
      String(segment)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_"),
    )
    .join("_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

/** Group a section's instances, refusing an ambiguous anonymous pair. */
const sectionOf = (
  section: string,
  instances: readonly Component<string, string>[],
): Record<string, unknown> => {
  const byKey = new Map<string, Component<string, string>>();
  for (const instance of instances) {
    const existing = byKey.get(instance.key);
    if (existing !== undefined) {
      if (existing === instance) continue;
      if (instance.name === undefined) {
        throw new Error(
          `AWS.Lambda.Collector: two anonymous \`${instance.type}\` ${section} were declared, ` +
            `so both would be emitted as \`${instance.type}\` and one would silently win — ` +
            `give at least one a name, e.g. ${instance.type}("primary", { … })`,
        );
      }
      throw new Error(
        `AWS.Lambda.Collector: two different \`${instance.key}\` ${section} were declared — ` +
          `instance names must be unique within a section`,
      );
    }
    byKey.set(instance.key, instance);
  }
  return Object.fromEntries(
    [...byKey].map(([key, instance]) => [key, instance.encoded]),
  );
};

/**
 * Walk out from the pipelines' components to every extension they reference,
 * transitively, deduplicated by reference identity.
 *
 * The result is sorted by component key rather than left in discovery order:
 * `service.extensions` is an ordered list, and an order that depended on which
 * exporter happened to be declared first would churn the emitted file for a
 * reordering that changes nothing.
 */
const referencedExtensions = (
  roots: readonly Component<string, string>[],
): Extension[] => {
  const found: Extension[] = [];
  const seen = new Set<Extension>();
  const worklist = [...roots];
  while (worklist.length > 0) {
    const component = worklist.pop()!;
    for (const extension of component.refs.values()) {
      if (seen.has(extension)) continue;
      seen.add(extension);
      found.push(extension);
      worklist.push(extension);
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
};

/**
 * Assemble declared pipelines into the extension's config file plus the
 * environment it reads.
 *
 * Sections are derived: whatever the pipelines reference is what gets
 * declared, and whatever those components reference is what gets declared
 * after that. Deduplication is by **reference identity**, so one exporter
 * value used by both the traces and the logs pipeline is one emitted instance,
 * and one `sigv4Auth` value used by both of those exporters is one emitted
 * extension.
 *
 * The same identity rule routes dynamic values: one `Redacted` reference used
 * at several config paths produces ONE environment variable, named after the
 * canonically-first path that reaches it. The walk sorts keys as it goes — the
 * same `localeCompare` ordering as `Util/stable.ts` — so "first" does not
 * depend on declaration order, and the emitted bytes are canonical.
 *
 * The file is canonical JSON. YAML 1.2 is a superset of JSON, so the
 * extension's loader reads it unchanged, and the layer's content hash is
 * stable across dependency bumps and property order.
 */
export const collector = (spec: {
  readonly pipelines: { readonly [Name in PipelineName]?: Pipeline };
  readonly telemetry?: ServiceTelemetry;
}): EmittedCollectorConfig => {
  const pipelines = Object.entries(spec.pipelines).filter(
    (entry): entry is [string, Pipeline] => entry[1] !== undefined,
  );
  if (pipelines.length === 0) {
    throw new Error(
      "AWS.Lambda.Collector: the configuration declares no pipelines, so the extension would start and process nothing",
    );
  }

  const receivers: Receiver[] = [];
  const processors: Processor[] = [];
  const exporters: Exporter[] = [];
  for (const [, declared] of pipelines) {
    receivers.push(...declared.receivers);
    processors.push(...declared.processors);
    exporters.push(...declared.exporters);
  }
  const extensions = referencedExtensions([
    ...receivers,
    ...processors,
    ...exporters,
  ]);

  // The `service` block runs through its own generated codec, so a misspelt
  // telemetry field fails here rather than in the extension's config loader,
  // and `outputPaths` reaches the file as `output_paths` without this module
  // knowing that it should.
  const serviceParked = emptyParked();
  let service: unknown;
  try {
    service = Schema.encodeUnknownSync(
      Service,
      STRICT,
    )(
      park(
        {
          ...(extensions.length > 0
            ? { extensions: extensions.map((extension) => extension.key) }
            : {}),
          pipelines: Object.fromEntries(
            pipelines.map(([name, declared]) => [
              name,
              {
                receivers: declared.receivers.map((component) => component.key),
                ...(declared.processors.length > 0
                  ? {
                      processors: declared.processors.map(
                        (component) => component.key,
                      ),
                    }
                  : {}),
                exporters: declared.exporters.map((component) => component.key),
              },
            ]),
          ),
          ...(spec.telemetry === undefined
            ? {}
            : { telemetry: spec.telemetry }),
        },
        serviceParked,
      ),
    );
  } catch (cause) {
    throw new Error(
      `AWS.Lambda.Collector: invalid service block — ${(cause as Error).message}`,
      { cause },
    );
  }

  const tree: Record<string, unknown> = {
    receivers: sectionOf("receivers", receivers),
    exporters: sectionOf("exporters", exporters),
    service,
  };
  if (processors.length > 0)
    tree.processors = sectionOf("processors", processors);
  if (extensions.length > 0)
    tree.extensions = sectionOf("extensions", extensions);

  // Sentinel -> what it stands for, across every component in the config.
  const deferred = new Map<string, CollectorLeaf>();
  const references = new Map<string, Extension>();
  for (const component of [
    ...receivers,
    ...processors,
    ...exporters,
    ...extensions,
  ]) {
    for (const [sentinel, value] of component.dynamic)
      deferred.set(sentinel, value);
    for (const [sentinel, extension] of component.refs)
      references.set(sentinel, extension);
  }
  for (const [sentinel, value] of serviceParked.dynamic)
    deferred.set(sentinel, value);
  for (const [sentinel, extension] of serviceParked.refs)
    references.set(sentinel, extension);

  const env: Record<string, CollectorValue> = {};
  const origin = new Map<string, string>();
  // Value reference -> the variable it was bound to.
  const bound = new Map<unknown, string>();

  // Every name a `Config` leaf points at, collected before anything is bound:
  // a generated name that shadowed one of these would silently redirect a
  // reference the deployed environment already answers.
  const referenced = new Set<string>();
  const collect = (leaf: CollectorLeaf): void => {
    if (leaf._tag === "Variable") referenced.add(leaf.name);
    else if (leaf._tag === "Interpolation") {
      for (const segment of leaf.segments)
        if (typeof segment !== "string") collect(segment);
    }
  };
  for (const leaf of deferred.values()) collect(leaf);

  const bind = (
    value: CollectorValue,
    path: readonly (string | number)[],
  ): string => {
    const shared = bound.get(value);
    if (shared !== undefined) return `\${env:${shared}}`;
    const name = collectorPlaceholderName(path);
    const where = path.join(".");
    const previous = origin.get(name);
    if (previous !== undefined) {
      throw new Error(
        `AWS.Lambda.Collector: \`${where}\` and \`${previous}\` both generate the environment variable ${name} — rename one of the component instances so the two paths differ by more than punctuation`,
      );
    }
    if (referenced.has(name)) {
      throw new Error(
        `AWS.Lambda.Collector: \`${where}\` generates the environment variable ${name}, which a \`Config\` leaf elsewhere in this configuration already reads — rename the component instance, or read a different variable`,
      );
    }
    origin.set(name, where);
    bound.set(value, name);
    env[name] = value;
    return `\${env:${name}}`;
  };

  /**
   * Render one parked leaf.
   *
   * An interpolation's single dynamic segment binds under the leaf's own path,
   * so the common `Bearer ${token}` shape produces exactly the variable the
   * bare token would have. Only when there are several does the index join the
   * name, because only then does the path alone stop identifying them.
   */
  const render = (
    leaf: CollectorLeaf,
    path: readonly (string | number)[],
  ): string => {
    if (leaf._tag === "Variable") return `\${env:${leaf.name}}`;
    if (leaf._tag === "Value") return bind(leaf.value, path);
    const dynamic = leaf.segments.filter(
      (segment) => typeof segment !== "string",
    ).length;
    let index = 0;
    return leaf.segments
      .map((segment) =>
        typeof segment === "string"
          ? segment
          : render(segment, dynamic > 1 ? [...path, index++] : path),
      )
      .join("");
  };

  const walk = (
    value: unknown,
    path: readonly (string | number)[],
  ): unknown => {
    if (value === null) return null;
    if (typeof value === "string") {
      if (REFERENCE.test(value)) return references.get(value)!.key;
      return DEFERRED.test(value) ? render(deferred.get(value)!, path) : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      return value.map((element, index) => walk(element, [...path, index]));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (child === undefined) continue;
        out[key] = walk(child, [...path, key]);
      }
      return out;
    }
    // Anything left is a value the codecs typed as `unknown` (the collector's
    // `map[string]any` fields), so it never went through `park` and is
    // classified here instead.
    return render(leafOf(value as CollectorInput), path);
  };

  return { content: `${JSON.stringify(walk(tree, []), null, 2)}\n`, env };
};
