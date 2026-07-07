/**
 * Dashboard v2 client store — ONE zustand vanilla store, mutated OUTSIDE
 * React by the SSE transport (`ingest.ts`), consumed via narrow
 * per-slice hooks so a decorate patch re-renders exactly the affected
 * node(s).
 *
 * Reactivity model: `applyPatch` (the shared client reducer from
 * `alchemy/Dashboard/DocumentPatch`) mutates the `DeploymentDocument`
 * in place. Zustand listeners fire on the single `setState` per ingested
 * batch; each hook's selector then decides re-rendering by identity.
 * Where the reducer replaces object identities (decorations, nodes,
 * deployment, approval, outputs) the identity IS the change signal.
 * Where it mutates arrays in place (timelines, feed, op spans) or
 * mutates `meta`, per-kind/per-fqn VERSION counters bump instead, and
 * the slice caches key on `(identity, version)` so unchanged slices
 * keep referential equality across batches.
 *
 * History overlay: selecting a past deployment overlays that version's
 * decorations/timelines/op-spans/feed/outputs while STRUCTURE always
 * comes from the live document — the graph physically cannot move when
 * flipping through history.
 */
import {
  fromSnapshot,
  makeDocument,
  type Decoration,
  type DeploymentDocument,
  type DocumentApproval,
  type DocumentMeta,
  type DocumentNode,
  type DocumentPatch,
  type DocumentSnapshot,
  type FeedEntry,
  type LiveDeploymentRecord,
  type OpSpan,
  type TimelineEntry,
} from "alchemy/Dashboard/Document";
import { applyPatch } from "alchemy/Dashboard/DocumentPatch";
import {
  annotationsOf,
  listGroupsOf,
  summaryOf,
  tableRowsOf,
  waterfallSpansOf,
  type AnnotationView,
  type ListGroupView,
  type SummaryView,
  type TableRowView,
  type WaterfallRowView,
} from "alchemy/Dashboard/Projections";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

// ─────────────────────────────────────────────────────────────────── types

/** A closed/open deployment record as returned by /api/v2/deployments. */
export type DeploymentRecord = Omit<LiveDeploymentRecord, "live">;

export type ViewKind = "canvas" | "summary" | "list";

export type ConnectionStatus = "connecting" | "live" | "error" | "superseded";

/** Server-computed projections for a historical deployment version. */
export interface HistoricalProjections {
  summary: SummaryView;
  tableRows: TableRowView[];
  waterfallSpans: WaterfallRowView[];
  annotations: AnnotationView[];
}

export interface XY {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Per-patch-kind change counters (see module doc). */
export interface DocVersions {
  structure: number;
  decorations: number;
  timelines: number;
  opSpans: number;
  feed: number;
  deployment: number;
  annotations: number;
  outputs: number;
  approval: number;
  meta: number;
}

export interface ConnectionSlice {
  status: ConnectionStatus;
  /** undefined = the server's default stage */
  stage: string | undefined;
  /** last document revision accepted from the wire */
  revision: number;
}

export interface HistorySlice {
  deployments: DeploymentRecord[];
  /** "live" = no overlay; a number = that deployment version is overlaid */
  selected: number | "live";
  selectedRecord?: LiveDeploymentRecord;
  selectedSnapshot?: DocumentSnapshot;
  selectedProjections?: HistoricalProjections;
  loading: boolean;
  error?: string;
}

export interface UiSlice {
  view: ViewKind;
  selectedFqn?: string;
  /** List-view filter (the canvas/graph is never filtered) */
  filter: string;
  /** command palette (⌘K) visibility */
  paletteOpen: boolean;
  feedExpanded: boolean;
  /** feed-dismissal key (e.g. String(deployment.version)) */
  dismissedSession?: string;
}

export interface LayoutSlice {
  /**
   * structuralHash → fqn → position, LRU-capped. Written by the Canvas
   * after each ELK layout; survives view switches AND stage switches.
   */
  positionsByHash: ReadonlyMap<string, ReadonlyMap<string, XY>>;
  /**
   * The user's own framing for the CURRENT stage. Only ever set by a real
   * user gesture (or restored from localStorage) — programmatic fits never
   * land here, so a saved viewport always means "the user chose this".
   */
  viewport?: Viewport;
  /** true once the user pans/zooms — fitView must never fire while set */
  userPanned: boolean;
  /** bump = explicit "Fit" request for the Canvas to consume */
  fitRequest: number;
  /**
   * Bumped when a persisted per-stage layout has been (re)loaded — the
   * Canvas consumes it to re-apply the restored viewport without
   * remounting.
   */
  restoredEpoch: number;
  /** every stage ever seen for this stack (persisted client-side) */
  stagesSeen: readonly string[];
}

export interface DashboardState {
  /** the live client mirror of the server's DeploymentDocument */
  document: DeploymentDocument;
  /** mirrors document.revision; bumped per ingested batch */
  revision: number;
  /** last snapshot's revision — the dedupe floor for incoming patches */
  baselineRevision: number;
  /** true once the first snapshot landed (false again on stage switch) */
  hydrated: boolean;
  versions: DocVersions;
  timelineVersions: Readonly<Record<string, number>>;
  opSpanVersions: Readonly<Record<string, number>>;
  connection: ConnectionSlice;
  history: HistorySlice;
  ui: UiSlice;
  layout: LayoutSlice;
}

// ─────────────────────────────────────────────────────────────────── store

const ZERO_VERSIONS: DocVersions = {
  structure: 0,
  decorations: 0,
  timelines: 0,
  opSpans: 0,
  feed: 0,
  deployment: 0,
  annotations: 0,
  outputs: 0,
  approval: 0,
  meta: 0,
};

const bumpAll = (v: DocVersions): DocVersions => ({
  structure: v.structure + 1,
  decorations: v.decorations + 1,
  timelines: v.timelines + 1,
  opSpans: v.opSpans + 1,
  feed: v.feed + 1,
  deployment: v.deployment + 1,
  annotations: v.annotations + 1,
  outputs: v.outputs + 1,
  approval: v.approval + 1,
  meta: v.meta + 1,
});

const initialHistory = (): HistorySlice => ({
  deployments: [],
  selected: "live",
  loading: false,
});

const initialState = (): DashboardState => ({
  document: makeDocument({ stack: "", stage: "" }),
  revision: 0,
  baselineRevision: 0,
  hydrated: false,
  versions: ZERO_VERSIONS,
  timelineVersions: {},
  opSpanVersions: {},
  connection: { status: "connecting", stage: undefined, revision: 0 },
  history: initialHistory(),
  // feedExpanded starts false: the ActivityFeed opens as a one-line pill
  ui: { view: "canvas", filter: "", paletteOpen: false, feedExpanded: false },
  layout: {
    positionsByHash: new Map(),
    userPanned: false,
    fitRequest: 0,
    restoredEpoch: 0,
    stagesSeen: [],
  },
});

export const dashboardStore = createStore<DashboardState>(initialState);

// ──────────────────────────────────────── per-stage layout persistence

/**
 * The user's framing survives reloads: viewport + pan latch + the position
 * cache are persisted per (stack, stage) in localStorage. Only USER
 * viewports are persisted (programmatic fits pass persist: false), so a
 * stage the user never touched keeps auto-fitting to center.
 */
// v2: bumped when layout geometry constants change (NODE_HEIGHT etc.) so
// stale cached positions don't resurrect a cramped layout after upgrade
const layoutKey = (stack: string, stage: string): string =>
  `alchemy-dashboard-layout.v2:${stack}:${stage}`;

const stagesKey = (stack: string): string =>
  `alchemy-dashboard-stages:${stack}`;

interface PersistedLayout {
  viewport?: Viewport;
  userPanned: boolean;
  positions: Record<string, Record<string, XY>>;
}

const currentScope = (): { stack: string; stage: string } | undefined => {
  const { document } = dashboardStore.getState();
  return document.meta.stack !== "" && document.meta.stage !== ""
    ? { stack: document.meta.stack, stage: document.meta.stage }
    : undefined;
};

const persistLayout = (): void => {
  const scope = currentScope();
  if (scope === undefined) {
    return;
  }
  const { layout } = dashboardStore.getState();
  const positions: PersistedLayout["positions"] = {};
  for (const [hash, byFqn] of layout.positionsByHash) {
    positions[hash] = Object.fromEntries(byFqn);
  }
  const persisted: PersistedLayout = {
    viewport: layout.viewport,
    userPanned: layout.userPanned,
    positions,
  };
  try {
    localStorage.setItem(
      layoutKey(scope.stack, scope.stage),
      JSON.stringify(persisted),
    );
  } catch {
    // storage full / private mode — layout just won't survive the reload
  }
};

const readPersistedLayout = (
  stack: string,
  stage: string,
): PersistedLayout | undefined => {
  try {
    const raw = localStorage.getItem(layoutKey(stack, stage));
    return raw === null ? undefined : (JSON.parse(raw) as PersistedLayout);
  } catch {
    return undefined;
  }
};

const readSeenStages = (stack: string): string[] => {
  try {
    const raw = localStorage.getItem(stagesKey(stack));
    const parsed = raw === null ? [] : (JSON.parse(raw) as string[]);
    return Array.isArray(parsed) ? parsed.filter((s) => s.length > 0) : [];
  } catch {
    return [];
  }
};

/** Union the given stages into the persisted + in-memory seen set. */
const rememberStages = (stack: string, stages: readonly string[]): void => {
  const state = dashboardStore.getState();
  const merged = [
    ...new Set([
      ...readSeenStages(stack),
      ...state.layout.stagesSeen,
      ...stages,
    ]),
  ].sort();
  try {
    localStorage.setItem(stagesKey(stack), JSON.stringify(merged));
  } catch {
    // best-effort
  }
  if (
    merged.length !== state.layout.stagesSeen.length ||
    merged.some((s, i) => s !== state.layout.stagesSeen[i])
  ) {
    dashboardStore.setState({
      layout: { ...dashboardStore.getState().layout, stagesSeen: merged },
    });
  }
};

/**
 * Load the persisted layout for a stage into the store (merging its
 * position cache) and bump `restoredEpoch` so the Canvas re-applies the
 * restored viewport.
 */
const restoreLayoutForStage = (stack: string, stage: string): void => {
  const persisted = readPersistedLayout(stack, stage);
  const state = dashboardStore.getState();
  const positionsByHash = new Map(state.layout.positionsByHash);
  if (persisted !== undefined) {
    for (const [hash, byFqn] of Object.entries(persisted.positions)) {
      if (!positionsByHash.has(hash)) {
        positionsByHash.set(hash, new Map(Object.entries(byFqn)));
      }
    }
  }
  dashboardStore.setState({
    layout: {
      ...state.layout,
      positionsByHash,
      viewport: persisted?.viewport,
      userPanned: persisted?.userPanned ?? false,
      restoredEpoch: state.layout.restoredEpoch + 1,
    },
  });
};

// ──────────────────────────────────────────────────────── document actions

export interface IngestResult {
  applied: number;
  skipped: number;
  /** true = a revision gap was hit; the transport must re-snapshot */
  gap: boolean;
}

/**
 * Fold a batch of wire patches into the live document. Wire protocol:
 * patches at or below the snapshot baseline (or below the current
 * revision) are duplicates → skipped; several patches may share ONE
 * revision (they came from one fold call) → all applied; a patch more
 * than one revision ahead is a GAP → stop and report so the transport
 * re-fetches a snapshot.
 */
export const ingestPatches = (
  patches: readonly DocumentPatch[],
): IngestResult => {
  const state = dashboardStore.getState();
  const doc = state.document;
  const result: IngestResult = { applied: 0, skipped: 0, gap: false };
  const versions = { ...state.versions };
  let timelineVersions: Record<string, number> | undefined;
  let opSpanVersions: Record<string, number> | undefined;

  for (const patch of patches) {
    if (
      patch.revision <= state.baselineRevision ||
      patch.revision < doc.revision
    ) {
      result.skipped += 1;
      continue;
    }
    if (patch.revision > doc.revision + 1) {
      result.gap = true;
      break;
    }
    applyPatch(doc, patch);
    result.applied += 1;
    switch (patch.kind) {
      case "structure-replace":
        versions.structure += 1;
        break;
      case "decorate":
        versions.decorations += 1;
        break;
      case "timeline-append":
        versions.timelines += 1;
        timelineVersions ??= { ...state.timelineVersions };
        timelineVersions[patch.fqn] = (timelineVersions[patch.fqn] ?? 0) + 1;
        break;
      case "feed-append":
        versions.feed += 1;
        break;
      case "op-span":
        versions.opSpans += 1;
        opSpanVersions ??= { ...state.opSpanVersions };
        opSpanVersions[patch.fqn] = (opSpanVersions[patch.fqn] ?? 0) + 1;
        break;
      case "deployment":
        versions.deployment += 1;
        break;
      case "deployment-reset":
        // op spans + annotations were cleared wholesale
        versions.opSpans += 1;
        versions.annotations += 1;
        opSpanVersions = {};
        break;
      case "annotation":
        versions.annotations += 1;
        break;
      case "outputs":
        versions.outputs += 1;
        break;
      case "approval-set":
      case "approval-clear":
        versions.approval += 1;
        break;
      case "meta":
        versions.meta += 1;
        break;
    }
  }

  if (result.applied === 0) {
    return result;
  }

  // carry-in fix from v1: never leave the Inspector pointed at a node
  // that a structure-replace retired
  let ui = state.ui;
  if (
    versions.structure !== state.versions.structure &&
    ui.selectedFqn !== undefined &&
    !doc.structure.nodes.has(ui.selectedFqn)
  ) {
    ui = { ...ui, selectedFqn: undefined };
  }

  dashboardStore.setState({
    revision: doc.revision,
    versions,
    ...(timelineVersions !== undefined ? { timelineVersions } : {}),
    ...(opSpanVersions !== undefined ? { opSpanVersions } : {}),
    connection: { ...state.connection, revision: doc.revision },
    ...(ui !== state.ui ? { ui } : {}),
  });
  return result;
};

/** Replace the live document from a full snapshot (connect / gap resync). */
export const applySnapshot = (snapshot: DocumentSnapshot): void => {
  const state = dashboardStore.getState();
  const doc = fromSnapshot(snapshot);
  const firstHydration = !state.hydrated;
  let ui = state.ui;
  if (
    ui.selectedFqn !== undefined &&
    !doc.structure.nodes.has(ui.selectedFqn)
  ) {
    ui = { ...ui, selectedFqn: undefined };
  }
  dashboardStore.setState({
    document: doc,
    revision: doc.revision,
    baselineRevision: snapshot.revision,
    hydrated: true,
    versions: bumpAll(state.versions),
    timelineVersions: {},
    opSpanVersions: {},
    connection: { ...state.connection, revision: doc.revision },
    ...(ui !== state.ui ? { ui } : {}),
  });
  if (doc.meta.stack !== "") {
    // every stage this client has ever seen stays in the picker, even if a
    // backend's listStages forgets one
    rememberStages(doc.meta.stack, [
      doc.meta.stage,
      ...(doc.meta.stages ?? []),
    ]);
    if (firstHydration && doc.meta.stage !== "") {
      restoreLayoutForStage(doc.meta.stack, doc.meta.stage);
    }
  }
};

/**
 * Stage switch: drop all per-stage document/history state but KEEP the
 * layout position cache (positions are keyed by structuralHash, so
 * returning to a stage restores its layout instantly) and the user's
 * view/filter preferences.
 */
export const resetForStage = (stage: string | undefined): void => {
  const state = dashboardStore.getState();
  clearSliceCaches();
  dashboardStore.setState({
    document: makeDocument({
      stack: state.document.meta.stack,
      stage: stage ?? "",
    }),
    revision: 0,
    baselineRevision: 0,
    hydrated: false,
    versions: bumpAll(state.versions),
    timelineVersions: {},
    opSpanVersions: {},
    connection: { status: "connecting", stage, revision: 0 },
    history: initialHistory(),
    ui: { ...state.ui, selectedFqn: undefined, dismissedSession: undefined },
    layout: { ...state.layout, viewport: undefined, userPanned: false },
  });
};

// ─────────────────────────────────────────────────────── connection actions

export const setConnectionStatus = (status: ConnectionStatus): void => {
  const state = dashboardStore.getState();
  if (state.connection.status === status) {
    return;
  }
  dashboardStore.setState({ connection: { ...state.connection, status } });
};

// ────────────────────────────────────────────────────────── history actions

export const setHistoryLoading = (loading: boolean): void => {
  const state = dashboardStore.getState();
  if (state.history.loading === loading) {
    return;
  }
  dashboardStore.setState({ history: { ...state.history, loading } });
};

export const setDeployments = (deployments: DeploymentRecord[]): void => {
  const state = dashboardStore.getState();
  const { error: _error, ...rest } = state.history;
  dashboardStore.setState({
    history: { ...rest, deployments, loading: false },
  });
};

export const setHistoryError = (error: string): void => {
  const state = dashboardStore.getState();
  dashboardStore.setState({
    history: { ...state.history, error, loading: false },
  });
};

export function setSelectedDeployment(selected: "live"): void;
export function setSelectedDeployment(
  selected: number,
  record: DeploymentRecord,
  snapshot: DocumentSnapshot,
  projections: HistoricalProjections,
): void;
export function setSelectedDeployment(
  selected: number | "live",
  record?: DeploymentRecord,
  snapshot?: DocumentSnapshot,
  projections?: HistoricalProjections,
): void {
  const state = dashboardStore.getState();
  const {
    selectedRecord: _r,
    selectedSnapshot: _s,
    selectedProjections: _p,
    error: _e,
    ...rest
  } = state.history;
  if (selected === "live") {
    dashboardStore.setState({
      history: { ...rest, selected: "live", loading: false },
    });
    return;
  }
  dashboardStore.setState({
    history: {
      ...rest,
      selected,
      ...(record !== undefined
        ? {
            selectedRecord: {
              ...record,
              live: record.endedAt === undefined,
            },
          }
        : {}),
      ...(snapshot !== undefined ? { selectedSnapshot: snapshot } : {}),
      ...(projections !== undefined
        ? { selectedProjections: projections }
        : {}),
      loading: false,
    },
  });
}

// ─────────────────────────────────────────────────────────────── ui actions

export const setView = (view: ViewKind): void => {
  const state = dashboardStore.getState();
  if (state.ui.view === view) {
    return;
  }
  dashboardStore.setState({ ui: { ...state.ui, view } });
};

export const setSelectedFqn = (fqn: string | undefined): void => {
  const state = dashboardStore.getState();
  if (state.ui.selectedFqn === fqn) {
    return;
  }
  const { selectedFqn: _f, ...rest } = state.ui;
  dashboardStore.setState({
    ui: fqn === undefined ? rest : { ...rest, selectedFqn: fqn },
  });
};

export const setFilter = (filter: string): void => {
  const state = dashboardStore.getState();
  if (state.ui.filter === filter) {
    return;
  }
  dashboardStore.setState({ ui: { ...state.ui, filter } });
};

export const setPaletteOpen = (paletteOpen: boolean): void => {
  const state = dashboardStore.getState();
  if (state.ui.paletteOpen === paletteOpen) {
    return;
  }
  dashboardStore.setState({ ui: { ...state.ui, paletteOpen } });
};

export const setFeedExpanded = (feedExpanded: boolean): void => {
  const state = dashboardStore.getState();
  if (state.ui.feedExpanded === feedExpanded) {
    return;
  }
  dashboardStore.setState({ ui: { ...state.ui, feedExpanded } });
};

export const dismissSession = (key: string | undefined): void => {
  const state = dashboardStore.getState();
  if (state.ui.dismissedSession === key) {
    return;
  }
  const { dismissedSession: _d, ...rest } = state.ui;
  dashboardStore.setState({
    ui: key === undefined ? rest : { ...rest, dismissedSession: key },
  });
};

// ─────────────────────────────────────────────────────────── layout actions

const POSITIONS_CACHE_CAP = 50;

/** Record ELK positions for a structural hash (LRU, cap 50). */
export const setPositions = (
  structuralHash: string,
  positions: ReadonlyMap<string, XY>,
): void => {
  const state = dashboardStore.getState();
  const next = new Map(state.layout.positionsByHash);
  next.delete(structuralHash);
  next.set(structuralHash, positions);
  while (next.size > POSITIONS_CACHE_CAP) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    next.delete(oldest);
  }
  dashboardStore.setState({
    layout: { ...state.layout, positionsByHash: next },
  });
  persistLayout();
};

/** Non-hook read (e.g. from the layout effect before kicking ELK). */
export const getPositions = (
  structuralHash: string,
): ReadonlyMap<string, XY> | undefined =>
  dashboardStore.getState().layout.positionsByHash.get(structuralHash);

/**
 * Record the viewport. Only USER gestures persist (and count as the
 * stage's chosen framing) — programmatic fits keep `persist: false` so an
 * untouched stage keeps auto-fitting to center forever.
 */
export const setViewport = (
  viewport: Viewport,
  options?: { persist?: boolean },
): void => {
  const state = dashboardStore.getState();
  dashboardStore.setState({ layout: { ...state.layout, viewport } });
  if (options?.persist !== false) {
    persistLayout();
  }
};

export const setUserPanned = (userPanned: boolean): void => {
  const state = dashboardStore.getState();
  if (state.layout.userPanned === userPanned) {
    return;
  }
  dashboardStore.setState({ layout: { ...state.layout, userPanned } });
  persistLayout();
};

/** Explicit Fit button: bump fitRequest and re-arm auto-fit. */
export const requestFit = (): void => {
  const state = dashboardStore.getState();
  dashboardStore.setState({
    layout: {
      ...state.layout,
      fitRequest: state.layout.fitRequest + 1,
      userPanned: false,
      // an explicit Fit discards the stage's saved framing — the fitted
      // view becomes the new baseline
      viewport: undefined,
    },
  });
  persistLayout();
};

// ──────────────────────────────────────────────── selectors (pure, cached)

/** The historical overlay snapshot, when a past deployment is selected. */
const overlayOf = (s: DashboardState): DocumentSnapshot | undefined =>
  s.history.selected !== "live" ? s.history.selectedSnapshot : undefined;

export interface NodeSlice {
  /** structural node — ALWAYS from the live document */
  node: DocumentNode | undefined;
  /** live decoration, or the selected deployment's when history is open */
  decoration: Decoration | undefined;
}

const nodeSliceCache = new Map<string, NodeSlice>();

export const selectNode = (s: DashboardState, fqn: string): NodeSlice => {
  const node = s.document.structure.nodes.get(fqn);
  const overlay = overlayOf(s);
  const decoration =
    overlay !== undefined
      ? overlay.decorations[fqn]
      : s.document.decorations.get(fqn);
  const cached = nodeSliceCache.get(fqn);
  if (
    cached !== undefined &&
    cached.node === node &&
    cached.decoration === decoration
  ) {
    return cached;
  }
  const slice: NodeSlice = { node, decoration };
  nodeSliceCache.set(fqn, slice);
  return slice;
};

export interface TimelineSlice {
  entries: readonly TimelineEntry[];
  /** bumps on every append/reset (in-place array mutation is invisible) */
  version: number;
}

const EMPTY_TIMELINE: readonly TimelineEntry[] = [];
const timelineSliceCache = new Map<string, TimelineSlice>();

export const selectTimeline = (
  s: DashboardState,
  fqn: string,
): TimelineSlice => {
  const overlay = overlayOf(s);
  const entries =
    (overlay !== undefined
      ? overlay.timelines[fqn]
      : s.document.timelines.get(fqn)) ?? EMPTY_TIMELINE;
  const version = overlay !== undefined ? -1 : (s.timelineVersions[fqn] ?? 0);
  const cached = timelineSliceCache.get(fqn);
  if (
    cached !== undefined &&
    cached.entries === entries &&
    cached.version === version
  ) {
    return cached;
  }
  const slice: TimelineSlice = { entries, version };
  timelineSliceCache.set(fqn, slice);
  return slice;
};

export interface OpSpanSlice {
  spans: readonly OpSpan[];
  version: number;
}

const EMPTY_SPANS: readonly OpSpan[] = [];
const opSpanSliceCache = new Map<string, OpSpanSlice>();

export const selectOpSpans = (s: DashboardState, fqn: string): OpSpanSlice => {
  const overlay = overlayOf(s);
  const spans =
    (overlay !== undefined
      ? overlay.opSpans[fqn]
      : s.document.opSpans.get(fqn)) ?? EMPTY_SPANS;
  const version = overlay !== undefined ? -1 : (s.opSpanVersions[fqn] ?? 0);
  const cached = opSpanSliceCache.get(fqn);
  if (
    cached !== undefined &&
    cached.spans === spans &&
    cached.version === version
  ) {
    return cached;
  }
  const slice: OpSpanSlice = { spans, version };
  opSpanSliceCache.set(fqn, slice);
  return slice;
};

export interface FeedSlice {
  entries: readonly FeedEntry[];
  version: number;
}

const EMPTY_FEED: readonly FeedEntry[] = [];
let feedSliceCache: FeedSlice | undefined;

export const selectFeed = (s: DashboardState): FeedSlice => {
  const overlay = overlayOf(s);
  const entries =
    (overlay !== undefined ? overlay.feed : s.document.feed) ?? EMPTY_FEED;
  const version = overlay !== undefined ? -1 : s.versions.feed;
  if (
    feedSliceCache !== undefined &&
    feedSliceCache.entries === entries &&
    feedSliceCache.version === version
  ) {
    return feedSliceCache;
  }
  feedSliceCache = { entries, version };
  return feedSliceCache;
};

let metaSliceCache:
  | { doc: DeploymentDocument; version: number; value: DocumentMeta }
  | undefined;

/** Stack/stage/stages — always live (meta patches mutate in place). */
export const selectMeta = (s: DashboardState): DocumentMeta => {
  if (
    metaSliceCache !== undefined &&
    metaSliceCache.doc === s.document &&
    metaSliceCache.version === s.versions.meta
  ) {
    return metaSliceCache.value;
  }
  const m = s.document.meta;
  const value: DocumentMeta = {
    stack: m.stack,
    stage: m.stage,
    ...(m.stages !== undefined ? { stages: [...m.stages] } : {}),
  };
  metaSliceCache = { doc: s.document, version: s.versions.meta, value };
  return value;
};

export const selectDeploymentRecord = (
  s: DashboardState,
): LiveDeploymentRecord | undefined => {
  const overlay = overlayOf(s);
  if (overlay !== undefined) {
    return overlay.deployment ?? s.history.selectedRecord;
  }
  return s.document.deployment;
};

export const selectApproval = (
  s: DashboardState,
): DocumentApproval | undefined => s.document.approval;

export const selectOutputs = (s: DashboardState): unknown => {
  const overlay = overlayOf(s);
  return overlay !== undefined ? overlay.outputs : s.document.outputs;
};

export const selectStructuralHash = (s: DashboardState): string =>
  s.document.structure.structuralHash;

export const isSelected = (s: DashboardState, fqn: string): boolean =>
  s.ui.selectedFqn === fqn;

const nodeMatchesFilter = (
  node: DocumentNode | undefined,
  query: string,
): boolean => {
  if (node === undefined) {
    return false;
  }
  return (
    node.fqn.toLowerCase().includes(query) ||
    node.type.toLowerCase().includes(query)
  );
};

/**
 * Filter dimming — decoration only, by design: the filter NEVER changes
 * the ELK input, positions, or viewport.
 */
export const isDimmed = (s: DashboardState, fqn: string): boolean => {
  const query = s.ui.filter.trim().toLowerCase();
  if (query === "") {
    return false;
  }
  return !nodeMatchesFilter(s.document.structure.nodes.get(fqn), query);
};

export interface FilterCounts {
  shown: number;
  total: number;
}

let filterCountsCache:
  | {
      doc: DeploymentDocument;
      structure: number;
      filter: string;
      value: FilterCounts;
    }
  | undefined;

export const selectFilterCounts = (s: DashboardState): FilterCounts => {
  if (
    filterCountsCache !== undefined &&
    filterCountsCache.doc === s.document &&
    filterCountsCache.structure === s.versions.structure &&
    filterCountsCache.filter === s.ui.filter
  ) {
    return filterCountsCache.value;
  }
  const nodes = s.document.structure.nodes;
  const query = s.ui.filter.trim().toLowerCase();
  let shown = 0;
  if (query === "") {
    shown = nodes.size;
  } else {
    for (const node of nodes.values()) {
      if (nodeMatchesFilter(node, query)) {
        shown += 1;
      }
    }
  }
  const value: FilterCounts = { shown, total: nodes.size };
  filterCountsCache = {
    doc: s.document,
    structure: s.versions.structure,
    filter: s.ui.filter,
    value,
  };
  return value;
};

// ──────────────────────────────────────────────────────────── projections

export interface ProjectionData {
  summary: SummaryView;
  list: ListGroupView[];
  table: TableRowView[];
  waterfall: WaterfallRowView[];
  annotations: AnnotationView[];
}

export type ProjectionView = keyof ProjectionData;

const computeProjection = <V extends ProjectionView>(
  doc: DeploymentDocument,
  view: V,
): ProjectionData[V] => {
  switch (view) {
    case "summary":
      return summaryOf(doc) as ProjectionData[V];
    case "list":
      return listGroupsOf(doc) as ProjectionData[V];
    case "table":
      return tableRowsOf(doc) as ProjectionData[V];
    case "waterfall":
      return waterfallSpansOf(doc) as ProjectionData[V];
    default:
      return annotationsOf(doc) as ProjectionData[V];
  }
};

const liveProjectionCache = new Map<
  ProjectionView,
  { doc: DeploymentDocument; revision: number; value: unknown }
>();
const histProjectionCache = new Map<
  ProjectionView,
  { snapshot: DocumentSnapshot; value: unknown }
>();
let histDocCache:
  | { snapshot: DocumentSnapshot; doc: DeploymentDocument }
  | undefined;

/**
 * The view projections: pure functions of the live document (memoized on
 * revision) or the server-computed projections of the selected
 * historical deployment. Stable references — safe as selector output.
 */
export const selectProjection = <V extends ProjectionView>(
  s: DashboardState,
  view: V,
): ProjectionData[V] => {
  const overlay = overlayOf(s);
  if (overlay !== undefined) {
    const projections = s.history.selectedProjections;
    if (projections !== undefined) {
      switch (view) {
        case "summary":
          return projections.summary as ProjectionData[V];
        case "table":
          return projections.tableRows as ProjectionData[V];
        case "waterfall":
          return projections.waterfallSpans as ProjectionData[V];
        case "annotations":
          return projections.annotations as ProjectionData[V];
        default:
          break; // "list" is not server-computed — fall through
      }
    }
    const cached = histProjectionCache.get(view);
    if (cached !== undefined && cached.snapshot === overlay) {
      return cached.value as ProjectionData[V];
    }
    if (histDocCache === undefined || histDocCache.snapshot !== overlay) {
      histDocCache = { snapshot: overlay, doc: fromSnapshot(overlay) };
    }
    const value = computeProjection(histDocCache.doc, view);
    histProjectionCache.set(view, { snapshot: overlay, value });
    return value;
  }
  const cached = liveProjectionCache.get(view);
  if (
    cached !== undefined &&
    cached.doc === s.document &&
    cached.revision === s.revision
  ) {
    return cached.value as ProjectionData[V];
  }
  const value = computeProjection(s.document, view);
  liveProjectionCache.set(view, {
    doc: s.document,
    revision: s.revision,
    value,
  });
  return value;
};

const clearSliceCaches = (): void => {
  nodeSliceCache.clear();
  timelineSliceCache.clear();
  opSpanSliceCache.clear();
  feedSliceCache = undefined;
  metaSliceCache = undefined;
  filterCountsCache = undefined;
  liveProjectionCache.clear();
  histProjectionCache.clear();
  histDocCache = undefined;
};

// ─────────────────────────────────────────────────────────────────── hooks

export const useNode = (fqn: string): NodeSlice =>
  useStore(dashboardStore, (s) => selectNode(s, fqn));

export const useTimeline = (fqn: string): TimelineSlice =>
  useStore(dashboardStore, (s) => selectTimeline(s, fqn));

export const useOpSpans = (fqn: string): OpSpanSlice =>
  useStore(dashboardStore, (s) => selectOpSpans(s, fqn));

export const useFeed = (): FeedSlice => useStore(dashboardStore, selectFeed);

export const useMeta = (): DocumentMeta => useStore(dashboardStore, selectMeta);

/**
 * Just the live flag — a stable boolean, so per-node subscribers don't
 * re-render on heartbeat-driven record identity changes.
 */
export const useDeploymentLive = (): boolean =>
  useStore(dashboardStore, (s) => s.document.deployment?.live === true);

/** startedAt of the newest deployment record (stable number). */
export const useDeploymentStartedAt = (): number | undefined =>
  useStore(dashboardStore, (s) => s.document.deployment?.startedAt);

export const useDeployment = (): LiveDeploymentRecord | undefined =>
  useStore(dashboardStore, selectDeploymentRecord);

export const useApproval = (): DocumentApproval | undefined =>
  useStore(dashboardStore, selectApproval);

export const useOutputs = (): unknown =>
  useStore(dashboardStore, selectOutputs);

export const useStructuralHash = (): string =>
  useStore(dashboardStore, selectStructuralHash);

export const useRevision = (): number =>
  useStore(dashboardStore, (s) => s.revision);

export const useHydrated = (): boolean =>
  useStore(dashboardStore, (s) => s.hydrated);

export const useConnection = (): ConnectionSlice =>
  useStore(dashboardStore, (s) => s.connection);

export const useHistory = (): HistorySlice =>
  useStore(dashboardStore, (s) => s.history);

export const useIsSelected = (fqn: string): boolean =>
  useStore(dashboardStore, (s) => isSelected(s, fqn));

export const useIsDimmed = (fqn: string): boolean =>
  useStore(dashboardStore, (s) => isDimmed(s, fqn));

export const useFilterCounts = (): FilterCounts =>
  useStore(dashboardStore, selectFilterCounts);

export const useView = (): ViewKind =>
  useStore(dashboardStore, (s) => s.ui.view);

export const useSelectedFqn = (): string | undefined =>
  useStore(dashboardStore, (s) => s.ui.selectedFqn);

export const useFilter = (): string =>
  useStore(dashboardStore, (s) => s.ui.filter);

export const usePaletteOpen = (): boolean =>
  useStore(dashboardStore, (s) => s.ui.paletteOpen);

export const useFeedExpanded = (): boolean =>
  useStore(dashboardStore, (s) => s.ui.feedExpanded);

export const useDismissedSession = (): string | undefined =>
  useStore(dashboardStore, (s) => s.ui.dismissedSession);

export const usePositions = (
  structuralHash: string | undefined,
): ReadonlyMap<string, XY> | undefined =>
  useStore(dashboardStore, (s) =>
    structuralHash === undefined
      ? undefined
      : s.layout.positionsByHash.get(structuralHash),
  );

export const useViewport = (): Viewport | undefined =>
  useStore(dashboardStore, (s) => s.layout.viewport);

export const useUserPanned = (): boolean =>
  useStore(dashboardStore, (s) => s.layout.userPanned);

export const useFitRequest = (): number =>
  useStore(dashboardStore, (s) => s.layout.fitRequest);

export const useRestoredEpoch = (): number =>
  useStore(dashboardStore, (s) => s.layout.restoredEpoch);

/** Every stage this client has ever seen for the stack (persisted). */
export const useSeenStages = (): readonly string[] =>
  useStore(dashboardStore, (s) => s.layout.stagesSeen);

export const useProjection = <V extends ProjectionView>(
  view: V,
): ProjectionData[V] =>
  useStore(dashboardStore, (s) => selectProjection(s, view));
