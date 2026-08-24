/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import { useMemo, useSyncExternalStore, type JSX } from "react";
import {
  Box,
  ProgressBar,
  ProgressGroup,
  Spinner,
  Text,
  useTerminalSize,
} from "../CliKit/components.ts";
import { CliKit, theme } from "../CliKit/index.ts";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ScanEvent =
  | { kind: "start"; id: string }
  | { kind: "done"; id: string; count: number }
  | { kind: "error"; id: string; message: string };

export type DeleteEvent =
  | { kind: "pass"; pass: number }
  | { kind: "deleted"; id: string }
  | { kind: "failed"; id: string };

/**
 * Minimal reduced-state store read via `useSyncExternalStore`. Events fold
 * into the snapshot as they arrive, so a subscriber that mounts after
 * `cli.live.open` returns still sees everything — no replay buffering.
 */
class ProgressStore<S> {
  private readonly listeners = new Set<() => void>();
  constructor(private state: S) {}
  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(f: (state: S) => S): void {
    this.state = f(this.state);
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Scan phase
// ---------------------------------------------------------------------------

interface ScanState {
  scanned: number;
  toDelete: number;
  inFlight: ReadonlyArray<string>;
}

const reduceScan = (prev: ScanState, event: ScanEvent): ScanState => {
  const inFlight = new Set(prev.inFlight);
  if (event.kind === "start") {
    inFlight.add(event.id);
    return { ...prev, inFlight: [...inFlight] };
  }
  inFlight.delete(event.id);
  return {
    scanned: prev.scanned + 1,
    toDelete: prev.toDelete + (event.kind === "done" ? event.count : 0),
    inFlight: [...inFlight],
  };
};

/**
 * A single left-to-right progress bar tracking scanned vs. outstanding
 * providers, with a running tally of resources to delete. While scanning, the
 * providers still in flight are listed below the bar so a slow/hanging
 * provider near the end is immediately identifiable. Per-provider detail is
 * printed to the console once scanning completes.
 */
function ScanProgress(props: {
  total: number;
  store: ProgressStore<ScanState>;
}): JSX.Element {
  const { total, store } = props;
  const { columns, rows } = useTerminalSize();
  const barWidth = Math.max(8, Math.min(32, columns - 30));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);

  const done = state.scanned >= total;
  const stragglers = state.inFlight.slice(
    0,
    Math.max(1, Math.min(10, rows - 8)),
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <ProgressBar
          value={total === 0 ? 1 : state.scanned / total}
          width={barWidth}
          variant={done ? "success" : "info"}
          showPercent={false}
        />
        <Text bold>
          {" "}
          {state.scanned}/{total}
        </Text>
        <Text tone="muted"> providers</Text>
        <Text tone="muted"> · </Text>
        <Text bold color={theme.color.warning}>
          {state.toDelete}
        </Text>
        <Text tone="muted"> to delete</Text>
      </Box>
      {!done && stragglers.length > 0 ? (
        <Box flexDirection="column" gap={1}>
          {stragglers.map((id) => (
            <Spinner key={id} label={<Text tone="muted">scanning {id}</Text>} />
          ))}
          {state.inFlight.length > stragglers.length ? (
            <Text tone="muted">
              {" "}
              …and {state.inFlight.length - stragglers.length} more
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export const renderScan = Effect.fn(function* (total: number) {
  const cli = yield* CliKit;
  const store = new ProgressStore<ScanState>({
    scanned: 0,
    toDelete: 0,
    inFlight: [],
  });
  const live = yield* cli.live.open(
    <ScanProgress total={total} store={store} />,
  );
  return {
    emit: (event: ScanEvent) =>
      store.update((state) => reduceScan(state, event)),
    close: live.close,
  };
});

// ---------------------------------------------------------------------------
// Delete phase
// ---------------------------------------------------------------------------

interface TypeProgress {
  total: number;
  deleted: number;
  failed: number;
}

interface DeleteState {
  pass: number;
  rows: ReadonlyMap<string, TypeProgress>;
}

const reduceDelete = (prev: DeleteState, event: DeleteEvent): DeleteState => {
  if (event.kind === "pass") {
    // reset transient per-pass failure counters at the start of a pass
    const next = new Map(prev.rows);
    for (const [id, row] of next) next.set(id, { ...row, failed: 0 });
    return { pass: event.pass, rows: next };
  }
  const row = prev.rows.get(event.id);
  if (!row) return prev;
  const next = new Map(prev.rows);
  next.set(
    event.id,
    event.kind === "deleted"
      ? { ...row, deleted: row.deleted + 1 }
      : { ...row, failed: row.failed + 1 },
  );
  return { ...prev, rows: next };
};

function DeleteProgress(props: {
  grandTotal: number;
  store: ProgressStore<DeleteState>;
}): JSX.Element {
  const { grandTotal, store } = props;
  const { columns } = useTerminalSize();
  const barWidth = Math.max(8, Math.min(32, columns - 30));
  const groupBarWidth = Math.max(6, Math.min(20, Math.floor(columns / 4)));
  const labelWidth = Math.max(12, Math.min(40, columns - groupBarWidth - 20));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);

  const { totalDeleted, sorted } = useMemo(() => {
    let totalDeleted = 0;
    const sorted = [...state.rows.entries()];
    for (const [, row] of sorted) totalDeleted += row.deleted;
    sorted.sort((a, b) => a[0].localeCompare(b[0]));
    return { totalDeleted, sorted };
  }, [state.rows]);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <ProgressBar
          value={grandTotal === 0 ? 1 : totalDeleted / grandTotal}
          width={barWidth}
          variant="error"
          showPercent={false}
        />
        <Text bold>
          {" "}
          {totalDeleted}/{grandTotal}
        </Text>
        <Text tone="muted"> deleted</Text>
        <Text tone="muted"> · pass {state.pass}</Text>
      </Box>
      <ProgressGroup
        width={groupBarWidth}
        labelWidth={labelWidth}
        rows={sorted.map(([id, row]) => ({
          id,
          label: id,
          completed: row.deleted,
          total: row.total,
          failed: row.failed,
        }))}
      />
    </Box>
  );
}

export const renderDelete = Effect.fn(function* (
  totals: { id: string; total: number }[],
) {
  const cli = yield* CliKit;
  const store = new ProgressStore<DeleteState>({
    pass: 1,
    rows: new Map(
      totals.map((t) => [t.id, { total: t.total, deleted: 0, failed: 0 }]),
    ),
  });
  const live = yield* cli.live.open(
    <DeleteProgress
      grandTotal={totals.reduce((a, b) => a + b.total, 0)}
      store={store}
    />,
  );
  return {
    emit: (event: DeleteEvent) =>
      store.update((state) => reduceDelete(state, event)),
    close: live.close,
  };
});
