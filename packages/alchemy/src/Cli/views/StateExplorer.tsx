/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import {
  Box,
  KeyBar,
  Spinner,
  Text,
  TextField,
  Viewport,
  useCliEnvironment,
  useKeyGlyphs,
  useTerminalInput,
  useTerminalSize,
} from "../CliKit/components.ts";
import { Screen, theme, type ScreenController } from "../CliKit/index.ts";

export type StateFileRef =
  | {
      readonly kind: "resource";
      readonly stack: string;
      readonly stage: string;
      readonly fqn: string;
    }
  | {
      readonly kind: "output";
      readonly stack: string;
      readonly stage: string;
    };

export interface StateExplorerSource {
  readonly backend: string;
  readonly listStacks: () => Promise<ReadonlyArray<string>>;
  readonly listStages: (stack: string) => Promise<ReadonlyArray<string>>;
  readonly listResources: (
    stack: string,
    stage: string,
  ) => Promise<ReadonlyArray<string>>;
  readonly readFile: (file: StateFileRef) => Promise<unknown>;
  readonly deleteNodes: (
    nodes: ReadonlyArray<StateBrowserNode>,
  ) => Promise<void>;
}

export type StateBrowserNode =
  | {
      readonly kind: "stack";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly stack: string;
    }
  | {
      readonly kind: "stage";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly stack: string;
      readonly stage: string;
    }
  | {
      readonly kind: "namespace";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly children: ReadonlyArray<StateBrowserNode>;
    }
  | {
      readonly kind: "resource";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly file: StateFileRef & { readonly kind: "resource" };
    }
  | {
      readonly kind: "output";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly file: StateFileRef & { readonly kind: "output" };
    };

type LoadState<Value> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: Value }
  | { readonly status: "error"; readonly message: string };

interface ExplorerSnapshot {
  readonly root: LoadState<ReadonlyArray<StateBrowserNode>>;
  readonly children: ReadonlyMap<
    string,
    LoadState<ReadonlyArray<StateBrowserNode>>
  >;
  readonly files: ReadonlyMap<string, LoadState<unknown>>;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Mutable async cache: every state-store read is initiated by a selection. */
export class StateExplorerStore {
  private state: ExplorerSnapshot = {
    root: { status: "idle" },
    children: new Map(),
    files: new Map(),
  };
  private readonly listeners = new Set<() => void>();

  constructor(readonly source: StateExplorerSource) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.state;
  private commit(next: ExplorerSnapshot) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  readonly loadRoot = () => {
    if (this.state.root.status !== "idle") return;
    this.commit({ ...this.state, root: { status: "loading" } });
    void this.source.listStacks().then(
      (stacks) =>
        this.commit({
          ...this.state,
          root: {
            status: "ready",
            value: [...stacks].sort().map((stack) => ({
              kind: "stack",
              id: `stack:${stack}`,
              name: stack,
              path: stack,
              stack,
            })),
          },
        }),
      (error) =>
        this.commit({
          ...this.state,
          root: { status: "error", message: errorMessage(error) },
        }),
    );
  };

  readonly refresh = () => {
    this.commit({
      root: { status: "idle" },
      children: new Map(),
      files: new Map(),
    });
    this.loadRoot();
  };

  readonly loadChildren = (node: StateBrowserNode) => {
    if (
      node.kind === "namespace" ||
      node.kind === "resource" ||
      node.kind === "output"
    ) {
      return;
    }
    if ((this.state.children.get(node.id)?.status ?? "idle") !== "idle") return;
    const children = new Map(this.state.children);
    children.set(node.id, { status: "loading" });
    this.commit({ ...this.state, children });

    const request =
      node.kind === "stack"
        ? this.source.listStages(node.stack).then((stages) =>
            [...stages].sort().map(
              (stage): StateBrowserNode => ({
                kind: "stage",
                id: `stage:${node.stack}/${stage}`,
                name: stage,
                path: `${node.stack}/${stage}`,
                stack: node.stack,
                stage,
              }),
            ),
          )
        : this.source
            .listResources(node.stack, node.stage!)
            .then((fqns) => buildStageNodes(node.stack, node.stage!, fqns));
    void request.then(
      (value) => {
        const next = new Map(this.state.children);
        next.set(node.id, { status: "ready", value });
        this.commit({ ...this.state, children: next });
      },
      (error) => {
        const next = new Map(this.state.children);
        next.set(node.id, { status: "error", message: errorMessage(error) });
        this.commit({ ...this.state, children: next });
      },
    );
  };

  readonly loadFile = (node: StateBrowserNode) => {
    if (node.kind !== "resource" && node.kind !== "output") return;
    if ((this.state.files.get(node.id)?.status ?? "idle") !== "idle") return;
    const files = new Map(this.state.files);
    files.set(node.id, { status: "loading" });
    this.commit({ ...this.state, files });
    void this.source.readFile(node.file).then(
      (value) => {
        const next = new Map(this.state.files);
        next.set(node.id, { status: "ready", value });
        this.commit({ ...this.state, files: next });
      },
      (error) => {
        const next = new Map(this.state.files);
        next.set(node.id, { status: "error", message: errorMessage(error) });
        this.commit({ ...this.state, files: next });
      },
    );
  };
}

interface MutableNamespace {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, MutableNamespace>;
  readonly files: StateBrowserNode[];
}

/** Convert listed FQNs to namespace columns without reading any state values. */
export const buildStageNodes = (
  stack: string,
  stage: string,
  fqns: ReadonlyArray<string>,
): ReadonlyArray<StateBrowserNode> => {
  const root: MutableNamespace = {
    name: "",
    path: `${stack}/${stage}`,
    children: new Map(),
    files: [],
  };
  for (const fqn of [...fqns].sort()) {
    const parts = fqn.split("/").filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let child = current.children.get(part);
      if (child === undefined) {
        child = {
          name: part,
          path: `${current.path}/${part}`,
          children: new Map(),
          files: [],
        };
        current.children.set(part, child);
      }
      current = child;
    }
    const name = parts.at(-1) ?? fqn;
    current.files.push({
      kind: "resource",
      id: `resource:${stack}/${stage}/${fqn}`,
      name: `${name}.json`,
      path: `${stack}/${stage}/${fqn}.json`,
      file: { kind: "resource", stack, stage, fqn },
    });
  }

  const freeze = (namespace: MutableNamespace): StateBrowserNode[] => [
    ...[...namespace.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (child): StateBrowserNode => ({
          kind: "namespace",
          id: `namespace:${child.path}`,
          name: child.name,
          path: child.path,
          children: freeze(child),
        }),
      ),
    ...namespace.files,
  ];
  return [
    ...freeze(root),
    {
      kind: "output",
      id: `output:${stack}/${stage}`,
      name: "output.json",
      path: `${stack}/${stage}/output.json`,
      file: { kind: "output", stack, stage },
    },
  ];
};

const nodeStyle: Record<
  StateBrowserNode["kind"],
  { readonly color: string; readonly icon: string; readonly asciiIcon: string }
> = {
  stack: { color: theme.color.brand, icon: "◆", asciiIcon: "#" },
  stage: { color: theme.color.warning, icon: "●", asciiIcon: "@" },
  namespace: { color: theme.color.accent, icon: "▸", asciiIcon: ">" },
  resource: { color: theme.color.info, icon: "▪", asciiIcon: "-" },
  output: { color: theme.color.success, icon: "◇", asciiIcon: "=" },
};

const childrenFor = (
  node: StateBrowserNode,
  state: ExplorerSnapshot,
): LoadState<ReadonlyArray<StateBrowserNode>> | undefined =>
  node.kind === "namespace"
    ? { status: "ready", value: node.children }
    : node.kind === "stack" || node.kind === "stage"
      ? (state.children.get(node.id) ?? { status: "idle" })
      : undefined;

interface BrowserColumn {
  readonly id: string;
  readonly title: string;
  readonly state: LoadState<ReadonlyArray<StateBrowserNode>>;
}

const buildColumns = (
  state: ExplorerSnapshot,
  selection: ReadonlyArray<string>,
): BrowserColumn[] => {
  const columns: BrowserColumn[] = [
    { id: "root", title: "Stacks", state: state.root },
  ];
  let current = state.root;
  for (let depth = 0; depth < selection.length; depth++) {
    if (current.status !== "ready") break;
    const selected = current.value.find((node) => node.id === selection[depth]);
    if (selected === undefined) break;
    const children = childrenFor(selected, state);
    if (children === undefined) break;
    columns.push({
      id: selected.id,
      title:
        selected.kind === "stack"
          ? "Stages"
          : selected.kind === "stage"
            ? "State"
            : selected.name,
      state: children,
    });
    current = children;
  }
  return columns;
};

const Column = ({
  column,
  selected,
  focused,
  height,
  query,
  marked,
}: {
  readonly column: BrowserColumn;
  readonly selected: string | undefined;
  readonly focused: boolean;
  readonly height: number;
  readonly query: string;
  readonly marked: ReadonlySet<string>;
}) => {
  const { unicode } = useCliEnvironment();
  if (column.state.status === "idle" || column.state.status === "loading") {
    return <Spinner label="Loading" />;
  }
  if (column.state.status === "error") {
    return <Text tone="danger">{column.state.message}</Text>;
  }
  const needle = query.trim().toLowerCase();
  const items =
    needle === ""
      ? column.state.value
      : column.state.value.filter((node) =>
          node.path.toLowerCase().includes(needle),
        );
  const selectedIndex = Math.max(
    0,
    items.findIndex((node) => node.id === selected),
  );
  return (
    <Viewport
      items={items}
      cursor={selectedIndex}
      height={height}
      getKey={(node) => node.id}
      empty={<Text tone="muted">No matches.</Text>}
      renderItem={(node) => {
        const active = node.id === selected;
        const style = nodeStyle[node.kind];
        const selectionBackground = !active
          ? undefined
          : focused
            ? theme.color.accentMuted
            : theme.color.surface;
        return (
          <Box width="100%">
            <Box width={2} flexShrink={0}>
              <Text color={style.color} backgroundColor={selectionBackground}>
                {marked.has(node.id)
                  ? unicode
                    ? "● "
                    : "* "
                  : `${unicode ? style.icon : style.asciiIcon} `}
              </Text>
            </Box>
            <Text
              bold={active}
              color={
                active
                  ? focused
                    ? theme.color.onAccent
                    : theme.color.onSurface
                  : undefined
              }
              backgroundColor={selectionBackground}
              wrap="truncate-end"
            >
              {node.name}
            </Text>
            {(node.kind === "stack" ||
              node.kind === "stage" ||
              node.kind === "namespace") && (
              <Box flexGrow={1} justifyContent="flex-end">
                <Text tone="muted">{unicode ? "›" : ">"}</Text>
              </Box>
            )}
          </Box>
        );
      }}
    />
  );
};

const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? `${item}n` : item),
    2,
  ) ?? String(value);

const JsonLine = ({ line }: { readonly line: string }) => {
  const key = line.match(/^(\s*)("(?:[^"\\]|\\.)+")(:)(.*)$/);
  if (key !== null) {
    return (
      <Text wrap="truncate-end">
        {key[1]}
        <Text color={theme.color.info}>{key[2]}</Text>
        {key[3]}
        <JsonValue value={key[4]!} />
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <JsonValue value={line} />
    </Text>
  );
};

const JsonValue = ({ value }: { readonly value: string }) => {
  const trimmed = value.trimStart();
  const color = trimmed.startsWith('"')
    ? theme.color.success
    : /^(true|false)/.test(trimmed)
      ? theme.color.accent
      : /^-?\d/.test(trimmed)
        ? theme.color.warning
        : trimmed.startsWith("null")
          ? theme.color.danger
          : undefined;
  return <Text color={color}>{value}</Text>;
};

const Preview = ({
  node,
  state,
  offset,
  height,
}: {
  readonly node: StateBrowserNode | undefined;
  readonly state: LoadState<unknown> | undefined;
  readonly offset: number;
  readonly height: number;
}) => {
  if (
    node === undefined ||
    (node.kind !== "resource" && node.kind !== "output")
  ) {
    return <Text tone="muted">Select a state file to preview it.</Text>;
  }
  if (
    state === undefined ||
    state.status === "idle" ||
    state.status === "loading"
  ) {
    return <Spinner label="Reading state" detail={node.name} />;
  }
  if (state.status === "error")
    return <Text tone="danger">{state.message}</Text>;
  if (state.value === undefined) {
    return <Text tone="muted">No stored value.</Text>;
  }
  const lines = json(state.value).split("\n");
  const bodyHeight = Math.max(1, height - 2);
  const start = Math.max(
    0,
    Math.min(offset, Math.max(0, lines.length - bodyHeight)),
  );
  return (
    <Box flexDirection="column" height={height}>
      <Text bold color={nodeStyle[node.kind].color} wrap="truncate-middle">
        {node.path}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.slice(start, start + bodyHeight).map((line, index) => (
          <JsonLine key={`${start + index}:${line}`} line={line} />
        ))}
      </Box>
    </Box>
  );
};

function StateExplorer({
  store,
  controller,
}: {
  readonly store: StateExplorerStore;
  readonly controller: ScreenController<void>;
}): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [columnIndex, setColumnIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [previewFocused, setPreviewFocused] = useState(false);
  const [marked, setMarked] = useState<ReadonlyMap<string, StateBrowserNode>>(
    new Map(),
  );
  const [deletion, setDeletion] = useState<
    | {
        readonly status: "confirm" | "deleting";
        readonly targets: ReadonlyArray<StateBrowserNode>;
      }
    | {
        readonly status: "error";
        readonly message: string;
        readonly targets: ReadonlyArray<StateBrowserNode>;
      }
  >();
  const [notice, setNotice] = useState<string>();
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize();
  const keys = useKeyGlyphs();

  useEffect(store.loadRoot, [store]);
  const columns = useMemo(
    () => buildColumns(state, selection),
    [selection, state],
  );
  const activeColumn = Math.min(columnIndex, columns.length - 1);
  const column = columns[activeColumn]!;
  const filteredItems =
    column.state.status !== "ready"
      ? []
      : query.trim() === ""
        ? column.state.value
        : column.state.value.filter((node) =>
            node.path.toLowerCase().includes(query.trim().toLowerCase()),
          );
  const selectedId = selection[activeColumn];
  const selectedIndex = filteredItems.findIndex(
    (node) => node.id === selectedId,
  );
  const selected = filteredItems[selectedIndex];
  const lastSelected = (() => {
    for (let index = columns.length - 1; index >= 0; index--) {
      const candidate = columns[index];
      if (candidate?.state.status !== "ready") continue;
      const node = candidate.state.value.find(
        (item) => item.id === selection[index],
      );
      if (node !== undefined) return node;
    }
    return undefined;
  })();
  const file =
    lastSelected?.kind === "resource" || lastSelected?.kind === "output"
      ? lastSelected
      : undefined;
  const fileState = file === undefined ? undefined : state.files.get(file.id);
  const contentHeight = Math.max(6, terminalRows - 8);
  const maxPreviewOffset =
    fileState?.status === "ready" && fileState.value !== undefined
      ? Math.max(
          0,
          json(fileState.value).split("\n").length -
            Math.max(1, contentHeight - 2),
        )
      : 0;

  const choose = (index: number, node: StateBrowserNode) => {
    setSelection((current) => [...current.slice(0, index), node.id]);
    setPreviewOffset(0);
    if (node.kind === "resource" || node.kind === "output")
      store.loadFile(node);
    else store.loadChildren(node);
  };
  const move = (delta: number) => {
    if (filteredItems.length === 0) return;
    const next =
      selectedIndex < 0
        ? delta < 0
          ? filteredItems.length - 1
          : 0
        : Math.max(
            0,
            Math.min(filteredItems.length - 1, selectedIndex + delta),
          );
    choose(activeColumn, filteredItems[next]!);
  };

  const beginDelete = () => {
    const targets =
      marked.size > 0 ? [...marked.values()] : selected ? [selected] : [];
    if (targets.length === 0) return;
    if (targets.some((node) => node.kind === "output")) {
      setDeletion({
        status: "error",
        message: "output.json cannot be deleted independently",
        targets,
      });
      return;
    }
    setDeletion({ status: "confirm", targets });
  };

  const confirmDelete = () => {
    if (deletion === undefined || deletion.status === "deleting") return;
    const targets = deletion.targets;
    setDeletion({ status: "deleting", targets });
    void store.source.deleteNodes(targets).then(
      () => {
        setDeletion(undefined);
        setMarked(new Map());
        setSelection([]);
        setColumnIndex(0);
        setPreviewFocused(false);
        setNotice(
          `Deleted state at ${targets.map((target) => `${target.path}${target.kind === "resource" ? "" : "/"}`).join(", ")}`,
        );
        store.refresh();
      },
      (error) =>
        setDeletion({
          status: "error",
          message: errorMessage(error),
          targets,
        }),
    );
  };

  useTerminalInput(
    (input, key) => {
      if (deletion !== undefined) {
        if (deletion.status === "deleting") return;
        if (key.escape || input === "n" || input === "q")
          setDeletion(undefined);
        else if (deletion.status === "confirm" && input === "y")
          confirmDelete();
        return;
      }
      if (input === "q") return controller.submit(undefined);
      if (key.escape) {
        if (query !== "") setQuery("");
        else controller.submit(undefined);
        return;
      }
      if (!key.ctrl && !key.meta && input === "/") {
        setSearching(true);
        setPreviewFocused(false);
        return;
      }
      if (!key.ctrl && !key.meta && input === "r") {
        setSelection([]);
        setColumnIndex(0);
        setPreviewFocused(false);
        setNotice(undefined);
        store.refresh();
        return;
      }
      if (input === " " && selected !== undefined) {
        setMarked((current) => {
          const next = new Map(current);
          if (next.has(selected.id)) next.delete(selected.id);
          else next.set(selected.id, selected);
          return next;
        });
        return;
      }
      if (input === "d") {
        beginDelete();
        return;
      }
      if (key.tab) {
        if (file !== undefined) setPreviewFocused((current) => !current);
        return;
      }
      if (previewFocused) {
        if (key.left) setPreviewFocused(false);
        else if (key.up) setPreviewOffset((value) => Math.max(0, value - 1));
        else if (key.down)
          setPreviewOffset((value) => Math.min(maxPreviewOffset, value + 1));
        else if (key.pageUp)
          setPreviewOffset((value) => Math.max(0, value - contentHeight));
        else if (key.pageDown)
          setPreviewOffset((value) =>
            Math.min(maxPreviewOffset, value + contentHeight),
          );
        else if (key.home) setPreviewOffset(0);
        else if (key.end) setPreviewOffset(maxPreviewOffset);
        return;
      }
      if (key.up || input === "k") move(-1);
      else if (key.down || input === "j") move(1);
      else if (key.home && filteredItems[0])
        choose(activeColumn, filteredItems[0]);
      else if (key.end && filteredItems.at(-1))
        choose(activeColumn, filteredItems.at(-1)!);
      else if (key.left && activeColumn > 0) setColumnIndex(activeColumn - 1);
      else if (key.right || key.enter) {
        if (selected === undefined) return;
        choose(activeColumn, selected);
        if (selected.kind === "resource" || selected.kind === "output") {
          setPreviewFocused(true);
        } else {
          setColumnIndex(activeColumn + 1);
        }
      }
    },
    { active: !searching },
  );

  const previewWidth =
    file === undefined ? 0 : Math.max(34, Math.floor(terminalColumns * 0.42));
  const columnWidth = Math.max(
    20,
    Math.min(28, Math.floor((terminalColumns - previewWidth) / 2)),
  );
  const availableForColumns = Math.max(
    columnWidth,
    terminalColumns - previewWidth - 2,
  );
  const visibleColumnCount = Math.max(
    1,
    Math.floor(availableForColumns / (columnWidth + 1)),
  );
  const visibleStart = Math.max(0, columns.length - visibleColumnCount);
  const visibleColumns = columns.slice(visibleStart);
  const currentPath = selected?.path ?? "/";
  const displayPath =
    selected === undefined ||
    selected.kind === "resource" ||
    selected.kind === "output"
      ? currentPath
      : `${currentPath}/`;

  if (deletion !== undefined) {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold color={theme.color.danger}>
          Delete state records?
        </Text>
        <Text tone="muted">Cloud resources will not be deleted.</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {deletion.targets.map((target) => (
            <Text key={target.id}>
              {target.path}
              {target.kind === "resource" ? "" : "/"}
            </Text>
          ))}
        </Box>
        {deletion.status === "deleting" ? (
          <Spinner label="Deleting state" />
        ) : deletion.status === "error" ? (
          <Text tone="danger">{deletion.message}</Text>
        ) : (
          <KeyBar
            keys={[
              ["y", "delete"],
              ["n/esc", "cancel"],
            ]}
          />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={Math.max(12, terminalRows - 2)}>
      <Box justifyContent="space-between" flexShrink={0} paddingX={1}>
        <Box gap={1}>
          <Text bold color={theme.color.brand}>
            State
          </Text>
          <Text color={theme.color.accent} wrap="truncate-middle">
            {displayPath}
          </Text>
        </Box>
        <Text tone="muted">{store.source.backend}</Text>
      </Box>
      <Box paddingX={1} flexShrink={0}>
        {notice === undefined ? (
          <Text> </Text>
        ) : (
          <Text color={theme.color.success}>{notice}</Text>
        )}
      </Box>
      {searching ? (
        <Box gap={1} flexShrink={0}>
          <Text tone="muted">Search:</Text>
          <TextField
            value={query}
            placeholder="filter this column"
            active
            onChange={setQuery}
            onSubmit={() => setSearching(false)}
            onCancel={() => setSearching(false)}
          />
        </Box>
      ) : query === "" ? null : (
        <Text tone="muted">Filter: {query}</Text>
      )}
      <Box flexGrow={1}>
        {visibleColumns.map((item, offset) => {
          const index = visibleStart + offset;
          return (
            <Box
              key={item.id}
              width={columnWidth}
              flexDirection="column"
              paddingX={1}
              borderStyle="classic"
              borderLeft={offset > 0}
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderColor={
                !previewFocused && index === activeColumn
                  ? theme.color.accent
                  : theme.color.muted
              }
            >
              <Text
                bold
                color={
                  !previewFocused && index === activeColumn
                    ? theme.color.accent
                    : theme.color.muted
                }
              >
                {item.title}
              </Text>
              <Box height={contentHeight} flexDirection="column">
                <Column
                  column={item}
                  selected={selection[index]}
                  focused={!previewFocused && index === activeColumn}
                  height={contentHeight}
                  query={index === activeColumn ? query : ""}
                  marked={new Set(marked.keys())}
                />
              </Box>
            </Box>
          );
        })}
        {file === undefined ? null : (
          <Box
            flexGrow={1}
            flexDirection="column"
            paddingLeft={1}
            borderStyle="classic"
            borderLeft
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={
              previewFocused ? theme.color.accent : theme.color.muted
            }
          >
            <Text
              bold
              color={previewFocused ? theme.color.accent : theme.color.muted}
            >
              Preview
            </Text>
            <Preview
              node={file}
              state={fileState}
              offset={previewOffset}
              height={contentHeight}
            />
          </Box>
        )}
      </Box>
      <Box paddingX={1} flexShrink={0}>
        <KeyBar
          keys={[
            [keys.upDown, previewFocused ? "scroll" : "select"],
            [keys.leftRight, "columns"],
            ["/", "search"],
            ["r", "refresh"],
            [keys.space, "select"],
            ["d", "delete"],
            ...(file === undefined ? [] : ([[keys.tab, "preview"]] as const)),
            ["q", "quit"],
          ]}
        />
      </Box>
    </Box>
  );
}

export const stateExplorerScreen = (source: StateExplorerSource) => {
  const store = new StateExplorerStore(source);
  return Screen.make<void>("state explorer", (controller) => (
    <StateExplorer store={store} controller={controller} />
  ));
};
