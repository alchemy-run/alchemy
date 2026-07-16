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
  createCliRenderer,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
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

  const list = new SelectRenderable(renderer, {
    id: "list",
    width: "100%",
    flexGrow: 1,
    options: [],
    showDescription: false,
    showScrollIndicator: true,
    backgroundColor: "#16161e",
    selectedBackgroundColor: "#283457",
    selectedTextColor: "#c0caf5",
    textColor: "#787c99",
  });

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
  list.focus();

  // Header updates are cheap (one Text content assignment); rebuilding the
  // Select's options array is NOT (full re-layout of the list). They are
  // deliberately decoupled: the header ticks while the run is live, the list
  // rebuilds only when test data actually changed — never on a timer and
  // never in response to plain navigation keystrokes.
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

  const rebuildList = (): void => {
    // The list is hidden while the detail pane is open; rebuilding it there
    // is wasted work. `closeDetail` flushes any pending rebuild.
    if (state.detailOpen) return;
    const selected = list.getSelectedIndex();
    list.options = state.visible().map((entry) => ({
      name: entry.label,
      description: "",
      value: entry.meta.id,
    }));
    // Restore the selection the options setter may have reset, clamped in
    // case the failures filter shrank the list. Rebuilds only happen when
    // test data changes, so this never fights arrow-key navigation.
    const max = Math.max(list.options.length - 1, 0);
    if (selected >= 0) {
      list.setSelectedIndex(Math.min(selected, max));
    }
  };

  const refresh = (): void => {
    updateHeader();
    // Keep `dirty` set while the detail pane hides the list, so the pending
    // rebuild happens when the list becomes visible again.
    if (state.dirty && !state.detailOpen) {
      state.dirty = false;
      rebuildList();
    }
  };

  const openDetail = (): void => {
    const option = list.getSelectedOption();
    if (option === null || option === undefined) return;
    const entry = state.byId.get(option.value as string);
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
    list.focus();
    // Apply any rebuild that was skipped while the detail pane was open.
    refresh();
  };

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  list.on(SelectRenderableEvents.ITEM_SELECTED, () => openDetail());

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
          state.dirty = true;
          refresh();
        }
        return;
    }
  });

  // Single flush loop: rebuilds the list at most 10x/s and ONLY when test
  // data changed; otherwise it just ticks the elapsed-time header while the
  // run is live. Once the run is done and nothing is dirty, this does no
  // rendering work at all — arrow-key navigation is handled entirely by the
  // Select and stays smooth.
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
