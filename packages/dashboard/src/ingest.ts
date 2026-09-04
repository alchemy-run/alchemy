/**
 * Dashboard transport — the ONLY code that talks to /api. Ingestion
 * mutates the store OUTSIDE React (see store.ts):
 *
 * - `connect(stage?)` opens the SSE stream; the first frame is a full
 *   snapshot, subsequent frames carry typed patch batches. A revision gap
 *   triggers a fresh /api/v2/document snapshot (backoff-guarded); a
 *   dropped connection reconnects with capped exponential backoff and
 *   naturally re-snapshots (every SSE connection starts snapshot-first).
 * - `loadDeployments` / `selectDeployment` drive the history overlay.
 * - `setTarget` reconnects with a new `(stack, stage)`, clearing that
 *   target's slices but KEEPING the position cache. The URL is the
 *   source of truth for the target (see route.ts); navigation drives
 *   this, not the other way round.
 */
import type {
  DocumentPatch,
  DocumentSnapshot,
} from "alchemy/Dashboard/Document";
import {
  DocumentPatchSchema,
  DocumentSnapshotSchema,
} from "alchemy/Dashboard/DocumentPatch";
import * as S from "effect/Schema";
import {
  applySnapshot,
  dashboardStore,
  ingestPatches,
  resetForTarget,
  setConnectionStatus,
  setDeployments,
  setHistoryError,
  setHistoryLoading,
  setSelectedDeployment,
  setStacks,
  type DeploymentRecord,
  type HistoricalProjections,
  type StackEntry,
} from "./store.ts";

/** The SSE `data:` payload union (mirrors the server's DocumentFrame). */
export type DocumentFrame =
  | { kind: "snapshot"; snapshot: DocumentSnapshot }
  | { kind: "patches"; patches: DocumentPatch[] };

const DocumentFrameSchema = S.Union([
  S.Struct({ kind: S.Literal("snapshot"), snapshot: DocumentSnapshotSchema }),
  S.Struct({
    kind: S.Literal("patches"),
    patches: S.Array(DocumentPatchSchema),
  }),
]);

const decodeFrame = S.decodeUnknownSync(DocumentFrameSchema);
const decodeSnapshot = S.decodeUnknownSync(DocumentSnapshotSchema);

/**
 * The `(stack, stage)` a view is pointed at. `undefined` on either side
 * means "whatever the server picks by default" — the CLI dashboard never
 * sends either, the hosted viewer sends both once a target is chosen.
 */
export interface Target {
  stack: string | undefined;
  stage: string | undefined;
}

const targetQuery = (target: Target): string => {
  const params = new URLSearchParams();
  if (target.stack !== undefined) {
    params.set("stack", target.stack);
  }
  if (target.stage !== undefined) {
    params.set("stage", target.stage);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
};

/** The target the store is currently pointed at. */
const currentTarget = (): Target => {
  const { stack, stage } = dashboardStore.getState().connection;
  return { stack, stage };
};

// ─────────────────────────────────────────────────────── connection state

let source: EventSource | undefined;
/** bumped on every connect/disconnect — stale async callbacks bail out */
let generation = 0;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let resnapshotting = false;
let lastResnapshotAt = 0;

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 4_000;
/** minimum spacing between gap-triggered snapshot re-fetches */
const RESNAPSHOT_SPACING_MS = 1_000;

/**
 * Open (or re-open) the live SSE stream for a stage. `undefined` stage =
 * the server's default stage.
 */
export const connect = (
  target: Target = { stack: undefined, stage: undefined },
): void => {
  generation += 1;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  source?.close();
  source = undefined;
  reconnectAttempt = 0;
  setConnectionStatus("connecting");
  open(generation, target);
};

export const disconnect = (): void => {
  generation += 1;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  source?.close();
  source = undefined;
};

const open = (gen: number, target: Target): void => {
  const es = new EventSource(`/api/v2/events${targetQuery(target)}`);
  source = es;
  es.onmessage = (message) => {
    if (gen !== generation) {
      return;
    }
    let frame: DocumentFrame;
    try {
      frame = decodeFrame(JSON.parse(message.data)) as DocumentFrame;
    } catch (error) {
      // a frame we can't decode means client/server version skew — a
      // fresh snapshot is the only safe recovery
      console.warn("dashboard: undecodable frame, re-snapshotting", error);
      void resnapshot(gen, target);
      return;
    }
    reconnectAttempt = 0;
    if (frame.kind === "snapshot") {
      applySnapshot(frame.snapshot);
      setConnectionStatus("live");
      return;
    }
    const result = ingestPatches(frame.patches);
    if (result.gap) {
      void resnapshot(gen, target);
    }
  };
  es.onerror = () => {
    if (gen !== generation) {
      return;
    }
    // self-managed reconnect (not the browser's): every new connection
    // is snapshot-first, so reconnecting re-syncs by construction
    es.close();
    setConnectionStatus("error");
    const delay = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (gen !== generation) {
        return;
      }
      setConnectionStatus("connecting");
      open(gen, target);
    }, delay);
  };
};

/**
 * Revision-gap recovery: re-fetch the full document snapshot. Spaced by
 * RESNAPSHOT_SPACING_MS so a misbehaving stream can't loop us into a
 * snapshot storm.
 */
const resnapshot = async (gen: number, target: Target): Promise<void> => {
  if (resnapshotting) {
    return;
  }
  resnapshotting = true;
  try {
    const wait = Math.max(
      0,
      lastResnapshotAt + RESNAPSHOT_SPACING_MS - Date.now(),
    );
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (gen !== generation) {
      return;
    }
    lastResnapshotAt = Date.now();
    const res = await fetch(`/api/v2/document${targetQuery(target)}`);
    if (!res.ok) {
      throw new Error(`/api/v2/document -> ${res.status}`);
    }
    const snapshot = decodeSnapshot(await res.json()) as DocumentSnapshot;
    if (gen !== generation) {
      return;
    }
    applySnapshot(snapshot);
    setConnectionStatus("live");
  } catch (error) {
    console.warn("dashboard: snapshot re-fetch failed", error);
    if (gen === generation) {
      setConnectionStatus("error");
    }
  } finally {
    resnapshotting = false;
  }
};

// ──────────────────────────────────────────────────────────── stage switch

/**
 * Switch stages: clear per-stage document/history slices (positions cache
 * survives — it's keyed by structuralHash), reconnect the SSE stream, and
 * refresh the deployment history for the new stage.
 */
export const setTarget = (target: Target): void => {
  resetForTarget(target);
  connect(target);
  void loadDeployments(target);
};

// ────────────────────────────────────────────────────────── stack catalog

/**
 * GET /api/stacks → every `(stack, stages)` in the state store. Only the
 * hosted viewer serves this; the CLI dashboard 404s it and simply keeps
 * an empty catalog, which hides the stack picker.
 */
export const loadStacks = async (): Promise<readonly StackEntry[]> => {
  try {
    const res = await fetch("/api/stacks");
    if (!res.ok) {
      return [];
    }
    const stacks = (await res.json()) as StackEntry[];
    setStacks(stacks);
    return stacks;
  } catch {
    // no catalog — the picker stays hidden, everything else still works
    return [];
  }
};

// ───────────────────────────────────────────────────── deployment history

/** GET /api/v2/deployments → the history slice (newest first). */
export const loadDeployments = async (target?: Target): Promise<void> => {
  const tgt = target ?? currentTarget();
  setHistoryLoading(true);
  try {
    const res = await fetch(`/api/v2/deployments${targetQuery(tgt)}`);
    if (res.status === 404) {
      // the state store has no deployment-history support
      setDeployments([]);
      return;
    }
    if (!res.ok) {
      throw new Error(`/api/v2/deployments -> ${res.status}`);
    }
    setDeployments((await res.json()) as DeploymentRecord[]);
  } catch (error) {
    setHistoryError(String(error));
  }
};

/**
 * Select a deployment version for the history overlay ("live" clears
 * it). The endpoint returns that version's journal folded over the
 * CURRENT structure, so the graph never moves while flipping history.
 */
export const selectDeployment = async (
  version: number | "live",
): Promise<void> => {
  if (version === "live") {
    setSelectedDeployment("live");
    return;
  }
  const tgt = currentTarget();
  setHistoryLoading(true);
  try {
    const res = await fetch(
      `/api/v2/deployments/${version}${targetQuery(tgt)}`,
    );
    if (!res.ok) {
      throw new Error(`/api/v2/deployments/${version} -> ${res.status}`);
    }
    const body = (await res.json()) as {
      record: DeploymentRecord;
      snapshot: unknown;
      projections: HistoricalProjections;
    };
    const snapshot = decodeSnapshot(body.snapshot) as DocumentSnapshot;
    setSelectedDeployment(version, body.record, snapshot, body.projections);
  } catch (error) {
    setHistoryError(String(error));
  }
};

// ──────────────────────────────────────────────────────────────── approval

/**
 * Decide the pending browser-side approval. The document's approval slice
 * carries the approval id; the resulting approval-clear patch arrives over
 * the live stream.
 */
export const decideApproval = async (approved: boolean): Promise<void> => {
  const id = dashboardStore.getState().document.approval?.id;
  if (id === undefined) {
    return;
  }
  try {
    await fetch("/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, approved }),
    });
  } catch (error) {
    console.warn("dashboard: approval decide failed", error);
  }
};
