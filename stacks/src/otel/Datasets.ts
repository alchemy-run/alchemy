import * as Axiom from "@alchemy.run/axiom";
import { Stack } from "alchemy/Stack";

/**
 * Keep every event: no retention period. `retentionDays: 0` is how Axiom
 * spells "no limit" (it then reports `useRetentionPeriod: false`).
 *
 * Never lower this on a live dataset. Shortening retention makes Axiom
 * delete everything older than the new period, and that can't be undone:
 * the 30 days these datasets used to declare wiped prod telemetry from
 * June to early October 2026 when the stack adopted them.
 */
const keepForever = { retentionDays: 0, useRetentionPeriod: false } as const;

export const Traces = Axiom.Dataset(
  "Traces",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-traces`,
    kind: "otel:traces:v1" as const,
    description: `OTEL traces for stage '${stage}'`,
    ...keepForever,
  })),
);

export const Logs = Axiom.Dataset(
  "Logs",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-logs`,
    kind: "otel:logs:v1" as const,
    description: `OTEL logs for stage '${stage}'`,
    ...keepForever,
  })),
);

export const Metrics = Axiom.Dataset(
  "Metrics",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-metrics`,
    kind: "otel:metrics:v1" as const,
    description: `OTEL metrics for stage '${stage}'`,
    ...keepForever,
  })),
);
