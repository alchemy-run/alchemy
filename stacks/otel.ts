import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";


/**
 * Provisions an Axiom OTEL ingestion pipeline:
 *
 * - Three datasets (`{stage}-traces`, `{stage}-logs`, `{stage}-metrics`),
 *   each with the matching `otel:*:v1` `kind`.
 * - One ingest-only API token scoped to those three datasets.
 * - Outputs the OTLP endpoints + `Authorization` header value so callers can
 *   wire them straight into a Worker / Lambda's env vars.
 * - Optionally syncs the same values to the GitHub repo's Actions secrets
 *   (set `SYNC_GITHUB_SECRETS=1` when deploying).
 */
export default Alchemy.Stack(
  "AlchemyOtel",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    const traces = yield* Axiom.Dataset("Traces", {
      name: `${stage}-traces`,
      kind: "otel:traces:v1",
      description: `OTEL traces for stage '${stage}'`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });

    const logs = yield* Axiom.Dataset("Logs", {
      name: `${stage}-logs`,
      kind: "otel:logs:v1",
      description: `OTEL logs for stage '${stage}'`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });

    const metrics = yield* Axiom.Dataset("Metrics", {
      name: `${stage}-metrics`,
      kind: "otel:metrics:v1",
      description: `OTEL metrics for stage '${stage}'`,
      retentionDays: 30,
      useRetentionPeriod: true,
    });

    const ingestToken = yield* Axiom.ApiToken("IngestToken", {
      name: `${stage}-otel-ingest`,
      description: `Ingest-only token for ${stage} OTEL datasets`,
      // Reference dataset Outputs (rather than literal strings) so Alchemy
      // sequences the token after the datasets exist.
      datasetCapabilities: Output.all(
        traces.name,
        logs.name,
        metrics.name,
      ).pipe(
        Output.map(([t, l, m]) => ({
          [t]: { ingest: ["create"] as const },
          [l]: { ingest: ["create"] as const },
          [m]: { ingest: ["create"] as const },
        })),
      ),
    });

    const tokenValue = ingestToken.token.pipe(
      Output.map((t) => (t ? Redacted.value(t) : "")),
    );
    const authHeader = tokenValue.pipe(Output.map((v) => `Bearer ${v}`));

    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: traces.otelEndpoint,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces.otelTracesEndpoint,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logs.otelLogsEndpoint,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metrics.otelMetricsEndpoint,
      AXIOM_DATASET_TRACES: traces.name,
      AXIOM_DATASET_LOGS: logs.name,
      AXIOM_DATASET_METRICS: metrics.name,
      AXIOM_INGEST_TOKEN: tokenValue,
      AXIOM_AUTHORIZATION_HEADER: authHeader,
    };

    if (process.env.SYNC_GITHUB_SECRETS === "1") {
      yield* GitHub.Secrets({
        owner: "alchemy-run",
        repository: "alchemy-effect",
        secrets: {
          AXIOM_INGEST_TOKEN: tokenValue,
          AXIOM_DATASET_TRACES: traces.name,
          AXIOM_DATASET_LOGS: logs.name,
          AXIOM_DATASET_METRICS: metrics.name,
          OTEL_EXPORTER_OTLP_ENDPOINT: traces.otelEndpoint,
        },
      });
    }

    return env;
  }).pipe(Effect.orDie),
);
