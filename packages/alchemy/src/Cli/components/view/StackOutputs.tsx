/** @jsxImportSource react */
import { AnsiText } from "@alchemy.run/sigil";
import { inspect } from "node:util";
import type { ReactNode } from "react";
import { Box, useCliEnvironment } from "../ui/index.ts";

type StackOutputsProps = { readonly value: unknown };

function StackOutputs({ value }: StackOutputsProps) {
  const { colors } = useCliEnvironment();
  const output = inspect(value, { colors });

  return (
    <Box flexDirection="column">
      {output.split("\n").map((line, index) => (
        <AnsiText key={index} wrap="none">
          {line || " "}
        </AnsiText>
      ))}
    </Box>
  );
}

export const stackOutputsView = (value: unknown): ReactNode => (
  <StackOutputs value={value} />
);
