/** @jsxRuntime automatic */
/** @jsxImportSource @alchemy.run/sigil */
import { isValidElement, useSyncExternalStore } from "@alchemy.run/sigil/react";
import type { ReactNode } from "react";
import { theme } from "../../../Util/Theme.ts";
import { useCliEnvironment, useGlyphs } from "./Environment.tsx";
import { SpinnerGlyph } from "./Feedback.tsx";
import { Box, Row, Stack } from "./Layout.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { Text } from "./Typography.tsx";

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
  /**
   * How a detail longer than the row is fitted: cut to one line (progress
   * messages), or wrapped within its own column (errors worth reading whole).
   * Either way the glyph, label and trailing cells keep their full width.
   * @default "truncate"
   */
  readonly detailOverflow?: "truncate" | "wrap";
  /** Indentation in 2-space units. */
  readonly depth?: number;
  /** Extra trailing cells (status labels, chips). */
  readonly children?: ReactNode;
}

/**
 * The one status row shape shared by TaskTree and the plan/apply views:
 * glyph-or-spinner, bold label, muted detail, then any trailing cells.
 */
export function TaskRow({
  icon,
  iconColor,
  spinning = false,
  label,
  detail,
  detailOverflow = "truncate",
  depth = 0,
  children,
}: TaskRowProps) {
  const glyphs = useGlyphs();
  const { columns } = useCliEnvironment();
  // A failure message keeps a column of its own beside a label that has to
  // truncate: as wide as it needs, but at most a share of the row, so the
  // status still fits in narrow terminals.
  const detailMinWidth =
    detail !== undefined && detailOverflow === "wrap"
      ? Math.min(
          oneLine(textOf(detail)).length + 2,
          Math.floor((columns - depth * theme.space.indent) * failureShare),
        )
      : 0;
  // Only the detail gives way when the row is too narrow, then the label;
  // letting every cell shrink wrapped the label and split the status word.
  return (
    <Row gap={1} paddingLeft={depth * theme.space.indent}>
      <Box flexShrink={0}>
        {spinning ? (
          <SpinnerGlyph color={iconColor} />
        ) : (
          <Text color={iconColor}>{icon ?? glyphs.bullet}</Text>
        )}
      </Box>
      {/* The label gives way only once the detail is gone (the detail's
          huge shrink factor takes the overflow first), so a long name still
          leaves the trailing status on screen. */}
      <Box flexShrink={1}>
        <Text bold={depth === 0} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      {detail === undefined ? null : (
        <Box flexShrink={1_000_000} minWidth={Math.max(0, detailMinWidth)}>
          <Text tone="muted" wrap={detailOverflow === "truncate" ? "truncate-end" : "wrap"}>
            ·{" "}
            {typeof detail === "string" && detailOverflow === "truncate" ? oneLine(detail) : detail}
          </Text>
        </Box>
      )}
      <Box flexShrink={0} gap={1}>
        {children}
      </Box>
    </Row>
  );
}

/** Progress messages can carry several lines of tool output; keep them on one. */
const oneLine = (text: string) => text.replaceAll(/\s*\r?\n\s*/g, " ").trim();

/** Share of the row a wrapped failure detail keeps when the label has to truncate. */
const failureShare = 0.4;

/** The plain text of a detail, to size its column. */
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ readonly children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
};

export interface ProgressGroupRow {
  readonly id: string;
  readonly label: ReactNode;
  readonly completed: number;
  readonly total: number;
  readonly failed?: number;
  readonly detail?: ReactNode;
}

type ProgressGroupProps = {
  readonly rows: ReadonlyArray<ProgressGroupRow>;
  readonly width?: number;
  /** Fixed label column (truncated) so the count cells align across rows. */
  readonly labelWidth?: number;
};

export function ProgressGroup({ rows, width = 20, labelWidth }: ProgressGroupProps) {
  return (
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
            {row.detail === undefined ? null : <Text tone="muted">{row.detail}</Text>}
          </Row>
        );
      })}
    </Stack>
  );
}

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
