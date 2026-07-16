/**
 * Interactive opentui reporter — a k9s-style live view of the run.
 *
 * Layout:
 *   header  — run stats (pass/fail/running/queued, elapsed, import progress)
 *   list    — files with their tests nested inside; failing files auto-expand
 *   detail  — Enter on a test opens its error + captured output
 *   footer  — key hints / filter input
 *
 * Keys (vim-style):
 *   j/k or arrows  move one line       space / ^d ^u / ^f ^b   page / half page
 *   gg / G         top / bottom        /        type-to-filter
 *   enter          open test / toggle  h / l    collapse / expand file
 *   esc            back / clear filter f        failures only
 *   y              copy error+output   q        quit
 *
 * Mouse: the wheel scrolls the viewable content without moving the selected
 * line (keyboard navigation re-attaches the viewport to the selection);
 * clicking a row selects it. Use `y` to copy, or the terminal's tracking
 * bypass (Shift/Option + drag) for native text selection.
 *
 * Performance: the list is a fixed pool of Text rows (one per terminal
 * line) painted from the visible window only — updates are O(window), never
 * O(total tests).
 */
import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
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

const GLYPH: Record<Status, string> = {
  queued: "·",
  running: "◐",
  pass: "✓",
  fail: "✗",
  skip: "↓",
  todo: "○",
};

const COLOR = {
  text: "#787c99",
  bright: "#c0caf5",
  pass: "#9ece6a",
  fail: "#f7768e",
  running: "#e0af68",
  dim: "#565f89",
  bgRow: "#16161e",
  bgSelected: "#283457",
  bgChrome: "#1a1b26",
} as const;

const statusColor = (status: Status): string => {
  switch (status) {
    case "pass":
      return COLOR.pass;
    case "fail":
      return COLOR.fail;
    case "running":
      return COLOR.running;
    case "queued":
      return COLOR.text;
    case "skip":
    case "todo":
      return COLOR.dim;
  }
};

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

// Captured output is replayed verbatim (no timestamp/level prefixes).
const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

// ---------------------------------------------------------------------------
// Model: files with nested tests
// ---------------------------------------------------------------------------

interface Entry {
  readonly meta: TestMeta;
  readonly file: FileNode;
  status: Status;
  result?: TestResult;
  /** Cached row label — recomputed only when status/result changes. */
  label: string;
}

interface FileNode {
  readonly file: string;
  readonly tests: Array<Entry>;
  readonly counts: Record<Status, number>;
  /** Manual expand/collapse override; `undefined` = automatic. */
  expanded: boolean | undefined;
  label: string;
}

type Node =
  | { readonly kind: "file"; readonly node: FileNode }
  | { readonly kind: "test"; readonly entry: Entry };

const makeCounts = (): Record<Status, number> => ({
  queued: 0,
  running: 0,
  pass: 0,
  fail: 0,
  skip: 0,
  todo: 0,
});

const entryLabel = (entry: Entry): string =>
  `    ${GLYPH[entry.status]} ${entry.meta.titlePath.join(" > ")}` +
  (entry.result !== undefined && entry.status !== "queued"
    ? ` (${formatDuration(entry.result.durationMs)})`
    : "");

const fileLabel = (node: FileNode, expanded: boolean): string => {
  const c = node.counts;
  const parts = [
    ...(c.fail > 0 ? [`${c.fail} failed`] : []),
    ...(c.running > 0 ? [`${c.running} running`] : []),
    `${c.pass}/${node.tests.length - c.skip - c.todo} passed`,
    ...(c.skip > 0 ? [`${c.skip} skipped`] : []),
  ];
  const glyph =
    c.fail > 0
      ? GLYPH.fail
      : c.running > 0
        ? GLYPH.running
        : c.queued > 0
          ? GLYPH.queued
          : GLYPH.pass;
  return ` ${expanded ? "▾" : "▸"} ${glyph} ${node.file}  ${parts.join(" · ")}`;
};

const fileStatus = (node: FileNode): Status => {
  const c = node.counts;
  if (c.fail > 0) return "fail";
  if (c.running > 0) return "running";
  if (c.queued > 0) return "queued";
  if (c.pass > 0) return "pass";
  return "skip";
};

class TuiState {
  readonly byId = new Map<string, Entry>();
  readonly files = new Map<string, FileNode>();
  readonly fileOrder: Array<FileNode> = [];
  readonly fileLogs = new Map<string, ReadonlyArray<LogEntry>>();
  failuresOnly = false;
  /** Active filter query ("" = none). */
  filter = "";
  /** True while the footer is capturing filter keystrokes. */
  filterInput = false;
  detailOpen = false;
  selectedIndex = 0;
  topIndex = 0;
  /**
   * When true the viewport tracks the selection (keyboard navigation).
   * Mouse-wheel scrolling detaches it so the wheel moves the viewable
   * content without touching the selected line; the next keyboard move
   * re-attaches.
   */
  viewportFollows = true;
  summary: RunSummary | undefined;
  startedAt = Date.now();
  collectTotal = 0;
  collectDone = 0;
  dirty = true;
  readonly counts = makeCounts();

  fileNode(file: string): FileNode {
    let node = this.files.get(file);
    if (node === undefined) {
      node = {
        file,
        tests: [],
        counts: makeCounts(),
        expanded: undefined,
        label: "",
      };
      this.files.set(file, node);
      this.fileOrder.push(node);
    }
    return node;
  }

  upsert(meta: TestMeta, status: Status, result?: TestResult): void {
    let entry = this.byId.get(meta.id);
    if (entry === undefined) {
      const file = this.fileNode(meta.file);
      entry = { meta, file, status, label: "" };
      this.byId.set(meta.id, entry);
      file.tests.push(entry);
    } else {
      this.counts[entry.status]--;
      entry.file.counts[entry.status]--;
    }
    this.counts[status]++;
    entry.file.counts[status]++;
    entry.status = status;
    if (result !== undefined) entry.result = result;
    entry.label = entryLabel(entry);
    this.dirty = true;
  }

  private matches(entry: Entry): boolean {
    if (this.failuresOnly && entry.status !== "fail") return false;
    if (this.filter === "") return true;
    const haystack =
      `${entry.meta.file} ${entry.meta.titlePath.join(" ")}`.toLowerCase();
    // Every whitespace-separated word must match somewhere (AND semantics).
    return this.filter
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "")
      .every((word) => haystack.includes(word));
  }

  isExpanded(node: FileNode): boolean {
    if (node.expanded !== undefined) return node.expanded;
    // Auto: expand while filtering (matches should be visible) and when the
    // file has failures.
    return this.filter !== "" || node.counts.fail > 0;
  }

  /** Flattened visible tree: file rows with expanded tests nested inside. */
  visible(): Array<Node> {
    const out: Array<Node> = [];
    for (const node of this.fileOrder) {
      const tests = node.tests.filter((t) => this.matches(t));
      if (tests.length === 0) continue;
      const expanded = this.isExpanded(node);
      node.label = fileLabel(node, expanded);
      out.push({ kind: "file", node });
      if (expanded) {
        for (const entry of tests) out.push({ kind: "test", entry });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** OSC52 first (works over ssh in modern terminals), then a system tool. */
const copyToClipboard = (renderer: CliRenderer, text: string): boolean => {
  let copied = false;
  try {
    copied = renderer.copyToClipboardOSC52(text);
  } catch {
    copied = false;
  }
  try {
    const cmd =
      process.platform === "darwin"
        ? ["pbcopy"]
        : process.platform === "win32"
          ? ["clip"]
          : ["xclip", "-selection", "clipboard"];
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(text);
    proc.stdin.end();
    copied = true;
  } catch {
    // no system clipboard tool — OSC52 result stands
  }
  return copied;
};

const detailContent = (state: TuiState, entry: Entry): string => {
  const { meta, result } = entry;
  const lines: Array<string> = [
    `${meta.file} > ${meta.titlePath.join(" > ")}`,
    `status: ${entry.status}${
      result !== undefined
        ? `  duration: ${formatDuration(result.durationMs)}  retries: ${result.retries}`
        : ""
    }`,
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
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

interface Tui {
  readonly renderer: CliRenderer;
  readonly state: TuiState;
  readonly refresh: () => void;
  readonly quit: Promise<void>;
  readonly dispose: () => void;
}

const FOOTER_HINTS =
  " j/k move · space/^d/^u page · gg/G · / filter · enter open · h/l fold · f failures · y copy · q quit";

const makeTui = async (): Promise<Tui> => {
  const state = new TuiState();
  /** True once the renderer is torn down — no further writes are allowed. */
  let disposed = false;
  // Mouse tracking is enabled for wheel-scrolling and click-to-select.
  // Text can still be copied with `y` (test details) or with the terminal's
  // tracking bypass (Shift/Option + drag in most terminals).
  //
  // Ctrl+C is handled by US (exitOnCtrlC: false): opentui's built-in handler
  // destroys the renderer while our flush timer may still be queued, which
  // crashed with "TextBuffer is destroyed". We dispose first, then exit.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

  const header = new TextRenderable(renderer, {
    id: "header",
    content: "alchemy-test — collecting…",
    fg: COLOR.bright,
  });
  const headerBox = new BoxRenderable(renderer, {
    id: "header-box",
    width: "100%",
    height: 1,
    backgroundColor: COLOR.bgChrome,
  });
  headerBox.add(header);

  const list = new BoxRenderable(renderer, {
    id: "list",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: COLOR.bgRow,
  });

  interface Row {
    readonly text: TextRenderable;
    content: string;
    fg: string;
    bg: string;
  }
  let rows: Array<Row> = [];

  const rebuildRowPool = (): void => {
    for (const row of rows) list.remove(row.text);
    rows = [];
    const count = Math.max(renderer.terminalHeight - 2, 1);
    for (let i = 0; i < count; i++) {
      const index = i;
      const text = new TextRenderable(renderer, {
        id: `list-row-${i}`,
        width: "100%",
        height: 1,
        content: "",
        fg: COLOR.text,
        bg: COLOR.bgRow,
        // Wheel scrolls the viewable content without moving the selection;
        // a click selects the row under the cursor.
        onMouse: (event: MouseEvent) => {
          if (event.type === "scroll" && event.scroll !== undefined) {
            scrollViewport(event.scroll.direction === "up" ? -3 : 3);
          }
        },
        onMouseDown: () => selectRow(index),
      });
      rows.push({ text, content: "", fg: COLOR.text, bg: COLOR.bgRow });
      list.add(text);
    }
  };

  const detail = new ScrollBoxRenderable(renderer, {
    id: "detail",
    width: "100%",
    flexGrow: 1,
    visible: false,
    rootOptions: { backgroundColor: COLOR.bgRow },
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail-text",
    content: "",
    fg: COLOR.bright,
  });
  detail.add(detailText);
  /** Content of the open detail pane (for `y` copy). */
  let detailRaw = "";

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: FOOTER_HINTS,
    fg: COLOR.dim,
  });
  const footerBox = new BoxRenderable(renderer, {
    id: "footer-box",
    width: "100%",
    height: 1,
    backgroundColor: COLOR.bgChrome,
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

  /** Transient footer message (e.g. "copied"); reverts on the next tick. */
  let flashUntil = 0;
  const flash = (message: string): void => {
    flashUntil = Date.now() + 1500;
    footer.content = ` ${message}`;
  };

  const updateFooter = (): void => {
    if (Date.now() < flashUntil) return;
    footer.content = state.filterInput
      ? ` /${state.filter}█   (enter keep · esc clear)`
      : state.filter !== ""
        ? `${FOOTER_HINTS}  │ filter: ${state.filter}`
        : FOOTER_HINTS;
  };

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

  /** Paint the visible window into the row pool. O(window). */
  const renderList = (): void => {
    if (state.detailOpen) return;
    const nodes = state.visible();
    const max = Math.max(nodes.length - 1, 0);
    state.selectedIndex = Math.min(state.selectedIndex, max);
    // Keyboard navigation keeps the selection in view; wheel scrolling
    // detaches the viewport and leaves the selection where it is.
    if (state.viewportFollows) {
      if (state.selectedIndex < state.topIndex) {
        state.topIndex = state.selectedIndex;
      } else if (state.selectedIndex >= state.topIndex + rows.length) {
        state.topIndex = state.selectedIndex - rows.length + 1;
      }
    }
    state.topIndex = Math.max(
      0,
      Math.min(state.topIndex, Math.max(nodes.length - rows.length, 0)),
    );

    const width = renderer.terminalWidth;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const node = nodes[state.topIndex + i];
      const isSelected =
        node !== undefined && state.topIndex + i === state.selectedIndex;
      let content = "";
      let fg: string = COLOR.text;
      if (node !== undefined) {
        if (node.kind === "file") {
          content = node.node.label;
          fg = statusColor(fileStatus(node.node));
        } else {
          content = node.entry.label;
          fg = statusColor(node.entry.status);
        }
        content = content.slice(0, width);
      }
      if (isSelected) fg = COLOR.bright;
      const bg = isSelected ? COLOR.bgSelected : COLOR.bgRow;
      if (row.content !== content) {
        row.content = content;
        row.text.content = content;
      }
      if (row.fg !== fg) {
        row.fg = fg;
        row.text.fg = fg;
      }
      if (row.bg !== bg) {
        row.bg = bg;
        row.text.bg = bg;
      }
    }
  };

  const moveSelection = (delta: number): void => {
    const nodes = state.visible();
    if (nodes.length === 0) return;
    state.viewportFollows = true;
    state.selectedIndex = Math.max(
      0,
      Math.min(state.selectedIndex + delta, nodes.length - 1),
    );
    renderList();
  };

  /** Scroll the viewable content without moving the selection (wheel). */
  const scrollViewport = (delta: number): void => {
    const nodes = state.visible();
    if (nodes.length === 0) return;
    state.viewportFollows = false;
    state.topIndex = Math.max(
      0,
      Math.min(state.topIndex + delta, Math.max(nodes.length - rows.length, 0)),
    );
    renderList();
  };

  /** Click on a visible row selects it (without scrolling). */
  const selectRow = (rowIndex: number): void => {
    const nodes = state.visible();
    const index = state.topIndex + rowIndex;
    if (index >= nodes.length) return;
    state.selectedIndex = index;
    renderList();
  };

  const refresh = (): void => {
    updateHeader();
    updateFooter();
    if (state.dirty && !state.detailOpen) {
      state.dirty = false;
      renderList();
    }
  };

  const selectedNode = (): Node | undefined =>
    state.visible()[state.selectedIndex];

  const setExpanded = (node: FileNode, expanded: boolean): void => {
    node.expanded = expanded;
    state.dirty = true;
    renderList();
  };

  const openDetail = (entry: Entry): void => {
    detailRaw = detailContent(state, entry);
    detailText.content = detailRaw;
    state.detailOpen = true;
    list.visible = false;
    detail.visible = true;
    detail.focus();
  };

  const closeDetail = (): void => {
    state.detailOpen = false;
    detail.visible = false;
    list.visible = true;
    renderList();
    refresh();
  };

  const copySelection = (): void => {
    let text: string | undefined;
    if (state.detailOpen) {
      text = detailRaw;
    } else {
      const node = selectedNode();
      if (node?.kind === "test") {
        text = detailContent(state, node.entry);
      } else if (node?.kind === "file") {
        // Copy every failure of the file plus its hook logs.
        text = node.node.tests
          .filter((t) => t.status === "fail")
          .map((t) => detailContent(state, t))
          .join("\n\n");
        if (text === "") text = detailContent(state, node.node.tests[0]!);
      }
    }
    if (text === undefined || text === "") return;
    flash(
      copyToClipboard(renderer, text) ? "copied to clipboard ✓" : "copy failed",
    );
  };

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const onFilterKey = (key: KeyEvent): void => {
    switch (key.name) {
      case "escape":
        state.filter = "";
        state.filterInput = false;
        break;
      case "return":
      case "enter":
        state.filterInput = false;
        break;
      case "backspace":
        state.filter = state.filter.slice(0, -1);
        break;
      default: {
        // Printable, single-character inputs extend the query.
        const seq = key.sequence ?? "";
        if (seq.length === 1 && !key.ctrl && !key.meta && seq >= " ") {
          state.filter += seq;
        } else {
          return;
        }
      }
    }
    state.selectedIndex = 0;
    state.topIndex = 0;
    state.dirty = true;
    refresh();
  };

  // Vim `gg` prefix: true after a bare `g`, cleared by any other key.
  let pendingG = false;

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Ctrl+C: tear the TUI down BEFORE exiting so no queued timer callback
    // touches a destroyed renderer ("TextBuffer is destroyed").
    if (key.ctrl && key.name === "c") {
      dispose();
      process.exit(130);
    }
    if (disposed) return;
    if (state.filterInput && !state.detailOpen) {
      onFilterKey(key);
      return;
    }
    switch (key.name) {
      case "q":
        resolveQuit();
        return;
      case "escape":
        if (state.detailOpen) {
          closeDetail();
        } else if (state.filter !== "") {
          state.filter = "";
          state.dirty = true;
          refresh();
        }
        return;
      case "y":
        copySelection();
        return;
    }
    if (state.detailOpen) return; // ScrollBox handles its own keys

    // gg — jump to top (vim)
    if (key.name === "g" && !key.shift && !key.ctrl) {
      if (pendingG) {
        pendingG = false;
        moveSelection(-Number.MAX_SAFE_INTEGER);
      } else {
        pendingG = true;
      }
      return;
    }
    pendingG = false;

    // vim paging: ctrl-d/u half page, ctrl-f/b full page
    if (key.ctrl) {
      switch (key.name) {
        case "d":
          moveSelection(Math.max(Math.floor(rows.length / 2), 1));
          return;
        case "u":
          moveSelection(-Math.max(Math.floor(rows.length / 2), 1));
          return;
        case "f":
          moveSelection(rows.length);
          return;
        case "b":
          moveSelection(-rows.length);
          return;
      }
      return;
    }
    // G — jump to bottom (vim)
    if (key.name === "g" && key.shift) {
      moveSelection(Number.MAX_SAFE_INTEGER);
      return;
    }
    switch (key.name) {
      case "/":
        state.filterInput = true;
        refresh();
        return;
      case "space":
      case " ":
        // space pages forward (less/vim style)
        moveSelection(rows.length);
        return;
      case "return":
      case "enter": {
        const node = selectedNode();
        if (node === undefined) return;
        if (node.kind === "file") {
          setExpanded(node.node, !state.isExpanded(node.node));
        } else {
          openDetail(node.entry);
        }
        return;
      }
      case "left":
      case "h": {
        const node = selectedNode();
        if (node === undefined) return;
        // On a test row, collapse the parent file and land on it.
        const target = node.kind === "file" ? node.node : node.entry.file;
        setExpanded(target, false);
        const index = state
          .visible()
          .findIndex((n) => n.kind === "file" && n.node === target);
        if (index >= 0) {
          state.selectedIndex = index;
          renderList();
        }
        return;
      }
      case "right":
      case "l": {
        const node = selectedNode();
        if (node?.kind === "file") setExpanded(node.node, true);
        return;
      }
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
      case "f":
        state.failuresOnly = !state.failuresOnly;
        state.selectedIndex = 0;
        state.topIndex = 0;
        state.dirty = true;
        refresh();
        return;
    }
  });

  // Single flush loop: repaints the visible window at most 10x/s and ONLY
  // when test data changed; otherwise it just ticks the elapsed-time header
  // while the run is live.
  const interval = setInterval(() => {
    if (disposed) return;
    if (state.dirty) {
      refresh();
    } else if (state.summary === undefined || Date.now() < flashUntil + 100) {
      updateHeader();
      updateFooter();
    }
  }, 100);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    try {
      renderer.destroy();
    } catch {
      // Never let teardown mask the run's real outcome.
    }
  };

  return {
    renderer,
    state,
    refresh: () => {
      if (!disposed) refresh();
    },
    quit,
    dispose,
  };
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const onEvent = (tui: Tui, event: TestEvent): void => {
  const { state } = tui;
  switch (event._tag) {
    case "CollectStart":
      state.collectTotal = event.files.length;
      break;
    case "FileCollected":
      state.collectDone++;
      break;
    case "RunStart":
      state.startedAt = Date.now();
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
  // repaints (a burst of TestEnd events must not repaint per event).
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
