/** @jsxImportSource react */
import type { ReactNode } from "react";
import { theme } from "../theme.ts";
import { useCliEnvironment } from "./Environment.tsx";
import { Box } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface TableColumn<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly width?: number;
  readonly grow?: number;
  readonly align?: "left" | "right";
}

export interface TableProps<Row> {
  readonly rows: ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<TableColumn<Row>>;
  readonly getKey: (row: Row, index: number) => string;
  readonly empty?: ReactNode;
  readonly separators?: boolean;
  readonly header?: boolean;
  readonly dividerWidth?: number;
}

const Cell = ({
  children,
  width,
  grow,
  align = "left",
}: {
  readonly children?: ReactNode;
  readonly width?: number;
  readonly grow?: number;
  readonly align?: "left" | "right";
}) => (
  <Box
    width={width}
    flexGrow={grow}
    flexShrink={width === undefined ? 1 : 0}
    justifyContent={align === "right" ? "flex-end" : "flex-start"}
    paddingRight={1}
  >
    <Text wrap="truncate-end">{children}</Text>
  </Box>
);

/** Column layout shared by human-readable list/show commands. */
export const Table = <Row,>({
  rows,
  columns,
  getKey,
  empty = "No entries.",
  separators = false,
  header = true,
  dividerWidth,
}: TableProps<Row>) => {
  const { columns: terminalColumns, unicode } = useCliEnvironment();
  if (rows.length === 0) return <Text tone="muted">{empty}</Text>;
  return (
    <Box flexDirection="column">
      {header ? (
        <>
          <Box>
            {columns.map((column) => (
              <Cell
                key={column.key}
                width={column.width}
                grow={column.grow}
                align={column.align}
              >
                <Text bold color={theme.color.accent}>
                  {column.header}
                </Text>
              </Cell>
            ))}
          </Box>
          <Text tone="muted">
            {(unicode ? "─" : "-").repeat(
              Math.max(
                1,
                Math.min(
                  terminalColumns,
                  dividerWidth ??
                    columns.reduce(
                      (width, column) => width + (column.width ?? 12),
                      0,
                    ),
                ),
              ),
            )}
          </Text>
        </>
      ) : null}
      {rows.map((row, index) => (
        <Box key={getKey(row, index)} flexDirection="column">
          {index === 0 || !separators ? null : <Text> </Text>}
          <Box>
            {columns.map((column) => (
              <Cell
                key={column.key}
                width={column.width}
                grow={column.grow}
                align={column.align}
              >
                {column.cell(row)}
              </Cell>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export interface DescriptionItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
}

export const DescriptionList = ({
  items,
  labelWidth = 16,
}: {
  readonly items: ReadonlyArray<DescriptionItem>;
  readonly labelWidth?: number;
}) => (
  <Box flexDirection="column">
    {items.map((item, index) => (
      <Box key={index}>
        <Box width={labelWidth} paddingRight={1}>
          <Text tone="muted">{item.label}</Text>
        </Box>
        <Text>{item.value}</Text>
      </Box>
    ))}
  </Box>
);
