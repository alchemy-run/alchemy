/** @jsxImportSource react */
import { type ReactNode, useSyncExternalStore } from "react";
import { statusColor, theme, type StatusVariant } from "../theme.ts";
import { useCliEnvironment, useGlyphs } from "./Environment.tsx";
import { Box } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface StatusProps {
  readonly variant?: StatusVariant;
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
}

export const Status = ({ variant = "info", children, detail }: StatusProps) => {
  const glyphs = useGlyphs();
  return (
    <Box gap={1} flexWrap="wrap">
      <Text color={statusColor(variant)}>{glyphs[variant]}</Text>
      <Text color={variant === "error" ? statusColor(variant) : undefined}>
        {children}
      </Text>
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
};

export interface AlertProps extends StatusProps {
  readonly title?: ReactNode;
}

export const Alert = ({
  variant = "info",
  title,
  children,
  detail,
}: AlertProps) => {
  const glyphs = useGlyphs();
  const { unicode } = useCliEnvironment();
  return (
    <Box
      flexDirection="column"
      borderStyle={unicode ? "round" : "classic"}
      borderColor={statusColor(variant)}
      paddingX={1}
    >
      <Box gap={1}>
        <Text color={statusColor(variant)}>{glyphs[variant]}</Text>
        {title === undefined ? null : <Text bold>{title}</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Text>{children}</Text>
      </Box>
      {detail === undefined ? null : (
        <Box paddingLeft={2}>
          <Text tone="muted">{detail}</Text>
        </Box>
      )}
    </Box>
  );
};

export type BadgeVariant = StatusVariant | "neutral" | "accent";

export const Badge = ({
  variant = "neutral",
  children,
}: {
  readonly variant?: BadgeVariant;
  readonly children?: ReactNode;
}) => {
  const background =
    variant === "neutral"
      ? theme.color.surface
      : variant === "accent"
        ? theme.color.accentMuted
        : statusColor(variant);
  // Dark ink on the light status/accent backgrounds, light ink on the dark
  // neutral surface — the same foreground policy as BooleanChoice and Tabs.
  const foreground =
    variant === "neutral" ? theme.color.onSurface : theme.color.onAccent;
  return (
    <Text backgroundColor={background} color={foreground} bold>
      {` ${children ?? ""} `}
    </Text>
  );
};

export const KeyBar = ({
  keys,
}: {
  readonly keys: ReadonlyArray<readonly [key: string, label: string]>;
}) => (
  <Box flexWrap="wrap" gap={2}>
    {keys.map(([key, label]) => (
      <Text key={`${key}:${label}`} tone="muted">
        <Text bold color={theme.color.accent}>
          {key}
        </Text>{" "}
        {label}
      </Text>
    ))}
  </Box>
);

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const ASCII_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
const spinnerListeners = new Set<() => void>();
const subscribeSpinner = (listener: () => void) => {
  spinnerListeners.add(listener);
  if (spinnerTimer === undefined) {
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      for (const notify of spinnerListeners) notify();
    }, 80);
  }
  return () => {
    spinnerListeners.delete(listener);
    if (spinnerListeners.size === 0) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };
};
const snapshotSpinner = () => spinnerFrame;

export const useSpinnerFrame = (): string => {
  const { unicode } = useCliEnvironment();
  const frames = unicode ? SPINNER_FRAMES : ASCII_SPINNER_FRAMES;
  const frame = useSyncExternalStore(subscribeSpinner, snapshotSpinner);
  return frames[frame % frames.length]!;
};

/**
 * Spinner-as-status-icon: one animated frame, colorable so it can stand in
 * for a status glyph in trees and progress rows.
 */
export const SpinnerGlyph = ({ color }: { readonly color?: string }) => (
  <Text color={color ?? theme.color.info}>{useSpinnerFrame()}</Text>
);

export const Spinner = ({
  label,
  detail,
}: {
  readonly label: ReactNode;
  readonly detail?: ReactNode;
}) => (
  <Box gap={1}>
    <SpinnerGlyph />
    <Text>{label}</Text>
    {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
  </Box>
);

export const ProgressBar = ({
  value,
  width = 24,
  showPercent = true,
  label,
  detail,
  variant = "success",
}: {
  /** Completion ratio. Values outside 0..1 are clamped. */
  readonly value: number;
  readonly width?: number;
  readonly showPercent?: boolean;
  readonly label?: ReactNode;
  readonly detail?: ReactNode;
  readonly variant?: StatusVariant;
}) => {
  const { unicode } = useCliEnvironment();
  const ratio = Math.max(0, Math.min(1, value));
  const cells = Math.max(1, Math.floor(width));
  const filled = Math.round(cells * ratio);
  return (
    <Box gap={1}>
      <Text color={statusColor(variant)}>
        {(unicode ? "━" : "#").repeat(filled)}
      </Text>
      <Text tone="muted">{(unicode ? "─" : "-").repeat(cells - filled)}</Text>
      {showPercent ? (
        <Text tone="muted">{`${Math.round(ratio * 100)}%`.padStart(4)}</Text>
      ) : null}
      {label === undefined ? null : <Text>{label}</Text>}
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
};

export const Tabs = ({
  tabs,
  active,
}: {
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly marked?: boolean;
  }>;
  readonly active: string;
}) => {
  const glyphs = useGlyphs();
  return (
    <Box gap={1}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Text
            key={tab.id}
            bold={selected}
            color={selected ? theme.color.onAccent : undefined}
            backgroundColor={selected ? theme.color.accentMuted : undefined}
            dimColor={!selected}
          >
            {" "}
            {tab.marked ? (
              <Text color={selected ? theme.color.onAccent : theme.color.brand}>
                {glyphs.selected}{" "}
              </Text>
            ) : null}
            {tab.label}{" "}
          </Text>
        );
      })}
    </Box>
  );
};
