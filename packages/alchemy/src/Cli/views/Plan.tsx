/** @jsxImportSource react */
import { useMemo, type JSX } from "react";
import { Box, Row, TaskRow, Text, useGlyphs } from "../CliKit/components.ts";
import type {
  Plan as AlchemyPlan,
  CRUD,
  ActionApply,
  ActionDelete,
} from "../../Plan.ts";
import {
  actionHasPlannedWork,
  buildNamespaceTree,
  flattenTree,
  resourceHasPlannedWork,
} from "../NamespaceTree.ts";
import { formatModeNote } from "../ModeTag.ts";
import { theme } from "../CliKit/index.ts";
import { NamespaceRow, namespaceStyle } from "./PlanRow.tsx";

export interface PlanProps {
  plan: AlchemyPlan;
  /** First tree row to render, used by interactive plan review. */
  offset?: number;
  /** Maximum tree rows to render. Omit to render the complete plan. */
  limit?: number;
}

const buildPlanContent = (plan: AlchemyPlan) => {
  const allItems = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  const allTaskItems = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionApply | ActionDelete => task !== undefined);
  const workItems = allItems.filter(resourceHasPlannedWork);
  const items = allItems.map((item) =>
    resourceHasPlannedWork(item) ? item : { ...item, bindings: [] },
  );
  const taskItems = allTaskItems.filter(actionHasPlannedWork);
  return {
    items,
    workItems,
    taskItems,
    flatItems: flattenTree(buildNamespaceTree(items, taskItems)),
  };
};

export const countPlanRows = (plan: AlchemyPlan): number =>
  buildPlanContent(plan).flatItems.length;

export function Plan({ plan, offset = 0, limit }: PlanProps): JSX.Element {
  const glyphs = useGlyphs();
  const { items, workItems, taskItems, flatItems } = useMemo(
    () => buildPlanContent(plan),
    [plan],
  );

  if (items.length === 0 && taskItems.length === 0) {
    return <Text tone="muted">No resources in plan.</Text>;
  }

  const counts = { create: 0, update: 0, delete: 0, noop: 0, replace: 0 };
  for (const item of workItems) counts[item.action]++;
  const taskCounts = { run: 0, noop: 0, delete: 0 };
  for (const item of taskItems) taskCounts[item.action]++;
  const bindingChanges = workItems.reduce(
    (count, item) =>
      count +
      item.bindings.filter((binding) => binding.action !== "noop").length,
    0,
  );

  const actions = (["create", "update", "delete", "replace"] as const).filter(
    (action) => counts[action] > 0,
  );
  const summary = [
    ...actions.map((action) => ({
      key: action,
      label: `${counts[action]} to ${action}`,
      color: namespaceStyle(action).color,
    })),
    ...(taskCounts.run > 0
      ? [
          {
            key: "run",
            label: `${taskCounts.run} to run`,
            color: namespaceStyle("run").color,
          },
        ]
      : []),
    ...(taskCounts.delete > 0
      ? [
          {
            key: "drop",
            label: `${taskCounts.delete} to drop`,
            color: namespaceStyle("delete").color,
          },
        ]
      : []),
    ...(bindingChanges > 0
      ? [
          {
            key: "bindings",
            label: `${bindingChanges} binding changes`,
            color: theme.color.info,
          },
        ]
      : []),
  ];
  const start = Math.max(0, Math.min(offset, flatItems.length));
  const end =
    limit === undefined
      ? flatItems.length
      : Math.min(flatItems.length, start + Math.max(1, limit));
  const visibleItems = flatItems.slice(start, end);

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text underline>Plan</Text>
        <Text>: </Text>
        {summary.length === 0 ? (
          <Text tone="muted">no changes</Text>
        ) : (
          summary.map((item, index) => (
            <Box key={item.key}>
              {index === 0 ? null : <Text> | </Text>}
              <Text color={item.color}>{item.label}</Text>
            </Box>
          ))
        )}
      </Box>
      <Box flexDirection="column">
        {start > 0 ? (
          <Text tone="muted">
            {glyphs.overflowUp} {start} earlier rows
          </Text>
        ) : null}
        {visibleItems.map((item) => {
          const style = namespaceStyle(item.action);
          const key = item.path.join("/");

          if (item.type === "namespace") {
            return (
              <NamespaceRow
                key={key}
                id={item.id}
                depth={item.depth}
                action={item.action}
              />
            );
          }

          if (item.type === "binding") {
            return (
              <Row key={key} gap={1} paddingLeft={item.depth * 2}>
                <Text color={style.color}>{glyphs[style.icon]}</Text>
                <Text color={theme.color.info}>{item.bindingSid}</Text>
              </Row>
            );
          }

          if (item.type === "action") {
            return (
              <TaskRow
                key={key}
                icon={glyphs[style.icon]}
                iconColor={style.color}
                label={item.id}
                depth={item.depth}
              >
                <Text color={theme.color.info}>[action]</Text>
              </TaskRow>
            );
          }

          // Resource item
          const modeNote = formatModeNote({
            mode: item.providerMode,
            priorMode: item.fromProviderMode,
            defaultMode: plan.defaultMode,
          });
          return (
            <TaskRow
              key={key}
              icon={glyphs[style.icon]}
              iconColor={style.color}
              label={item.id}
              depth={item.depth}
            >
              {modeNote && <Text tone="muted">({modeNote})</Text>}
            </TaskRow>
          );
        })}
        {end < flatItems.length ? (
          <Text tone="muted">
            {glyphs.overflowDown} {flatItems.length - end} more rows
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
