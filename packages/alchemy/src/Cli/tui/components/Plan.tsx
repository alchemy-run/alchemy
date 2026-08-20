/** @jsxImportSource react */
import { useMemo, type JSX } from "react";

import { Box, Text, useStdout } from "ink";
import type {
  Plan as AlchemyPlan,
  BindingAction,
  CRUD,
  ActionApply,
  ActionDelete,
} from "../../../Plan.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type DerivedAction,
  type ActionVerb,
} from "../../NamespaceTree.ts";
import { formatModeNote } from "../../ModeTag.ts";
import {
  fitCreatedPropertyValue,
  fitPropertyChangeValues,
  formatPropertyPath,
  propertyDiffLayout,
  toFormattedPropertyChange,
  type FormattedPropertyChange,
  type PropertyChange,
  type PropertyValue,
} from "../../PropertyDiff.ts";

export interface PlanProps {
  plan: AlchemyPlan;
  detailed?: boolean;
}
export function Plan({ plan, detailed = false }: PlanProps): JSX.Element {
  const { stdout } = useStdout();
  const terminalColumns = stdout.columns ?? 120;
  const items = useMemo(
    () =>
      [
        ...Object.values(plan.resources),
        ...Object.values(plan.deletions),
      ] as CRUD[],
    [plan],
  );
  const taskItems = useMemo(
    () =>
      [
        ...Object.values(plan.actions ?? {}),
        ...Object.values(plan.actionDeletions ?? {}),
      ].filter((t): t is ActionApply | ActionDelete => t !== undefined),
    [plan],
  );

  const flatItems = useMemo(() => {
    const tree = buildNamespaceTree(items, taskItems);
    return flattenTree(tree, { includePropertyChanges: detailed });
  }, [detailed, items, taskItems]);
  if (items.length === 0 && taskItems.length === 0) {
    return <Text color="gray">No changes planned</Text>;
  }

  const counts = items.reduce((acc, item) => (acc[item.action]++, acc), {
    create: 0,
    update: 0,
    delete: 0,
    noop: 0,
    replace: 0,
  });
  const taskCounts = taskItems.reduce(
    (acc, item) => (acc[item.action]++, acc),
    { run: 0, noop: 0, delete: 0 },
  );

  const actions = (["create", "update", "delete", "replace"] as const).filter(
    (action) => counts[action] > 0,
  );
  const taskHeaderEntries = [
    taskCounts.run > 0 ? `${taskCounts.run} to run` : undefined,
    taskCounts.delete > 0 ? `${taskCounts.delete} to drop` : undefined,
  ].filter((s): s is string => !!s);

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text underline>Plan</Text>
        <Text>: </Text>
        {[
          ...actions.map((action) => {
            const count = counts[action];
            const color = actionColor(action);
            return (
              <Box key={action}>
                <Text color={color}>
                  {count} to {action}
                </Text>
              </Box>
            );
          }),
          ...taskHeaderEntries.map((label, i) => (
            <Box key={`task-${i}`}>
              <Text color="cyan">{label}</Text>
            </Box>
          )),
        ].flatMap((box, i, arr) =>
          i === arr.length - 1
            ? [box]
            : [box, <Text key={`sep-${i}`}> | </Text>],
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {flatItems.map((item, index) => {
          const indent = "  ".repeat(item.depth);
          const color = getActionColor(item.action);
          const icon = getActionIcon(item.action);
          const key = item.path.join("/");

          if (item.type === "namespace") {
            return (
              <Box key={key} flexDirection="row">
                <Text>{indent}</Text>
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Text color="blueBright">{item.id}</Text>
              </Box>
            );
          }

          if (item.type === "binding") {
            return (
              <Box key={key} flexDirection="row">
                <Text>{indent}</Text>
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Text color="cyan">{item.bindingSid}</Text>
              </Box>
            );
          }

          if (item.type === "action") {
            return (
              <Box key={key} flexDirection="row">
                <Text>{indent}</Text>
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Box>
                  <Text bold>{item.id}</Text>
                </Box>
                <Box marginLeft={1}>
                  <Text color="blackBright">({item.actionType})</Text>
                </Box>
                <Box marginLeft={1}>
                  <Text color="cyan">[action]</Text>
                </Box>
              </Box>
            );
          }

          // Resource item
          const modeNote = formatModeNote({
            mode: item.providerMode,
            priorMode: item.fromProviderMode,
            defaultMode: plan.defaultMode,
          });
          const resourceRowProps = {
            indent,
            color,
            icon,
            id: item.id,
            resourceType: item.resourceType,
            bindingCount: item.bindingCount,
            modeNote,
          };
          if (!detailed) {
            return <ResourceRow key={key} {...resourceRowProps} />;
          }

          const propertyColumns = Math.max(0, terminalColumns - indent.length);
          const propertyLayout =
            item.action !== "create" && item.propertyChanges?.length
              ? propertyDiffLayout(
                  item.propertyChanges.map(toFormattedPropertyChange),
                  propertyColumns,
                )
              : undefined;
          return (
            <Box key={key} flexDirection="column" marginTop={index > 0 ? 1 : 0}>
              <ResourceRow {...resourceRowProps} />
              {item.propertyChanges?.length === 0 && (
                <Text color="gray">
                  {`${indent}  `}
                  {item.action === "create"
                    ? "no declared properties"
                    : "no declared property changes"}
                </Text>
              )}
              {item.propertyChanges && item.propertyChanges.length > 0 && (
                <PropertyChanges
                  changes={item.propertyChanges}
                  indent={`${indent}  `}
                  layout={propertyLayout}
                  columns={propertyColumns}
                  created={item.action === "create"}
                />
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function ResourceRow({
  indent,
  color,
  icon,
  id,
  resourceType,
  bindingCount,
  modeNote,
}: {
  indent: string;
  color: Color;
  icon: string;
  id: string;
  resourceType?: string;
  bindingCount?: number;
  modeNote?: string;
}): JSX.Element {
  return (
    <Box flexDirection="row">
      <Text>{indent}</Text>
      <Box width={2}>
        <Text color={color}>{icon} </Text>
      </Box>
      <Box>
        <Text bold>{id}</Text>
      </Box>
      <Box marginLeft={1}>
        <Text color="blackBright">({resourceType})</Text>
      </Box>
      {modeNote && (
        <Box marginLeft={1}>
          <Text color="blackBright">({modeNote})</Text>
        </Box>
      )}
      {bindingCount !== undefined && bindingCount > 0 && (
        <Box marginLeft={1}>
          <Text color="cyan">({bindingCount} bindings)</Text>
        </Box>
      )}
    </Box>
  );
}

type Color = Parameters<typeof Text>[0]["color"];

type AnyAction = CRUD["action"] | BindingAction | DerivedAction | ActionVerb;

const getActionColor = (action: AnyAction): Color =>
  ({
    noop: "gray",
    create: "green",
    update: "yellow",
    delete: "red",
    replace: "magenta",
    mixed: "cyan",
    run: "cyan",
  })[action] ?? "gray";

const getActionIcon = (action: AnyAction): string =>
  ({
    create: "+",
    update: "~",
    delete: "-",
    noop: "•",
    replace: "!",
    mixed: "*",
    run: "λ",
  })[action] ?? "?";

const actionColor = (action: CRUD["action"]): Color => getActionColor(action);

function PropertyChanges({
  changes,
  indent,
  layout,
  columns,
  created,
}: {
  changes: PropertyChange[];
  indent: string;
  layout: ReturnType<typeof propertyDiffLayout>;
  columns: number;
  created: boolean;
}): JSX.Element {
  const rows = changes.map(toFormattedPropertyChange);

  if (created) {
    return (
      <>
        {rows.map((row) => (
          <Text key={`${row.kind}/${row.path}`}>
            {indent}
            <Text color="green">+</Text>{" "}
            <Text bold>{formatPropertyPath(row.path)}</Text>
            {"  "}
            <PropertyValueText
              text={fitCreatedPropertyValue(row, columns)}
              value={row.afterValue}
              fallbackColor="green"
            />
          </Text>
        ))}
      </>
    );
  }

  if (!layout) {
    return (
      <>
        {rows.flatMap((row) => [
          <Text key={`${row.kind}/${row.path}`}>
            {indent}
            <Text color={propertyChangeColor(row.kind)}>
              {propertyChangeSymbol(row.kind)}
            </Text>{" "}
            <Text bold>{row.path}</Text>
          </Text>,
          <Text key={`${row.kind}/${row.path}/before`}>
            {indent} <Text color="gray">├─ before</Text>
            {"  "}
            <PropertyValueText
              text={row.before}
              value={row.beforeValue}
              fallbackColor={beforeColor(row.kind)}
            />
          </Text>,
          <Text key={`${row.kind}/${row.path}/after`}>
            {indent} <Text color="gray">└─ after </Text>
            {"  "}
            <PropertyValueText
              text={row.after}
              value={row.afterValue}
              fallbackColor={afterColor(row.kind)}
            />
          </Text>,
        ])}
      </>
    );
  }

  return (
    <>
      {rows.map((row) => {
        const values = fitPropertyChangeValues(row, layout);
        return (
          <Text key={`${row.kind}/${row.path}`}>
            {indent}
            <Text color={propertyChangeColor(row.kind)}>
              {propertyChangeSymbol(row.kind)}
            </Text>{" "}
            <Text bold>{formatPropertyPath(row.path)}</Text>
            {"  "}
            <PropertyValueText
              text={values.before}
              value={row.beforeValue}
              fallbackColor={beforeColor(row.kind)}
            />
            <Text color="gray"> → </Text>
            <PropertyValueText
              text={values.after}
              value={row.afterValue}
              fallbackColor={afterColor(row.kind)}
            />
          </Text>
        );
      })}
    </>
  );
}

const propertyChangeSymbol = (kind: FormattedPropertyChange["kind"]): string =>
  kind === "add" ? "+" : kind === "remove" ? "-" : "~";

const propertyChangeColor = (kind: FormattedPropertyChange["kind"]): Color =>
  kind === "add" ? "green" : kind === "remove" ? "red" : "yellow";

const beforeColor = (kind: FormattedPropertyChange["kind"]): Color =>
  kind === "add" ? "gray" : "red";

const afterColor = (kind: FormattedPropertyChange["kind"]): Color =>
  kind === "remove" ? "gray" : "green";

function PropertyValueText({
  text,
  value,
  fallbackColor,
}: {
  text: string;
  value: PropertyValue | undefined;
  fallbackColor: Color;
}): JSX.Element {
  const color: Color = !value
    ? "yellow"
    : value.kind === "redacted"
      ? "magenta"
      : value.kind === "known-after-apply" || value.kind === "computed"
        ? "cyan"
        : fallbackColor;
  return <Text color={color}>{text}</Text>;
}
