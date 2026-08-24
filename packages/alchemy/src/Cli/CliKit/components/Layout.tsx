/** @jsxImportSource react */
import { Box as SigilBox, type DOMElement } from "@alchemy.run/sigil";
import {
  forwardRef,
  type ComponentProps,
  type ForwardRefExoticComponent,
  type PropsWithoutRef,
  type ReactNode,
  type RefAttributes,
} from "react";
import { theme } from "../theme.ts";
import { useCliEnvironment, useGlyphs } from "./Environment.tsx";
import { Text } from "./Typography.tsx";

export type BoxProps = ComponentProps<typeof SigilBox>;

/** Theme-aware Sigil container used by CliKit layouts. */
export const Box: ForwardRefExoticComponent<
  PropsWithoutRef<BoxProps> & RefAttributes<DOMElement>
> = forwardRef<DOMElement, BoxProps>(function Box(props, ref) {
  const { colors } = useCliEnvironment();
  const {
    borderColor: _borderColor,
    borderTopColor: _borderTopColor,
    borderBottomColor: _borderBottomColor,
    borderLeftColor: _borderLeftColor,
    borderRightColor: _borderRightColor,
    borderBackgroundColor: _borderBackgroundColor,
    borderTopBackgroundColor: _borderTopBackgroundColor,
    borderBottomBackgroundColor: _borderBottomBackgroundColor,
    borderLeftBackgroundColor: _borderLeftBackgroundColor,
    borderRightBackgroundColor: _borderRightBackgroundColor,
    backgroundColor: _backgroundColor,
    borderDimColor: _borderDimColor,
    borderTopDimColor: _borderTopDimColor,
    borderBottomDimColor: _borderBottomDimColor,
    borderLeftDimColor: _borderLeftDimColor,
    borderRightDimColor: _borderRightDimColor,
    ...colorless
  } = props;
  return <SigilBox {...(colors ? props : colorless)} ref={ref} />;
});

export interface StackProps extends Omit<BoxProps, "flexDirection"> {
  readonly gap?: number;
}

/** Vertical layout primitive. */
export function Stack({ children, gap = 0, ...props }: StackProps) {
  return (
    <Box flexDirection="column" gap={gap} {...props}>
      {children}
    </Box>
  );
}

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
export function Row({
  children,
  gap = 1,
  align = "flex-start",
  justify = "flex-start",
  ...props
}: RowProps) {
  return (
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
}

type HeadingProps = {
  readonly children?: ReactNode;
  /** Set false to drop the section glyph prefix (e.g. help-screen headings). */
  readonly glyph?: boolean;
};

export function Heading({ children, glyph = true }: HeadingProps) {
  const glyphs = useGlyphs();
  return (
    <Box>
      <Text
        bold
        color={theme.color.onAccent}
        backgroundColor={theme.color.accent}
      >
        {" "}
        {glyph ? `${glyphs.section} ` : null}
        {children}{" "}
      </Text>
    </Box>
  );
}

type SectionHeadingProps = {
  readonly children?: ReactNode;
  readonly annotation?: ReactNode;
};

export function SectionHeading({ children, annotation }: SectionHeadingProps) {
  return (
    <Text>
      <Text
        bold
        color={theme.color.onAccent}
        backgroundColor={theme.color.accent}
      >
        {" "}
        {children}{" "}
      </Text>
      {annotation === undefined ? null : (
        <Text tone="muted"> · {annotation}</Text>
      )}
    </Text>
  );
}

type GutterProps = {
  readonly depth?: number;
  readonly children?: ReactNode;
};

export function Gutter({ depth = 1, children }: GutterProps) {
  return (
    <Box paddingLeft={Math.max(0, depth) * 2}>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

/** Windowed list keeping `cursor` centered; each item renders as a block. */
type ViewportProps<Item> = {
  readonly items: ReadonlyArray<Item>;
  readonly cursor?: number;
  readonly height: number;
  readonly renderItem: (item: Item, index: number) => ReactNode;
  readonly getKey: (item: Item, index: number) => string;
  readonly empty?: ReactNode;
};

export function Viewport<Item>({
  items,
  cursor = 0,
  height,
  renderItem,
  getKey,
  empty,
}: ViewportProps<Item>) {
  if (items.length === 0) return <>{empty}</>;
  const count = Math.max(1, height);
  const selected = Math.max(0, Math.min(cursor, items.length - 1));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), items.length - count),
  );
  const end = Math.min(items.length, start + count);
  return (
    <Stack>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        return (
          <Box key={getKey(item, index)} flexDirection="column">
            {renderItem(item, index)}
          </Box>
        );
      })}
    </Stack>
  );
}
