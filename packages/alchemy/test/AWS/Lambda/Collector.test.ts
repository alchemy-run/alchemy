import { AlchemyContext } from "@/AlchemyContext.ts";
import {
  COLLECTOR_LAYER_VERSION,
  COLLECTOR_RELEASE,
  Collector,
  collectorExtensionLayerArn,
} from "@/AWS/Lambda/Collector.ts";
import {
  collector,
  Exporter,
  pipeline,
  Receiver,
} from "@/AWS/Lambda/CollectorConfig.ts";
import { axiomCollectorConfig } from "@/Axiom/LambdaCollector.ts";
import * as Output from "@/Output.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** The smallest configuration that assembles. */
const minimalConfig = collector({
  pipelines: {
    traces: pipeline({
      receivers: [
        Receiver.otlp({ protocols: { http: { endpoint: "127.0.0.1:4318" } } }),
      ],
      exporters: [Exporter.debug({})],
    }),
  },
});

/**
 * Build the Collector layer with a stubbed engine context and NO binding
 * host. When it is enabled it must reach the host check and die; when it is
 * disabled it must short-circuit before touching anything.
 */
const buildWithoutHost = (options: { dev: boolean; disabled?: boolean }) =>
  Effect.void.pipe(
    Effect.provide(
      Collector({ config: minimalConfig, disabled: options.disabled }),
    ),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: "/nonexistent/.alchemy",
      dev: options.dev,
      adopt: false,
    }),
    Effect.scoped,
    Effect.map(() => ({ attached: false, reason: "" })),
    Effect.catchCause((cause) =>
      Effect.succeed({ attached: true, reason: Cause.pretty(cause) }),
    ),
  );

describe("AWS.Lambda.Collector extension layer ARN", () => {
  it("maps Lambda x86_64 to the upstream amd64 layer", () => {
    expect(
      collectorExtensionLayerArn({
        region: "us-east-1",
        architecture: "x86_64",
      }),
    ).toBe(
      `arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-collector-amd64-${COLLECTOR_RELEASE}:${COLLECTOR_LAYER_VERSION}`,
    );
  });

  it("preserves arm64 and the selected Region", () => {
    expect(
      collectorExtensionLayerArn({
        region: "eu-west-1",
        architecture: "arm64",
      }),
    ).toBe(
      `arn:aws:lambda:eu-west-1:184161586896:layer:opentelemetry-collector-arm64-${COLLECTOR_RELEASE}:${COLLECTOR_LAYER_VERSION}`,
    );
  });

  it("honors release, layer version, publisher, and partition overrides", () => {
    expect(
      collectorExtensionLayerArn({
        region: "cn-north-1",
        architecture: "arm64",
        release: "0_23_0",
        layerVersion: 4,
        publisherAccountId: "111122223333",
        partition: "aws-cn",
      }),
    ).toBe(
      "arn:aws-cn:lambda:cn-north-1:111122223333:layer:opentelemetry-collector-arm64-0_23_0:4",
    );
  });

  it("refuses to build an ARN without a Region", () => {
    // A layer ARN is region-scoped; a blank Region would silently produce an
    // unattachable ARN that only fails at UpdateFunctionConfiguration.
    expect(() =>
      collectorExtensionLayerArn({ region: "  ", architecture: "arm64" }),
    ).toThrow(/region is required/);
  });
});

describe("AWS.Lambda.Collector dev gating", () => {
  it.effect("attaches nothing during a dev run", () =>
    Effect.gen(function* () {
      // Short-circuits before the host check, so building succeeds with no
      // host in context — proof the extension was never attached.
      expect((yield* buildWithoutHost({ dev: true })).attached).toBe(false);
    }),
  );

  it.effect("attaches during a dev run when explicitly enabled", () =>
    Effect.gen(function* () {
      // `disabled: false` opts back in, so the host check is reached and
      // fails — the only outcome available without a Function in context.
      expect(
        (yield* buildWithoutHost({ dev: true, disabled: false })).attached,
      ).toBe(true);
    }),
  );

  it.effect("attaches on a normal deploy", () =>
    Effect.gen(function* () {
      const result = yield* buildWithoutHost({ dev: false });
      expect(result.attached).toBe(true);
      // Pin WHY it failed: reaching the host check is the proof it tried to
      // attach, rather than tripping over the configuration first.
      expect(result.reason).toContain("unsupported host");
    }),
  );

  it.effect("stays off when explicitly disabled outside dev", () =>
    Effect.gen(function* () {
      expect(
        (yield* buildWithoutHost({ dev: false, disabled: true })).attached,
      ).toBe(false);
    }),
  );
});

describe("AWS.Lambda.Collector shared across hosts", () => {
  // One layer VALUE provided at two NESTED sites. `Effect.provide` builds a
  // layer in a fork of the fiber's `CurrentMemoMap` and then runs the inner
  // effect with that fork in context, and forks inherit the parent's entries
  // — so a host declared inside another host's implementation (an app whose
  // durable Function is yielded from its API Function's init) inherits the
  // outer build of a shared layer constant instead of building its own.
  it.effect(
    "rebuilds at every provide site instead of reusing the outer host's build",
    () =>
      Effect.gen(function* () {
        const shared = Collector({ config: minimalConfig });

        // Inner site: enabled (`dev: false`) — a real build must reach the
        // host check and die. Reusing the outer site's disabled (empty) build
        // succeeds instead: the silent no-telemetry deployment this guards
        // against.
        const inner = Effect.void.pipe(
          Effect.provide(shared),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: "/nonexistent/.alchemy",
            dev: false,
            adopt: false,
          }),
          Effect.scoped,
          Effect.map(() => ({ attached: false, reason: "" })),
          Effect.catchCause((cause) =>
            Effect.succeed({ attached: true, reason: Cause.pretty(cause) }),
          ),
        );

        // Outer site: disabled (dev) — builds `shared` to an empty layer, then
        // runs the inner site under the memo map that holds that build.
        const result = yield* inner.pipe(
          Effect.provide(shared),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: "/nonexistent/.alchemy",
            dev: true,
            adopt: false,
          }),
          Effect.scoped,
        );

        expect(result.attached).toBe(true);
        expect(result.reason).toContain("unsupported host");
      }),
  );
});

/** The token the preset would prefix, as `Axiom.ApiToken.token` is Redacted. */
const AXIOM_TOKEN = "axiom-ingest-token-abcdef";

/**
 * The preset's `Authorization` value: one shared reference, exactly as
 * `Axiom.LambdaCollector` builds it, so the dedupe path is what is tested.
 */
const axiomAuthorization = Redacted.make(`Bearer ${AXIOM_TOKEN}`);

/**
 * The preset's configuration with the non-secret values supplied as plain
 * literals, so assertions can read the emitted file directly. The
 * `Output`-valued case (a real `Axiom.Dataset`) is covered below.
 */
const axiomEmitted = axiomCollectorConfig({
  endpoint: "https://api.axiom.co",
  authorization: axiomAuthorization,
  tracesDataset: "api-traces",
  logsDataset: "api-logs",
});

/** The emitted file, parsed — canonical JSON, so this is exact. */
const axiomConfig = JSON.parse(axiomEmitted.content) as {
  receivers: Record<string, any>;
  processors: Record<string, any>;
  exporters: Record<string, any>;
  service: {
    telemetry?: Record<string, any>;
    pipelines: Record<string, { processors: string[] }>;
  };
};

describe("Axiom.LambdaCollector packaged configuration", () => {
  it("receives on loopback only", () => {
    expect(axiomConfig.receivers.otlp.protocols.http.endpoint).toBe(
      "127.0.0.1:4318",
    );
  });

  it("routes traces and logs to separate dataset-scoped exporters", () => {
    expect(axiomConfig.exporters["otlphttp/axiom-traces"]).toBeDefined();
    expect(axiomConfig.exporters["otlphttp/axiom-logs"]).toBeDefined();
    expect(
      axiomConfig.exporters["otlphttp/axiom-traces"].headers["x-axiom-dataset"],
    ).toBe("api-traces");
    expect(
      axiomConfig.exporters["otlphttp/axiom-logs"].headers["x-axiom-dataset"],
    ).toBe("api-logs");
    expect(axiomConfig.service.pipelines.traces).toBeDefined();
    expect(axiomConfig.service.pipelines.logs).toBeDefined();
  });

  it("bounds memory first and decouples last in every pipeline", () => {
    // `memory_limiter` first sheds load before the sandbox OOMs; `decouple`
    // last is what moves remote export off the response path.
    const pipelines = Object.values(axiomConfig.service.pipelines);
    expect(pipelines.length).toBe(2);
    for (const declared of pipelines) {
      expect(declared.processors).toEqual([
        "memory_limiter",
        "batch",
        "decouple",
      ]);
    }
    expect(axiomConfig.processors.memory_limiter).toBeDefined();
  });

  it("declares one receiver and one processor set for both pipelines", () => {
    // Both pipelines hold the SAME component values, so each is emitted once.
    expect(Object.keys(axiomConfig.receivers)).toEqual(["otlp"]);
    expect(Object.keys(axiomConfig.processors).sort()).toEqual([
      "batch",
      "decouple",
      "memory_limiter",
    ]);
  });

  it("keeps the collector's own logging quiet", () => {
    expect(axiomConfig.service.telemetry).toEqual({ logs: { level: "warn" } });
  });

  it("keeps the remote endpoint extension-owned", () => {
    // The in-process exporter must only ever know loopback — binding the
    // standard SDK variable would route it straight past the extension.
    expect(axiomEmitted.content).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  it("binds the ingest credential once and shares it across both exporters", () => {
    // The credential goes through the TYPED secret channel — no hand-written
    // placeholder, no `props.env` entry. Both exporters must reference the
    // same generated variable, so rotating the token touches one value.
    const traces =
      axiomConfig.exporters["otlphttp/axiom-traces"].headers.authorization;
    const logs =
      axiomConfig.exporters["otlphttp/axiom-logs"].headers.authorization;
    expect(traces).toMatch(/^\$\{env:ALCHEMY_OTEL_[A-Z0-9_]+\}$/);
    expect(logs).toBe(traces);

    // Exactly one pair was generated for it.
    const name = traces.slice("${env:".length, -1);
    const generated = Object.keys(axiomEmitted.env).filter((key) =>
      key.endsWith("_AUTHORIZATION"),
    );
    expect(generated).toEqual([name]);

    // It is still Redacted, and it carries the Bearer prefix — asserted on
    // the bound value, never on the emitted content.
    const bound = axiomEmitted.env[name];
    expect(Redacted.isRedacted(bound)).toBe(true);
    expect(
      Redacted.value(bound as Redacted.Redacted<string>).startsWith("Bearer "),
    ).toBe(true);
  });

  it("never writes the ingest credential into the emitted file", () => {
    // The load-bearing property of the preset: a layer archive is a
    // downloadable artifact, so the token must not be in it in any form.
    expect(axiomEmitted.content).not.toContain(AXIOM_TOKEN);
    expect(axiomEmitted.content).not.toContain("Bearer axiom");
  });

  it("binds dataset names that are Outputs instead of baking them", () => {
    // The real preset path: `Axiom.Dataset` attributes are Outputs, so the
    // emitted layer must stay free of them — otherwise renaming a dataset
    // republishes the layer.
    const emitted = axiomCollectorConfig({
      endpoint: "https://api.axiom.co",
      authorization: axiomAuthorization,
      tracesDataset: Output.fromEffect(Effect.succeed("api-traces")),
      logsDataset: Output.fromEffect(Effect.succeed("api-logs")),
    });
    expect(emitted.content).not.toContain("api-traces");
    expect(emitted.content).not.toContain("api-logs");
    expect(
      Object.keys(emitted.env)
        .filter((key) => key.endsWith("_X_AXIOM_DATASET"))
        .sort(),
    ).toEqual([
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_AXIOM_LOGS_HEADERS_X_AXIOM_DATASET",
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_AXIOM_TRACES_HEADERS_X_AXIOM_DATASET",
    ]);
  });
});
