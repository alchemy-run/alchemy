/**
 * Interactive opentui reporter — a k9s-style live view of the run.
 *
 * Layout:
 *   header  — run stats (pass/fail/running/queued, elapsed)
 *   list    — every test with a status glyph, navigable (j/k / arrows)
 *   detail  — Enter opens the selected test's error + captured output
 *   footer  — key hints
 *
 * Keys: j/k navigate · Enter detail · Esc back · f failures-only · q quit
 */
import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LogEntry } from "./Model.ts";
import {
  Reporter,
  type RunSummary,
  type TestEvent,
  type TestMeta,
  type TestResult,
} from "./Reporter.ts";

type Status = "queued" | "running" | "pass" | "fail" | "skip" | "todo";

interface Entry {
  readonly meta: TestMeta;
  status: Status;
  result?: TestResult;
  /** Cached Select label — recomputed only when status/result changes. */
  label: string;
}

const GLYPH: Record<Status, string> = {
  queued: "·",
  running: "◐",
  pass: "✓",
  fail: "✗",
  skip: "↓",
  todo: "○",
};

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs
    .map(
      (log) =>
        `[${log.time.toISOString().slice(11, 23)}] ${log.level.padEnd(5)} ${log.message}`,
    )
    .join("\n");

const entryLabel = (entry: Entry): string =>
  ` ${GLYPH[entry.status]} ${entry.meta.file} > ${entry.meta.titlePath.join(" > ")}` +
  (entry.result !== undefined && entry.status !== "queued"
    ? ` (${formatDuration(entry.result.durationMs)})`
    : "");

class TuiState {
  readonly entries: Array<Entry> = [];
  readonly byId = new Map<string, Entry>();
  readonly fileLogs = new Map<string, ReadonlyArray<LogEntry>>();
  failuresOnly = false;
  detailOpen = false;
  /** Index of the selected entry within the visible (filtered) list. */
  selectedIndex = 0;
  /** First visible-list index shown in the window. */
  topIndex = 0;
  summary: RunSummary | undefined;
  startedAt = Date.now();
  /** Collection progress — files are imported incrementally while earlier
   * files already execute. */
  collectTotal = 0;
  collectDone = 0;
  /** Test data changed — the list needs rebuilding on the next flush. */
  dirty = true;
  /** Counts kept incrementally — recomputing over 1000s of entries per flush
   * is wasteful. */
  readonly counts: Record<Status, number> = {
    queued: 0,
    running: 0,
    pass: 0,
    fail: 0,
    skip: 0,
    todo: 0,
  };

  upsert(meta: TestMeta, status: Status, result?: TestResult): void {
    let entry = this.byId.get(meta.id);
    if (entry === undefined) {
      entry = { meta, status, label: "" };
      this.byId.set(meta.id, entry);
      this.entries.push(entry);
    } else {
      this.counts[entry.status]--;
    }
    this.counts[status]++;
    entry.status = status;
    if (result !== undefined) entry.result = result;
    entry.label = entryLabel(entry);
    this.dirty = true;
  }

  visible(): Array<Entry> {
    return this.failuresOnly
      ? this.entries.filter((e) => e.status === "fail")
      : this.entries;
  }
}

interface Tui {
  readonly renderer: CliRenderer;
  readonly state: TuiState;
  readonly refresh: () => void;
  readonly quit: Promise<void>;
  readonly dispose: () => void;
}

const makeTui = async (): Promise<Tui> => {
  const state = new TuiState();
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  const header = new TextRenderable(renderer, {
    id: "header",
    content: "alchemy-test — collecting…",
    fg: "#c0caf5",
  });
  const headerBox = new BoxRenderable(renderer, {
    id: "header-box",
    width: "100%",
    height: 1,
    backgroundColor: "#1a1b26",
  });
  headerBox.add(header);

  // Windowed list: a fixed pool of Text rows (one per terminal line). Every
  // update touches only the visible window (~40 rows) — never the full list
  // of potentially thousands of tests. (SelectRenderable was tried first:
  // reassigning its options rebuilt internal state for EVERY row on every
  // flush, which stuttered badly on large runs.)
  const list = new BoxRenderable(renderer, {
    id: "list",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: "#16161e",
  });

  interface Row {
    readonly text: TextRenderable;
    /** Last-applied content/style — skip native calls when unchanged. */
    content: string;
    selected: boolean;
  }
  let rows: Array<Row> = [];

  const rebuildRowPool = (): void => {
    for (const row of rows) list.remove(row.text);
    rows = [];
    // header + footer occupy one line each.
    const count = Math.max(renderer.terminalHeight - 2, 1);
    for (let i = 0; i < count; i++) {
      const text = new TextRenderable(renderer, {
        id: `list-row-${i}`,
        width: "100%",
        height: 1,
        content: "",
        fg: "#787c99",
        bg: "#16161e",
      });
      rows.push({ text, content: "", selected: false });
      list.add(text);
    }
  };

  const detail = new ScrollBoxRenderable(renderer, {
    id: "detail",
    width: "100%",
    flexGrow: 1,
    visible: false,
    rootOptions: { backgroundColor: "#16161e" },
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail-text",
    content: "",
    fg: "#c0caf5",
  });
  detail.add(detailText);

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: " j/k navigate · enter detail · esc back · f failures · q quit",
    fg: "#565f89",
  });
  const footerBox = new BoxRenderable(renderer, {
    id: "footer-box",
    width: "100%",
    height: 1,
    backgroundColor: "#1a1b26",
  });
  footerBox.add(footer);

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  root.add(headerBox);
  root.add(list);
  root.add(detail);
  root.add(footerBox);
  renderer.root.add(root);
  rebuildRowPool();
  renderer.on(CliRenderEvents.RESIZE, () => {
    rebuildRowPool();
    renderList();
  });

  // Header updates are cheap (one Text content assignment) and decoupled
  // from list repaints: the header ticks while the run is live, the list
  // repaints only when test data actually changed or on navigation — and a
  // repaint only ever touches the visible window.
  const updateHeader = (): void => {
    const counts = state.counts;
    const elapsed = formatDuration(
      state.summary?.durationMs ?? Date.now() - state.startedAt,
    );
    const done = state.summary !== undefined;
    const collecting =
      !done && state.collectDone < state.collectTotal
        ? `  │ importing ${state.collectDone}/${state.collectTotal} files`
        : "";
    header.content =
      ` alchemy-test  ${GLYPH.pass} ${counts.pass}  ${GLYPH.fail} ${counts.fail}` +
      `  ${GLYPH.running} ${counts.running}  ${GLYPH.queued} ${counts.queued}` +
      (counts.skip > 0 ? `  ${GLYPH.skip} ${counts.skip}` : "") +
      `  │ ${elapsed}${collecting}${done ? "  │ DONE — press q to quit" : ""}` +
      (state.failuresOnly ? "  │ [failures only]" : "");
  };

  /**
   * Paint the visible window into the row pool. O(window): each row's
   * content/style is written only when it actually changed since the last
   * paint, so a steady list costs zero native calls.
   */
  const renderList = (): void => {
    if (state.detailOpen) return;
    const entries = state.visible();
    const max = Math.max(entries.length - 1, 0);
    state.selectedIndex = Math.min(state.selectedIndex, max);
    // Keep the selection inside the window.
    if (state.selectedIndex < state.topIndex) {
      state.topIndex = state.selectedIndex;
    } else if (state.selectedIndex >= state.topIndex + rows.length) {
      state.topIndex = state.selectedIndex - rows.length + 1;
    }
    state.topIndex = Math.max(
      0,
      Math.min(state.topIndex, Math.max(entries.length - rows.length, 0)),
    );

    const width = renderer.terminalWidth;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const entry = entries[state.topIndex + i];
      const isSelected =
        entry !== undefined && state.topIndex + i === state.selectedIndex;
      const content =
        entry === undefined
          ? ""
          : `${isSelected ? "▶" : " "}${entry.label}`.slice(0, width);
      if (row.content !== content) {
        row.content = content;
        row.text.content = content;
      }
      if (row.selected !== isSelected) {
        row.selected = isSelected;
        row.text.bg = isSelected ? "#283457" : "#16161e";
        row.text.fg = isSelected ? "#c0caf5" : "#787c99";
      }
    }
  };

  const moveSelection = (delta: number): void => {
    const entries = state.visible();
    if (entries.length === 0) return;
    state.selectedIndex = Math.max(
      0,
      Math.min(state.selectedIndex + delta, entries.length - 1),
    );
    renderList();
  };

  const refresh = (): void => {
    updateHeader();
    // Keep `dirty` set while the detail pane hides the list, so the pending
    // repaint happens when the list becomes visible again.
    if (state.dirty && !state.detailOpen) {
      state.dirty = false;
      renderList();
    }
  };

  const openDetail = (): void => {
    const entry = state.visible()[state.selectedIndex];
    if (entry === undefined) return;
    const { meta, result } = entry;
    const lines: Array<string> = [
      `${meta.file} > ${meta.titlePath.join(" > ")}`,
      `status: ${entry.status}${result !== undefined ? `  duration: ${formatDuration(result.durationMs)}  retries: ${result.retries}` : ""}`,
      "",
    ];
    if (result?.error !== undefined) {
      lines.push("── error ──", result.error, "");
    }
    if (result !== undefined && result.logs.length > 0) {
      lines.push("── captured output ──", formatLogs(result.logs), "");
    }
    const hookLogs = state.fileLogs.get(meta.file);
    if (hookLogs !== undefined && hookLogs.length > 0) {
      lines.push("── file hooks (deploy/destroy) ──", formatLogs(hookLogs));
    }
    detailText.content = lines.join("\n");
    state.detailOpen = true;
    list.visible = false;
    detail.visible = true;
    detail.focus();
  };

  const closeDetail = (): void => {
    state.detailOpen = false;
    detail.visible = false;
    list.visible = true;
    // Repaint the window (and apply anything that changed while hidden).
    renderList();
    refresh();
  };

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    switch (key.name) {
      case "q":
        resolveQuit();
        return;
      case "escape":
        if (state.detailOpen) closeDetail();
        return;
      case "return":
      case "enter":
        if (!state.detailOpen) openDetail();
        return;
      case "f":
        if (!state.detailOpen) {
          state.failuresOnly = !state.failuresOnly;
          state.selectedIndex = 0;
          state.topIndex = 0;
          state.dirty = true;
          refresh();
        }
        return;
    }
    if (state.detailOpen) return; // ScrollBox handles its own keys
    switch (key.name) {
      case "up":
      case "k":
        moveSelection(-1);
        return;
      case "down":
      case "j":
        moveSelection(1);
        return;
      case "pageup":
        moveSelection(-rows.length);
        return;
      case "pagedown":
        moveSelection(rows.length);
        return;
      case "home":
        moveSelection(-Number.MAX_SAFE_INTEGER);
        return;
      case "end":
        moveSelection(Number.MAX_SAFE_INTEGER);
        return;
    }
  });

  // Single flush loop: repaints the visible window at most 10x/s and ONLY
  // when test data changed; otherwise it just ticks the elapsed-time header
  // while the run is live. Once the run is done and nothing is dirty, this
  // does no rendering work at all.
  const interval = setInterval(() => {
    if (state.dirty) {
      refresh();
    } else if (state.summary === undefined) {
      updateHeader();
    }
  }, 100);

  const dispose = (): void => {
    clearInterval(interval);
    renderer.destroy();
  };

  return { renderer, state, refresh, quit, dispose };
};

const onEvent = (tui: Tui, event: TestEvent): void => {
  const { state } = tui;
  switch (event._tag) {
    case "CollectStart":
      state.collectTotal = event.files.length;
      break;
    case "RunStart":
      state.startedAt = Date.now();
      break;
    case "FileCollected":
      state.collectDone++;
      for (const meta of event.tests) state.upsert(meta, "queued");
      break;
    case "TestStart":
      state.upsert(event.test, "running");
      break;
    case "TestEnd":
      state.upsert(event.test, event.result.status, event.result);
      break;
    case "FileEnd":
      state.fileLogs.set(event.file, event.logs);
      if (event.error !== undefined) {
        // Surface import/hook failures as a synthetic failed entry.
        state.upsert(
          {
            id: `${event.file} > [file]`,
            file: event.file,
            titlePath: ["[file]"],
            name: "[file]",
          },
          "fail",
          {
            status: "fail",
            durationMs: 0,
            error: event.error,
            logs: event.logs,
            retries: 0,
          },
        );
      }
      break;
    case "RunEnd":
      state.summary = event.summary;
      // Final state should render immediately, not on the next tick.
      state.dirty = true;
      tui.refresh();
      return;
    default:
      break;
  }
  // Everything else just marks the state dirty; the flush interval batches
  // rebuilds (a burst of TestEnd events must not trigger a full Select
  // re-layout per event).
  state.dirty = true;
};

export const TuiReporterLive: Layer.Layer<Reporter> = Layer.effect(Reporter)(
  Effect.gen(function* () {
    const tui = yield* Effect.acquireRelease(Effect.promise(makeTui), (t) =>
      Effect.sync(() => t.dispose()),
    );
    return {
      emit: (event) => Effect.sync(() => onEvent(tui, event)),
      waitForExit: () => Effect.promise(() => tui.quit),
    };
  }),
);
