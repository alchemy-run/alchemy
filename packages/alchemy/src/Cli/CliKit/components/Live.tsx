/** @jsxImportSource react */
import { format } from "node:util";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { statusColor, theme, type StatusVariant } from "../theme.ts";
import { useGlyphs } from "./Environment.tsx";
import { ProgressBar, SpinnerGlyph, Status } from "./Feedback.tsx";
import { Box, Row, Stack } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export type TaskStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "skipped"
  | "deleted";

export interface TaskNode {
  readonly id: string;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly status?: TaskStatus;
  readonly children?: ReadonlyArray<TaskNode>;
}

const taskVariant = (status: TaskStatus): StatusVariant =>
  status === "failure"
    ? "error"
    : status === "success" || status === "deleted"
      ? "success"
      : status === "running"
        ? "info"
        : "warning";

export interface TaskRowProps {
  /** Status glyph. Ignored while `spinning`; defaults to the bullet glyph. */
  readonly icon?: string;
  /** Color for the glyph (and the spinner while `spinning`). */
  readonly iconColor?: string;
  /** Render an animated spinner frame in the glyph slot. */
  readonly spinning?: boolean;
  readonly label: ReactNode;
  /** Muted annotation directly after the label. */
  readonly detail?: ReactNode;
  /** Indentation in 2-space units. */
  readonly depth?: number;
  /** Extra trailing cells (status labels, chips). */
  readonly children?: ReactNode;
}

/**
 * The one status row shape shared by TaskTree and the plan/apply views:
 * glyph-or-spinner, bold label, muted detail, then any trailing cells.
 */
export const TaskRow = ({
  icon,
  iconColor,
  spinning = false,
  label,
  detail,
  depth = 0,
  children,
}: TaskRowProps) => {
  const glyphs = useGlyphs();
  return (
    <Row gap={1} paddingLeft={depth * 2}>
      {spinning ? (
        <SpinnerGlyph color={iconColor} />
      ) : (
        <Text color={iconColor}>{icon ?? glyphs.bullet}</Text>
      )}
      <Text bold>{label}</Text>
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
      {children}
    </Row>
  );
};

const Task = ({
  node,
  depth,
}: {
  readonly node: TaskNode;
  readonly depth: number;
}) => {
  const glyphs = useGlyphs();
  const status = node.status ?? "pending";
  const variant = taskVariant(status);
  const inactive = status === "pending" || status === "skipped";
  return (
    <Stack>
      <TaskRow
        spinning={status === "running"}
        icon={inactive ? glyphs.bullet : glyphs[variant]}
        iconColor={
          status === "running"
            ? undefined
            : inactive
              ? theme.color.muted
              : statusColor(variant)
        }
        label={node.label}
        detail={node.detail}
        depth={depth}
      />
      {node.children?.map((child) => (
        <Task key={child.id} node={child} depth={depth + 1} />
      ))}
    </Stack>
  );
};

export const TaskTree = ({
  tasks,
}: {
  readonly tasks: ReadonlyArray<TaskNode>;
}) => (
  <Stack>
    {tasks.map((task) => (
      <Task key={task.id} node={task} depth={0} />
    ))}
  </Stack>
);

export interface ProgressGroupRow {
  readonly id: string;
  readonly label: ReactNode;
  readonly completed: number;
  readonly total: number;
  readonly failed?: number;
  readonly detail?: ReactNode;
}

export const ProgressGroup = ({
  rows,
  width = 20,
  labelWidth,
}: {
  readonly rows: ReadonlyArray<ProgressGroupRow>;
  readonly width?: number;
  /** Fixed label column (truncated) so the count cells align across rows. */
  readonly labelWidth?: number;
}) => (
  <Stack>
    {rows.map((row) => {
      const complete = row.total > 0 && row.completed >= row.total;
      const variant = row.failed ? "error" : complete ? "success" : "info";
      return (
        <Row key={row.id}>
          <ProgressBar
            value={row.total <= 0 ? 0 : row.completed / row.total}
            width={width}
            showPercent={false}
            variant={variant}
          />
          {labelWidth === undefined ? (
            <Text>{row.label}</Text>
          ) : (
            <Box width={labelWidth} flexShrink={0}>
              <Text wrap="truncate-end">{row.label}</Text>
            </Box>
          )}
          <Text bold tone={variant === "error" ? "danger" : variant}>
            {row.completed}/{row.total}
          </Text>
          {row.failed ? <Text tone="danger">({row.failed} failed)</Text> : null}
          {row.detail === undefined ? null : (
            <Text tone="muted">{row.detail}</Text>
          )}
        </Row>
      );
    })}
  </Stack>
);

export class LiveStore<Value> {
  private value: Value;
  private readonly listeners = new Set<() => void>();
  constructor(initial: Value) {
    this.value = initial;
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.value;
  readonly set = (value: Value) => {
    this.value = value;
    for (const listener of this.listeners) listener();
  };
  readonly update = (f: (value: Value) => Value) => this.set(f(this.value));
}

export const useLiveStore = <Value,>(store: LiveStore<Value>): Value =>
  useSyncExternalStore(store.subscribe, store.snapshot);

export type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
export interface ConsoleEntry {
  readonly method: ConsoleMethod;
  readonly text: string;
}

export class ConsoleFeed extends LiveStore<ReadonlyArray<ConsoleEntry>> {
  constructor() {
    super([]);
  }
  readonly append = (method: ConsoleMethod, ...args: ReadonlyArray<unknown>) =>
    this.update((entries) => [...entries, { method, text: format(...args) }]);
  readonly appendEntry = (entry: ConsoleEntry) =>
    this.update((entries) => [...entries, entry]);
}

const CONSOLE_METHODS: ReadonlyArray<ConsoleMethod> = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
];

interface ConsoleInterceptor {
  readonly token: symbol;
  readonly handler: (entry: ConsoleEntry) => void;
}

const consoleInterceptors: ConsoleInterceptor[] = [];
const originalConsole = new Map<
  ConsoleMethod,
  (...args: ReadonlyArray<unknown>) => void
>();
const installedConsole = new Map<
  ConsoleMethod,
  (...args: ReadonlyArray<unknown>) => void
>();

const installConsoleRouter = () => {
  if (installedConsole.size > 0) return;
  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    originalConsole.set(method, original);
    const replacement = (...args: ReadonlyArray<unknown>) => {
      const interceptor = consoleInterceptors.at(-1);
      if (interceptor !== undefined) {
        interceptor.handler({ method, text: format(...args) });
      } else {
        original(...args);
      }
    };
    installedConsole.set(method, replacement);
    console[method] = replacement;
  }
};

const uninstallConsoleRouter = () => {
  if (consoleInterceptors.length > 0) return;
  for (const method of CONSOLE_METHODS) {
    if (console[method] === installedConsole.get(method)) {
      console[method] = originalConsole.get(method)!;
    }
  }
  installedConsole.clear();
  originalConsole.clear();
};

/** Routes raw console writes into a renderer-owned feed. Restore is idempotent. */
export const interceptConsole = (handler: (entry: ConsoleEntry) => void) => {
  const interceptor = { token: Symbol(), handler };
  consoleInterceptors.push(interceptor);
  installConsoleRouter();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const index = consoleInterceptors.findIndex(
      ({ token }) => token === interceptor.token,
    );
    if (index !== -1) consoleInterceptors.splice(index, 1);
    uninstallConsoleRouter();
  };
};

export const ConsoleFeedView = ({
  feed,
  maxRows = 100,
}: {
  readonly feed: ConsoleFeed;
  readonly maxRows?: number;
}) => {
  const entries = useLiveStore(feed).slice(-Math.max(1, maxRows));
  return (
    <Stack>
      {entries.map((entry, index) =>
        entry.method === "warn" || entry.method === "error" ? (
          <Status
            key={index}
            variant={entry.method === "warn" ? "warning" : "error"}
          >
            {entry.text}
          </Status>
        ) : (
          <Text
            key={index}
            tone={entry.method === "debug" ? "muted" : "default"}
          >
            {entry.text}
          </Text>
        ),
      )}
    </Stack>
  );
};
