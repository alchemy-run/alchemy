/** @jsxImportSource react */
import { Box as InkBox } from "ink";
import type { ComponentProps, JSX, ReactNode } from "react";
import { theme } from "../theme.ts";
import { useCliEnvironment, useGlyphs } from "./Environment.tsx";
import { Text } from "./Typography.tsx";

export type BoxProps = ComponentProps<typeof InkBox>;

/** General container primitive exposing Ink layout without leaking Ink imports. */
export const Box = (props: BoxProps) => <InkBox {...props} />;

export interface StackProps extends Omit<BoxProps, "flexDirection"> {
  readonly gap?: number;
}

/** Vertical layout primitive. */
export const Stack = ({ children, gap = 0, ...props }: StackProps) => (
  <Box flexDirection="column" gap={gap} {...props}>
    {children}
  </Box>
);

export interface RowProps extends Omit<
  BoxProps,
  "flexDirection" | "alignItems" | "justifyContent"
> {
  readonly gap?: number;
  readonly align?: "flex-start" | "center" | "flex-end";
  readonly justify?:
    | "flex-start"
    | "center"
    | "flex-end"
    | "space-between"
    | "space-around";
}

/** Horizontal layout primitive. */
export const Row = ({
  children,
  gap = 1,
  align = "flex-start",
  justify = "flex-start",
  ...props
}: RowProps) => (
  <Box
    flexDirection="row"
    gap={gap}
    alignItems={align}
    justifyContent={justify}
    {...props}
  >
    {children}
  </Box>
);

/** A responsive row whose children may wrap when the terminal is narrow. */
export const Columns = ({ children, gap = 2, ...props }: StackProps) => (
  <Box flexDirection="row" flexWrap="wrap" gap={gap} {...props}>
    {children}
  </Box>
);

export const Spacer = ({ size = 1 }: { readonly size?: number }) => (
  <Box height={Math.max(0, size)} />
);

export const Divider = ({
  label,
  width = "100%",
}: {
  readonly label?: string;
  readonly width?: number | string;
}) => {
  const { unicode } = useCliEnvironment();
  return (
    <Box width={width} gap={1}>
      {label === undefined ? null : <Text tone="muted">{label}</Text>}
      <Box flexGrow={1}>
        <Text tone="muted">{unicode ? "─" : "-"}</Text>
      </Box>
    </Box>
  );
};

export interface PanelProps {
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly width?: number | string;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly borderColor?: string;
  readonly grow?: number;
}

/** Bordered content region for cards, details panes and summaries. */
export const Panel = ({
  title,
  children,
  width,
  paddingX = 1,
  paddingY = 0,
  borderColor = theme.color.muted,
  grow,
}: PanelProps): JSX.Element => {
  const { unicode } = useCliEnvironment();
  return (
    <Box
      flexDirection="column"
      borderStyle={unicode ? "round" : "classic"}
      borderColor={borderColor}
      width={width}
      flexGrow={grow}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {title === undefined ? null : (
        <Box marginTop={-1} marginBottom={1}>
          <Text bold color={theme.color.accent}>
            {title}
          </Text>
        </Box>
      )}
      {children}
    </Box>
  );
};

export const Heading = ({
  children,
  glyph = true,
}: {
  readonly children?: ReactNode;
  /** Set false to drop the section glyph prefix (e.g. help-screen headings). */
  readonly glyph?: boolean;
}) => {
  const glyphs = useGlyphs();
  return (
    <Text bold color={theme.color.accent}>
      {glyph ? `${glyphs.section} ` : null}
      {children}
    </Text>
  );
};

export const SectionHeading = ({
  children,
  annotation,
}: {
  readonly children?: ReactNode;
  readonly annotation?: ReactNode;
}) => {
  const glyphs = useGlyphs();
  return (
    <Text>
      <Text bold tone="accent">
        {glyphs.section} {children}
      </Text>
      {annotation === undefined ? null : (
        <Text tone="muted"> {annotation}</Text>
      )}
    </Text>
  );
};

export const Gutter = ({
  depth = 1,
  children,
}: {
  readonly depth?: number;
  readonly children?: ReactNode;
}) => {
  const glyphs = useGlyphs();
  return (
    <Box>
      {depth <= 0 ? null : (
        <Text tone="muted">{`${glyphs.bar} `.repeat(depth)}</Text>
      )}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
};

export const Muted = ({ children }: { readonly children?: ReactNode }) => (
  <Text tone="muted">{children}</Text>
);

export const Code = ({ children }: { readonly children?: ReactNode }) => (
  <Text color={theme.color.info}>{children}</Text>
);
