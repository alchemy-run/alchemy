/** @jsxImportSource react */
import { inspect } from "node:util";
import type { ReactNode } from "react";
import {
  Box,
  DescriptionList,
  Link,
  SectionHeading,
  Text,
  useBorderStyle,
  useCliEnvironment,
} from "../CliKit/components.ts";
import { theme } from "../CliKit/index.ts";

const displayValue = (value: unknown, colors: boolean): string => {
  // Bare top-level strings (e.g. a URL output) stay unquoted for copy-paste.
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return String(value);
  }
  return inspect(value, {
    colors,
    compact: false,
    depth: 4,
    maxArrayLength: 20,
  });
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
      {entries === undefined ? (
        <Text>{displayValue(value, colors)}</Text>
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
