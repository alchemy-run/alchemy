/** @jsxImportSource react */
import { useAnimation } from "@alchemy.run/sigil";
import type { ReactNode } from "react";
import {
  statusColor,
  statusPaint,
  theme,
  type StatusVariant,
} from "../../CliKit/theme.ts";
import {
  useBorderStyle,
  useCliEnvironment,
  useGlyphs,
} from "./Environment.tsx";
import { Box } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface StatusProps {
  readonly variant?: StatusVariant;
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
}

export function Status({ variant = "info", children, detail }: StatusProps) {
  const glyphs = useGlyphs();
  return (
    <Box gap={1} flexWrap="wrap">
      <Text color={statusColor(variant)}>{glyphs[variant]}</Text>
      <Text color={variant === "error" ? statusColor(variant) : undefined}>
        {children}
      </Text>
      {detail === undefined ? null : <Text tone="muted">· {detail}</Text>}
    </Box>
  );
}

export type ToastProps = StatusProps;

/** Compact application notice, distinguished by its semantic rail. */
export function Toast({ variant = "info", children, detail }: ToastProps) {
  const borderStyle = useBorderStyle();
  return (
    <Box
      paddingLeft={1}
      borderStyle={borderStyle}
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={statusPaint(variant)}
    >
      <Status variant={variant} detail={detail}>
        {children}
      </Status>
    </Box>
  );
}

export interface AlertProps extends StatusProps {
  readonly title?: ReactNode;
}

export function Alert({
  variant = "info",
  title,
  children,
  detail,
}: AlertProps) {
  const borderStyle = useBorderStyle();
  const glyphs = useGlyphs();
  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={statusPaint(variant)}
      paddingLeft={1}
    >
      <Box gap={1} alignItems="center">
        <Text bold color={statusColor(variant)}>
          {glyphs[variant]} {variant.toUpperCase()}
        </Text>
        {title === undefined ? null : <Text bold>{title}</Text>}
        {detail === undefined ? null : <Text tone="muted">· {detail}</Text>}
      </Box>
      <Box paddingLeft={1}>
        <Text>{children}</Text>
      </Box>
    </Box>
  );
}

type KeyBarProps = {
  readonly keys: ReadonlyArray<readonly [key: string, label: string]>;
  readonly marginTop?: number;
};

export function KeyBar({ keys, marginTop = 1 }: KeyBarProps) {
  return (
    <Box
      width="100%"
      flexWrap="wrap"
      marginTop={marginTop}
      paddingLeft={theme.space.indent}
    >
      {keys.map(([key, label], index) => (
        <Box key={`${key}:${label}`}>
          {index === 0 ? null : <Text tone="muted"> • </Text>}
          <Text>
            <Text bold color={theme.color.brand}>
              {key}
            </Text>
            <Text tone="muted"> {label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

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

export const useSpinnerFrame = (): string => {
  const { unicode } = useCliEnvironment();
  const frames = unicode ? SPINNER_FRAMES : ASCII_SPINNER_FRAMES;
  const { frame } = useAnimation({ interval: 80 });
  return frames[frame % frames.length] ?? ASCII_SPINNER_FRAMES[0];
};

/**
 * Spinner-as-status-icon: one animated frame, colorable so it can stand in
 * for a status glyph in trees and progress rows.
 */
type SpinnerGlyphProps = { readonly color?: string };

export function SpinnerGlyph({ color }: SpinnerGlyphProps) {
  return <Text color={color ?? theme.color.info}>{useSpinnerFrame()}</Text>;
}

type SpinnerProps = {
  readonly label: ReactNode;
  readonly detail?: ReactNode;
};

export function Spinner({ label, detail }: SpinnerProps) {
  return (
    <Box gap={1}>
      <SpinnerGlyph />
      <Text>{label}</Text>
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
}

type ProgressBarProps = {
  /** Completion ratio. Values outside 0..1 are clamped. */
  readonly value: number;
  readonly width?: number;
  readonly showPercent?: boolean;
  readonly label?: ReactNode;
  readonly detail?: ReactNode;
  readonly variant?: StatusVariant;
};

export function ProgressBar({
  value,
  width = 24,
  showPercent = true,
  label,
  detail,
  variant = "success",
}: ProgressBarProps) {
  const { unicode } = useCliEnvironment();
  const ratio = Math.max(0, Math.min(1, value));
  const cells = Math.max(1, Math.floor(width));
  const filled = Math.round(cells * ratio);
  return (
    <Box
      gap={1}
      aria-role="progressbar"
      aria-label={`${Math.round(ratio * 100)}%`}
      aria-state={{ busy: ratio < 1 }}
    >
      <Text>
        <Text color={statusPaint(variant)}>
          {(unicode ? "█" : "#").repeat(filled)}
        </Text>
        <Text tone="muted">{(unicode ? "░" : ".").repeat(cells - filled)}</Text>
      </Text>
      {showPercent ? (
        <Text tone="muted">{`${Math.round(ratio * 100)}%`.padStart(4)}</Text>
      ) : null}
      {label === undefined ? null : <Text>{label}</Text>}
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
}

type TabsProps = {
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly marked?: boolean;
  }>;
  readonly active: string;
};

export function Tabs({ tabs, active }: TabsProps) {
  const glyphs = useGlyphs();
  return (
    <Box
      width="100%"
      gap={1}
      paddingLeft={theme.space.indent}
      marginBottom={1}
      aria-role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Box
            key={tab.id}
            paddingX={1}
            backgroundColor={selected ? theme.paint.interactive : undefined}
            aria-role="tab"
            aria-label={tab.label}
            aria-state={{ selected }}
          >
            <Text
              bold={selected}
              color={selected ? theme.color.onAccent : undefined}
              dimColor={!selected}
            >
              {tab.marked ? (
                <Text
                  color={selected ? theme.color.onAccent : theme.color.brand}
                >
                  {glyphs.selected}{" "}
                </Text>
              ) : null}
              {tab.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
