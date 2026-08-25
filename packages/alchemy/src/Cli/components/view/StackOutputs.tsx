/** @jsxImportSource react */
import { inspect } from "node:util";
import { AnsiText } from "@alchemy.run/sigil";
import type { ReactNode } from "react";
import {
  Box,
  DescriptionList,
  Link,
  SectionHeading,
  Text,
  useBorderStyle,
  useCliEnvironment,
} from "../ui/index.ts";
import { theme } from "../../CliKit/index.ts";

const isPlain = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean" ||
  typeof value === "undefined";

// Bare top-level strings (e.g. a URL output) stay unquoted for copy-paste;
// structured values go through `inspect`, whose ANSI colors ordinary `Text`
// would strip — so they render line-by-line through `AnsiText`.
const displayValue = (value: unknown, colors: boolean): ReactNode => {
  if (typeof value === "string") return value;
  if (isPlain(value)) return String(value);
  const text = inspect(value, {
    colors,
    compact: false,
    depth: 4,
    maxArrayLength: 20,
  });
  return (
    <Box flexDirection="column">
      {text.split("\n").map((line, index) => (
        <AnsiText key={index}>{line || " "}</AnsiText>
      ))}
    </Box>
  );
};

const isHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//.test(value);

type StackOutputsProps = { readonly value: unknown };

function StackOutputs({ value }: StackOutputsProps) {
  const { colors, input } = useCliEnvironment();
  const borderStyle = useBorderStyle();
  const entries =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : undefined;

  return (
    <Box flexDirection="column">
      {/* The horizontal rule is live-view chrome; plain output skips it. */}
      {input ? (
        <Box
          marginBottom={1}
          borderStyle={borderStyle}
          borderBottom
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.color.muted}
          borderDimColor
        >
          <SectionHeading>Outputs</SectionHeading>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <SectionHeading>Outputs</SectionHeading>
        </Box>
      )}
      {entries === undefined ? (
        isPlain(value) ? (
          <Text>{String(displayValue(value, colors))}</Text>
        ) : (
          displayValue(value, colors)
        )
      ) : entries.length === 0 ? (
        <Text tone="muted">None</Text>
      ) : (
        <DescriptionList
          stacked={!input}
          labelWidth={Math.min(
            24,
            Math.max(8, ...entries.map(([key]) => key.length + 1)),
          )}
          items={entries.map(([key, item]) => ({
            label: key,
            value:
              input && isHttpUrl(item) ? (
                <Link href={item}>{item}</Link>
              ) : (
                displayValue(item, colors)
              ),
          }))}
        />
      )}
    </Box>
  );
}

export const stackOutputsView = (value: unknown): ReactNode => (
  <StackOutputs value={value} />
);
