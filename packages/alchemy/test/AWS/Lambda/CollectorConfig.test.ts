import {
  collector,
  collectorPlaceholderName,
  Exporter,
  Extension,
  pipeline,
  Processor,
  Receiver,
} from "@/AWS/Lambda/CollectorConfig.ts";
import * as Output from "@/Output.ts";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Stand-ins for the two kinds of value that are not values yet at declaration
 * time: an attribute of another resource, and a credential.
 */
const backendUrl = Output.asOutput("https://ingest.example.test");
const ingestToken = Redacted.make("super-secret");

describe("the traces + logs example", () => {
  /** Built once so the reference-identity assertions have something to share. */
  const build = () => {
    const otlp = Receiver.otlp({
      protocols: { http: { endpoint: "127.0.0.1:4318" } },
    });
    const telemetryApi = Receiver.telemetryApi({ types: ["platform"] });

    const memoryLimiter = Processor.memoryLimiter({
      checkInterval: Duration.seconds(1),
      limitMib: 128,
    });
    const batch = Processor.batch({ timeout: Duration.seconds(1) });
    const decouple = Processor.decouple({ maxQueueSize: 200 });

    // ONE exporter value, used by both pipelines.
    const backend = Exporter.otlpHttp("backend", {
      endpoint: backendUrl,
      headers: { authorization: ingestToken },
      compression: "gzip",
      timeout: Duration.seconds(10),
    });

    return {
      backend,
      emitted: collector({
        pipelines: {
          traces: pipeline({
            receivers: [otlp, telemetryApi],
            processors: [memoryLimiter, batch, decouple],
            exporters: [backend],
          }),
          logs: pipeline({
            receivers: [otlp],
            processors: [memoryLimiter, batch, decouple],
            exporters: [backend],
          }),
        },
      }),
    };
  };

  it("emits exactly this config file", () => {
    expect(JSON.parse(build().emitted.content)).toEqual({
      exporters: {
        "otlphttp/backend": {
          compression: "gzip",
          endpoint: "${env:ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_ENDPOINT}",
          headers: {
            authorization:
              "${env:ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_HEADERS_AUTHORIZATION}",
          },
          timeout: "10s",
        },
      },
      processors: {
        batch: { timeout: "1s" },
        decouple: { max_queue_size: 200 },
        memory_limiter: { check_interval: "1s", limit_mib: 128 },
      },
      receivers: {
        otlp: { protocols: { http: { endpoint: "127.0.0.1:4318" } } },
        telemetryapi: { types: ["platform"] },
      },
      service: {
        pipelines: {
          logs: {
            exporters: ["otlphttp/backend"],
            processors: ["memory_limiter", "batch", "decouple"],
            receivers: ["otlp"],
          },
          traces: {
            exporters: ["otlphttp/backend"],
            processors: ["memory_limiter", "batch", "decouple"],
            receivers: ["otlp", "telemetryapi"],
          },
        },
      },
    });
  });

  it("binds each dynamic leaf exactly once, to the value the caller passed", () => {
    const { emitted } = build();
    expect(emitted.env).toEqual({
      ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_ENDPOINT: backendUrl,
      ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_HEADERS_AUTHORIZATION:
        ingestToken,
    });
  });

  it("emits one instance for a component value shared by two pipelines", () => {
    const { emitted } = build();
    const config = JSON.parse(emitted.content);
    expect(Object.keys(config.exporters)).toEqual(["otlphttp/backend"]);
    expect(Object.keys(config.receivers)).toEqual(["otlp", "telemetryapi"]);
    expect(Object.keys(config.processors)).toEqual([
      "batch",
      "decouple",
      "memory_limiter",
    ]);
  });

  it("is canonical: the same declaration emits the same bytes", () => {
    expect(build().emitted.content).toBe(build().emitted.content);
  });
});

describe("extensions are values, and the sections that hold them are derived", () => {
  /**
   * ONE `sigv4Auth` value, handed to two different exporters. Nobody writes
   * `extensions:` and nobody writes `service.extensions`.
   */
  const build = () => {
    const sigv4 = Extension.sigv4Auth({ region: "us-east-1", service: "aps" });
    const otlp = Receiver.otlp({ protocols: { http: {} } });
    return collector({
      pipelines: {
        traces: pipeline({
          receivers: [otlp],
          exporters: [
            Exporter.otlpHttp("primary", {
              endpoint: "https://primary.test",
              auth: { authenticator: sigv4 },
            }),
          ],
        }),
        metrics: pipeline({
          receivers: [otlp],
          exporters: [
            Exporter.prometheusRemoteWrite("amp", {
              endpoint: "https://aps.test/api/v1/remote_write",
              auth: { authenticator: sigv4 },
            }),
          ],
        }),
      },
    });
  };

  it("declares the shared extension once and resolves both references to its id", () => {
    const config = JSON.parse(build().content);
    expect(config.extensions).toEqual({
      sigv4auth: { region: "us-east-1", service: "aps" },
    });
    expect(config.exporters["otlphttp/primary"].auth).toEqual({
      authenticator: "sigv4auth",
    });
    expect(config.exporters["prometheusremotewrite/amp"].auth).toEqual({
      authenticator: "sigv4auth",
    });
  });

  it("derives service.extensions from the references, not from a list", () => {
    expect(JSON.parse(build().content).service.extensions).toEqual([
      "sigv4auth",
    ]);
  });

  it("declares two distinct extension values separately, ordered by key", () => {
    const otlp = Receiver.otlp({ protocols: { http: {} } });
    const east = Extension.sigv4Auth("east", { region: "us-east-1" });
    const west = Extension.sigv4Auth("west", { region: "us-west-2" });
    const config = JSON.parse(
      collector({
        pipelines: {
          traces: pipeline({
            receivers: [otlp],
            exporters: [
              Exporter.otlpHttp("w", {
                endpoint: "https://w.test",
                auth: { authenticator: west },
              }),
              Exporter.otlpHttp("e", {
                endpoint: "https://e.test",
                auth: { authenticator: east },
              }),
            ],
          }),
        },
      }).content,
    );
    expect(Object.keys(config.extensions)).toEqual([
      "sigv4auth/east",
      "sigv4auth/west",
    ]);
    // Declaration order was west-then-east; the emitted list is not.
    expect(config.service.extensions).toEqual([
      "sigv4auth/east",
      "sigv4auth/west",
    ]);
  });

  it("routes an extension's own secret through the environment", () => {
    const password = Redacted.make("hunter2");
    const basic = Extension.basicAuth({
      clientAuth: { username: "collector", password },
    });
    const emitted = collector({
      pipelines: {
        traces: pipeline({
          receivers: [Receiver.otlp({ protocols: { http: {} } })],
          exporters: [
            Exporter.otlpHttp({
              endpoint: "https://x.test",
              auth: { authenticator: basic },
            }),
          ],
        }),
      },
    });
    expect(emitted.env).toEqual({
      ALCHEMY_OTEL_EXTENSIONS_BASICAUTH_CLIENT_AUTH_PASSWORD: password,
    });
    expect(
      JSON.parse(emitted.content).extensions.basicauth.client_auth,
    ).toEqual({
      username: "collector",
      password: "${env:ALCHEMY_OTEL_EXTENSIONS_BASICAUTH_CLIENT_AUTH_PASSWORD}",
    });
  });

  it("emits no extensions section when nothing references one", () => {
    const config = JSON.parse(
      collector({
        pipelines: {
          traces: pipeline({
            receivers: [Receiver.otlp({ protocols: { http: {} } })],
            exporters: [Exporter.debug({})],
          }),
        },
      }).content,
    );
    expect(config.extensions).toBeUndefined();
    expect(config.service.extensions).toBeUndefined();
  });

  it("refuses a non-extension component where a value belongs", () => {
    expect(() =>
      Exporter.otlpHttp({
        endpoint: "https://x.test",
        // @ts-expect-error only an extension is referenced from another component
        auth: { authenticator: Processor.batch({}) },
      }),
    ).toThrowError(
      "AWS.Lambda.Collector: a `processors` component was used where a value was expected — " +
        "only extensions are referenced from another component's config",
    );
  });
});

describe("reference identity", () => {
  it("binds one Redacted used at two config paths to one variable", () => {
    const token = Redacted.make("shared");
    const emitted = collector({
      pipelines: {
        traces: pipeline({
          receivers: [Receiver.otlp({ protocols: { http: {} } })],
          exporters: [
            Exporter.otlpHttp("a", {
              endpoint: "https://a.test",
              headers: { authorization: token },
            }),
            Exporter.otlpHttp("b", {
              endpoint: "https://b.test",
              headers: { authorization: token },
            }),
          ],
        }),
      },
    });
    expect(Object.keys(emitted.env)).toEqual([
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_A_HEADERS_AUTHORIZATION",
    ]);
    const config = JSON.parse(emitted.content);
    // The variable is named after the canonically-FIRST path that reaches it,
    // and every other occurrence refers back to it.
    expect(config.exporters["otlphttp/b"].headers.authorization).toBe(
      "${env:ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_A_HEADERS_AUTHORIZATION}",
    );
  });

  it("binds two distinct Redacted values wrapping the same string separately", () => {
    const emitted = collector({
      pipelines: {
        traces: pipeline({
          receivers: [Receiver.otlp({ protocols: { http: {} } })],
          exporters: [
            Exporter.otlpHttp("a", {
              endpoint: "https://a.test",
              headers: { authorization: Redacted.make("same") },
            }),
            Exporter.otlpHttp("b", {
              endpoint: "https://b.test",
              headers: { authorization: Redacted.make("same") },
            }),
          ],
        }),
      },
    });
    expect(Object.keys(emitted.env).sort()).toEqual([
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_A_HEADERS_AUTHORIZATION",
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_B_HEADERS_AUTHORIZATION",
    ]);
  });
});

describe("declaration-site validation", () => {
  it("rejects a bogus field where it was written, with a path", () => {
    expect(() =>
      Processor.batch({
        timeout: Duration.seconds(1),
        // @ts-expect-error `send_batch_size` is spelt `sendBatchSize` here
        send_batch_size: 8192,
      }),
    ).toThrowError(
      'AWS.Lambda.Collector: invalid batch processor — Unexpected key with value 8192\n  at ["send_batch_size"]',
    );
  });

  it("names the instance in the error", () => {
    expect(() =>
      Exporter.otlpHttp("backend", {
        endpoint: "https://x.test",
        // @ts-expect-error `retries` is not a field of the otlphttp exporter
        retries: 3,
      }),
    ).toThrowError(
      'AWS.Lambda.Collector: invalid otlphttp exporter "backend" — Unexpected key with value 3\n  at ["retries"]',
    );
  });

  it("rejects a missing required field", () => {
    // @ts-expect-error `endpoint` is required
    expect(() => Exporter.otlpHttp({ compression: "gzip" })).toThrowError(
      /Missing key\s+at \["endpoint"\]/,
    );
  });

  it("rejects a value outside a recovered enum", () => {
    expect(() =>
      // @ts-expect-error `verbosity` is basic | normal | detailed, not an integer
      Exporter.debug({ verbosity: 2 }),
    ).toThrowError(
      'AWS.Lambda.Collector: invalid debug exporter — Expected "basic" | "normal" | "detailed" | undefined, got 2\n  at ["verbosity"]',
    );
  });
});

describe("the generated service block", () => {
  const withTelemetry = (
    telemetry: Parameters<typeof collector>[0]["telemetry"],
  ) =>
    collector({
      pipelines: {
        traces: pipeline({
          receivers: [Receiver.otlp({ protocols: { http: {} } })],
          exporters: [Exporter.debug({})],
        }),
      },
      telemetry,
    });

  it("encodes telemetry through the generated codec, camelCase to wire", () => {
    const config = JSON.parse(
      withTelemetry({
        logs: { level: "warn", outputPaths: ["stdout"] },
        metrics: { level: "none" },
      }).content,
    );
    expect(config.service.telemetry).toEqual({
      logs: { level: "warn", output_paths: ["stdout"] },
      metrics: { level: "none" },
    });
  });

  it("rejects a misspelt telemetry field at the call, with a path", () => {
    expect(() =>
      // @ts-expect-error `output_paths` is spelt `outputPaths` on the type side
      withTelemetry({ logs: { output_paths: ["stdout"] } }),
    ).toThrowError(
      /invalid service block — .*at \["telemetry"\]\["logs"\]\["output_paths"\]/s,
    );
  });

  it("routes a deferred telemetry leaf through the environment too", () => {
    const region = Output.asOutput("us-east-1");
    const emitted = withTelemetry({ resource: { "cloud.region": region } });
    expect(emitted.env).toEqual({
      ALCHEMY_OTEL_SERVICE_TELEMETRY_RESOURCE_CLOUD_REGION: region,
    });
    expect(
      JSON.parse(emitted.content).service.telemetry.resource["cloud.region"],
    ).toBe("${env:ALCHEMY_OTEL_SERVICE_TELEMETRY_RESOURCE_CLOUD_REGION}");
  });
});

describe("instance naming", () => {
  it("uses the bare component type when no name is given", () => {
    expect(Exporter.otlpHttp({ endpoint: "https://x.test" }).key).toBe(
      "otlphttp",
    );
    expect(
      Exporter.otlpHttp("backend", { endpoint: "https://x.test" }).key,
    ).toBe("otlphttp/backend");
  });

  it("refuses two anonymous instances of one type", () => {
    expect(() =>
      collector({
        pipelines: {
          traces: pipeline({
            receivers: [Receiver.otlp({ protocols: { http: {} } })],
            exporters: [
              Exporter.otlpHttp({ endpoint: "https://a.test" }),
              Exporter.otlpHttp({ endpoint: "https://b.test" }),
            ],
          }),
        },
      }),
    ).toThrowError(
      "AWS.Lambda.Collector: two anonymous `otlphttp` exporters were declared, " +
        "so both would be emitted as `otlphttp` and one would silently win — " +
        'give at least one a name, e.g. otlphttp("primary", { … })',
    );
  });

  it("refuses two anonymous extensions of one type", () => {
    const otlp = Receiver.otlp({ protocols: { http: {} } });
    expect(() =>
      collector({
        pipelines: {
          traces: pipeline({
            receivers: [otlp],
            exporters: [
              Exporter.otlpHttp("a", {
                endpoint: "https://a.test",
                auth: {
                  authenticator: Extension.sigv4Auth({ region: "us-east-1" }),
                },
              }),
              Exporter.otlpHttp("b", {
                endpoint: "https://b.test",
                auth: {
                  authenticator: Extension.sigv4Auth({ region: "us-west-2" }),
                },
              }),
            ],
          }),
        },
      }),
    ).toThrowError(/two anonymous `sigv4auth` extensions were declared/);
  });
});

describe("section typing", () => {
  it("refuses a processor where an exporter belongs", () => {
    pipeline({
      receivers: [Receiver.otlp({ protocols: { http: {} } })],
      // @ts-expect-error a `processors` component is not an `exporters` component
      exporters: [Processor.batch({})],
    });
  });

  it("refuses a pipeline id the collector would not accept", () => {
    collector({
      pipelines: {
        // @ts-expect-error `profiles` needs an alpha feature gate this build does not enable
        profiles: pipeline({
          receivers: [Receiver.otlp({ protocols: { http: {} } })],
          exporters: [Exporter.debug({})],
        }),
      },
    });
  });
});

/** Vary one exporter of an otherwise fixed, well-formed configuration. */
const withExporter = (exporter: Exporter) =>
  collector({
    pipelines: {
      traces: pipeline({
        receivers: [
          Receiver.otlp({
            protocols: { http: { endpoint: "127.0.0.1:4318" } },
          }),
        ],
        processors: [Processor.batch({ timeout: Duration.seconds(1) })],
        exporters: [exporter],
      }),
    },
  });

describe("the emitted file", () => {
  it("is canonical JSON that a YAML loader reads", () => {
    // YAML 1.2 is a superset of JSON, so the extension's loader takes this
    // unchanged — which is what lets emission skip a YAML printer whose
    // output format is not a stability contract.
    const { content } = withExporter(
      Exporter.otlpHttp("backend", { endpoint: "https://backend.example" }),
    );
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content.endsWith("\n")).toBe(true);
  });

  it("emits identical bytes regardless of property declaration order", () => {
    // Determinism is the LayerVersion's content hash: the same configuration
    // must never republish the layer just because it was written differently.
    const a = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: "https://backend.example",
        compression: "zstd",
        timeout: Duration.seconds(5),
      }),
    );
    const b = withExporter(
      Exporter.otlpHttp("backend", {
        timeout: Duration.seconds(5),
        endpoint: "https://backend.example",
        compression: "zstd",
      }),
    );
    expect(a.content).toBe(b.content);
  });

  it("bakes plain literals straight into the file", () => {
    const { content, env } = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: "https://backend.example",
        compression: "zstd",
      }),
    );
    expect(content).toContain("https://backend.example");
    expect(content).toContain("zstd");
    // A literal costs no environment variable.
    expect(env).toEqual({});
  });

  it("never writes a Redacted value into the file", () => {
    // A layer archive is an ordinary, downloadable Lambda layer. A token
    // baked into one is a published token, so this is the load-bearing
    // assertion of the whole typed surface — hence asserting on the raw
    // string rather than the parsed tree.
    const secret = "axiom-super-secret-token-value";
    const { content, env } = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: "https://backend.example",
        headers: { authorization: Redacted.make(secret) },
      }),
    );
    expect(content).not.toContain(secret);
    expect(content).toContain(
      "${env:ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_HEADERS_AUTHORIZATION}",
    );
    const bound =
      env.ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_HEADERS_AUTHORIZATION;
    expect(Redacted.isRedacted(bound)).toBe(true);
    expect(Redacted.value(bound as Redacted.Redacted<string>)).toBe(secret);
  });

  it("binds unresolved Inputs rather than resolving them into the file", () => {
    // Baking an Output would resolve it at deploy time and republish the
    // layer whenever the upstream resource changed.
    const { content, env } = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: Output.fromEffect(Effect.succeed("https://resolved.example")),
      }),
    );
    expect(content).not.toContain("https://resolved.example");
    expect(content).toContain(
      "${env:ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_ENDPOINT}",
    );
    expect(env.ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_BACKEND_ENDPOINT).toBeDefined();
  });

  it("bakes a hand-written ${env:...} placeholder verbatim", () => {
    // A caller's own placeholder is a plain string, so it is a literal and
    // survives untouched next to the generated ones. `CollectorProps.env`
    // supplies it — which is how the extension live test varies a backend
    // endpoint per run without republishing the layer.
    const { content, env } = withExporter(
      Exporter.otlpHttp({ endpoint: "${env:MY_BACKEND_URL}" }),
    );
    expect(content).toContain("${env:MY_BACKEND_URL}");
    expect(env).toEqual({});
  });

  it("renders Durations into the collector's Go format", () => {
    // The collector reads Go duration strings, which are not Effect's format.
    // Typing these as `Duration` (like `FunctionProps.timeout`) instead of a
    // bare string is what stops the two being confused; this pins the render.
    const { content } = collector({
      pipelines: {
        traces: pipeline({
          receivers: [
            Receiver.otlp({
              protocols: { http: { endpoint: "127.0.0.1:4318" } },
            }),
          ],
          processors: [
            Processor.memoryLimiter({
              checkInterval: Duration.seconds(1),
              minGcIntervalWhenSoftLimited: Duration.minutes(2),
            }),
            Processor.batch({ timeout: Duration.millis(100) }),
          ],
          exporters: [
            Exporter.otlpHttp("backend", {
              endpoint: "https://backend.example",
              timeout: Duration.millis(1500),
              retryOnFailure: { maxElapsedTime: Duration.hours(1) },
            }),
          ],
        }),
      },
    });
    const parsed = JSON.parse(content) as {
      processors: Record<string, any>;
      exporters: Record<string, any>;
    };
    expect(parsed.processors.batch.timeout).toBe("100ms");
    expect(parsed.processors.memory_limiter.check_interval).toBe("1s");
    expect(
      parsed.processors.memory_limiter.min_gc_interval_when_soft_limited,
    ).toBe("2m");
    // Not a whole number of seconds, so it renders in the next unit down.
    expect(parsed.exporters["otlphttp/backend"].timeout).toBe("1500ms");
    expect(
      parsed.exporters["otlphttp/backend"].retry_on_failure.max_elapsed_time,
    ).toBe("1h");
    // A Duration must never leak its internal representation into the file.
    expect(content).not.toContain("_tag");
    expect(content).not.toContain("millis");
  });
});

describe("placeholder names", () => {
  it("comes from the config path alone", () => {
    // No hash of the value and no counter: rotating a secret must leave the
    // emitted bytes identical so the layer does not republish.
    expect(
      collectorPlaceholderName([
        "exporters",
        "otlphttp/axiom-traces",
        "headers",
        "x-axiom-dataset",
      ]),
    ).toBe(
      "ALCHEMY_OTEL_EXPORTERS_OTLPHTTP_AXIOM_TRACES_HEADERS_X_AXIOM_DATASET",
    );
    // Array positions participate, so a list of attributes stays addressable.
    expect(
      collectorPlaceholderName([
        "processors",
        "resource",
        "attributes",
        0,
        "value",
      ]),
    ).toBe("ALCHEMY_OTEL_PROCESSORS_RESOURCE_ATTRIBUTES_0_VALUE");
  });

  it("leaves the file unchanged when only the secret changes", () => {
    const one = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: "https://backend.example",
        headers: { authorization: Redacted.make("first-value") },
      }),
    );
    const two = withExporter(
      Exporter.otlpHttp("backend", {
        endpoint: "https://backend.example",
        headers: { authorization: Redacted.make("second-value") },
      }),
    );
    expect(one.content).toBe(two.content);
    expect(Object.keys(one.env)).toEqual(Object.keys(two.env));
  });

  it("refuses two config paths that collapse to one name", () => {
    // `a-b` and `a_b` sanitize identically; silently letting one win would
    // point an exporter at the other's endpoint.
    expect(() =>
      collector({
        pipelines: {
          traces: pipeline({
            receivers: [Receiver.otlp({ protocols: { http: {} } })],
            exporters: [
              Exporter.otlpHttp("a-b", { endpoint: Redacted.make("one") }),
              Exporter.otlpHttp("a_b", { endpoint: Redacted.make("two") }),
            ],
          }),
        },
      }),
    ).toThrow(/both generate the environment variable/);
  });
});

describe("the pinned build's component surface", () => {
  it("models telemetryapi against the pinned tag, not lambda main", () => {
    // Regression: `max_items`/`max_bytes`/`timeout_ms` were modeled from the
    // lambda repo's main branch and do not exist at `layer-collector/0.22.0`.
    // The real surface is port/types/log_report/metrics_temporality/
    // export_interval_ms — a config using the old names silently loses the
    // settings, since the collector ignores receiver keys it cannot map.
    const { content } = collector({
      pipelines: {
        logs: pipeline({
          receivers: [
            Receiver.telemetryApi({
              port: 4325,
              types: ["platform", "function"],
              logReport: true,
              metricsTemporality: "delta",
              exportIntervalMs: 30_000,
            }),
          ],
          exporters: [
            Exporter.debug({ verbosity: "basic", outputPaths: ["stdout"] }),
          ],
        }),
      },
    });
    const parsed = JSON.parse(content) as { receivers: Record<string, any> };
    expect(Object.keys(parsed.receivers.telemetryapi).sort()).toEqual([
      "export_interval_ms",
      "log_report",
      "metrics_temporality",
      "port",
      "types",
    ]);
    expect(() =>
      // @ts-expect-error `maxItems` is not a telemetryapi field at 0.22.0
      Receiver.telemetryApi({ port: 4325, maxItems: 1000 }),
    ).toThrow(/Unexpected key/);
  });

  it("keeps prometheusremotewrite's squashed retry fields at the component root", () => {
    // PRW squashes `configretry.BackOffConfig` and its timeout config into
    // its own root, so — unlike the OTLP exporters — there is no
    // `retry_on_failure` block and a bare `enabled` is the retry switch.
    // Nesting them would emit a config the extension rejects on load.
    const { content } = collector({
      pipelines: {
        metrics: pipeline({
          receivers: [
            Receiver.otlp({
              protocols: { http: { endpoint: "127.0.0.1:4318" } },
            }),
          ],
          exporters: [
            Exporter.prometheusRemoteWrite({
              endpoint: "https://aps.example.com/api/v1/remote_write",
              enabled: true,
              initialInterval: Duration.seconds(5),
              maxElapsedTime: Duration.seconds(30),
              remoteWriteQueue: { numConsumers: 1 },
            }),
          ],
        }),
      },
    });
    const prw = (JSON.parse(content) as { exporters: Record<string, any> })
      .exporters.prometheusremotewrite;
    expect(prw.retry_on_failure).toBeUndefined();
    expect(prw.enabled).toBe(true);
    expect(prw.initial_interval).toBe("5s");
    expect(prw.remote_write_queue.num_consumers).toBe(1);
  });

  it("closes each section to the components this build ships", () => {
    // @ts-expect-error `filelog` is not a receiver of the pinned build
    Receiver.filelog;
    // @ts-expect-error `k8sattributes` is not a processor of the pinned build
    Processor.k8sattributes;
    // @ts-expect-error `jaeger` is not an exporter of the pinned build
    Exporter.jaeger;
    // @ts-expect-error `oauth2client` is not an extension of the pinned build
    Extension.oauth2client;
  });
});
