import { AlchemyContext } from "@/AlchemyContext.ts";
import {
  COLLECTOR_LAYER_VERSION,
  COLLECTOR_RELEASE,
  Collector,
  collectorExtensionLayerArn,
} from "@/AWS/Lambda/Collector.ts";
import { axiomCollectorYaml } from "@/Axiom/LambdaCollector.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Build the Collector layer with a stubbed engine context and NO binding
 * host. When it is enabled it must reach the host check and die; when it is
 * disabled it must short-circuit before touching anything.
 */
const buildWithoutHost = (options: { dev: boolean; disabled?: boolean }) =>
  Effect.void.pipe(
    Effect.provide(
      Collector({ config: "/nonexistent", disabled: options.disabled }),
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
      // attach, rather than tripping over the bogus config path first.
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
        const shared = Collector({ config: "/nonexistent" });

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

describe("Axiom.LambdaCollector packaged configuration", () => {
  it("receives on loopback only", () => {
    expect(axiomCollectorYaml).toContain("endpoint: 127.0.0.1:4318");
  });

  it("routes traces and logs to separate dataset-scoped exporters", () => {
    expect(axiomCollectorYaml).toContain("otlphttp/axiom-traces:");
    expect(axiomCollectorYaml).toContain("otlphttp/axiom-logs:");
    expect(axiomCollectorYaml).toContain(
      "x-axiom-dataset: ${env:AXIOM_TRACES_DATASET}",
    );
    expect(axiomCollectorYaml).toContain(
      "x-axiom-dataset: ${env:AXIOM_LOGS_DATASET}",
    );
  });

  it("bounds memory first and decouples last in every pipeline", () => {
    // `memory_limiter` first sheds load before the sandbox OOMs; `decouple`
    // last is what moves remote export off the response path.
    const pipelines = axiomCollectorYaml.match(/processors: \[.*\]/g) ?? [];
    expect(pipelines.length).toBe(2);
    for (const pipeline of pipelines) {
      expect(pipeline).toBe("processors: [memory_limiter, batch, decouple]");
    }
    expect(axiomCollectorYaml).toContain("memory_limiter:");
  });

  it("keeps the remote endpoint extension-owned", () => {
    // The in-process exporter must only ever know loopback — binding the
    // standard SDK variable would route it straight past the extension.
    expect(axiomCollectorYaml).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});
