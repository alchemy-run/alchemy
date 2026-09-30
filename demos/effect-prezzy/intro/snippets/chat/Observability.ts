import * as Axiom from "alchemy/Axiom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Ingest, Logs, Traces } from "./Telemetry.ts";

const errors = "['chat-traces'] | where error | summarize count() by bin_auto(_time)";
const chart = { id: "errors", name: "Errors", type: "TimeSeries", query: { apl: errors } } as const;
const window = { refreshTime: 60, schemaVersion: 2, timeWindowStart: "qr-now-1h", timeWindowEnd: "qr-now" } as const;

// #region show
export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    // #region dashboard
    yield* Axiom.Dashboard("Chat", {
      dashboard: { name: "Chat", owner: "", charts: [chart], layout: [{ i: "errors", x: 0, y: 0, w: 12, h: 6 }], ...window },
    });
    // #endregion dashboard
    // #region monitor
    yield* Axiom.Monitor("Errors", {
      name: "Chat errors",
      type: "Threshold",
      aplQuery: errors,
      operator: "Above",
      threshold: 10,
      intervalMinutes: 5,
      rangeMinutes: 5,
    });
    // #endregion monitor

    return Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs });
  }),
);
// #endregion show
