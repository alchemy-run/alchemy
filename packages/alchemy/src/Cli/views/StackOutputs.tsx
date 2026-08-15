/** @jsxImportSource react */
import { inspect } from "node:util";
import type { ReactNode } from "react";
import { Box, DescriptionList, Text } from "../CliKit/components.ts";
import { theme } from "../CliKit/index.ts";

const displayValue = (value: unknown): string => {
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
    breakLength: Infinity,
    colors: false,
    compact: true,
    depth: 4,
    maxArrayLength: 20,
  });
};

const StackOutputs = ({ value }: { readonly value: unknown }) => {
  const entries =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : undefined;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.color.accent}>
        Outputs
      </Text>
      {entries === undefined ? (
        <Text>{displayValue(value)}</Text>
      ) : entries.length === 0 ? (
        <Text tone="muted">None</Text>
      ) : (
        <DescriptionList
          labelWidth={Math.min(
            24,
            Math.max(8, ...entries.map(([key]) => key.length + 1)),
          )}
          items={entries.map(([key, item]) => ({
            label: key,
            value: displayValue(item),
          }))}
        />
      )}
    </Box>
  );
};

export const stackOutputsView = (value: unknown): ReactNode => (
  <StackOutputs value={value} />
);
