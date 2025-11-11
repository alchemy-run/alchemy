// biome-ignore lint/style/useImportType: UMD global
import React, { useMemo } from "react";

import type { BindNode, CRUD, Plan } from "alchemy-effect";
import { Box, Text } from "ink";

export interface PlanProps {
  plan: Plan;
}
export function Plan({ plan }: PlanProps): React.JSX.Element {
  const items = useMemo(
    () =>
      (
        [
          ...Object.values(plan.resources),
          ...Object.values(plan.deletions),
        ] as CRUD[]
      ).sort((n1, n2) => n1.resource.id.localeCompare(n2.resource.id)),
    [plan],
  );

  if (items.length === 0) {
    return <Text color="gray">No changes planned</Text>;
  }

  const counts = items.reduce((acc, item) => (acc[item.action]++, acc), {
    create: 0,
    update: 0,
    delete: 0,
    noop: 0,
    replace: 0,
  });

  const actions = (["create", "update", "delete", "replace"] as const).filter(
    (action) => counts[action] > 0,
  );

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text underline>Plan</Text>
        <Text>: </Text>
        {actions.flatMap((action, i) => {
          const count = counts[action];
          const color = actionColor(action);
          if (count === 0) return [];
          const box = (
            <Box key={action}>
              <Text color={color}>
                {count} to {action}
              </Text>
            </Box>
          );
          return i === actions.length - 1
            ? [box]
            : [box, <Text key={actions[i]}> | </Text>];
        })}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item) => {
          const color = actionColor(item.action);
          const icon = actionIcon(item.action);
          const hasBindings = item.bindings && item.bindings.length > 0;

          return (
            <Box key={item.resource.id} flexDirection="column">
              <Box flexDirection="row">
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Box width={12}>
                  <Text bold>{item.resource.id}</Text>
                </Box>
                <Box width={25}>
                  <Text color="blackBright">({item.resource.type})</Text>
                </Box>
                {/* <Box width={12}>
                  <Text color={color}>{item.action}</Text>
                </Box> */}
                {hasBindings && (
                  <Box>
                    <Text color={"cyan"}>
                      ({item.bindings!.length} bindings)
                    </Text>
                  </Box>
                )}
              </Box>

              {/* Show bindings as sub-items */}
              {hasBindings &&
                item.bindings!.map((node) => {
                  const bindingColor = bindingActionColor(node.action);
                  const bindingIcon = bindingActionIcon(node.action);
                  return (
                    <Box
                      key={node.binding.capability.resource.id}
                      flexDirection="row"
                    >
                      <Box width={4}>
                        <Text color={bindingColor}> {bindingIcon}</Text>
                      </Box>
                      <Box width={40}>
                        <Text color="cyan">
                          {node.binding.capability.label}
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

type Color = Parameters<typeof Text>[0]["color"];

const actionColor = (action: CRUD["action"]): Color =>
  ({
    noop: "gray",
    create: "green",
    update: "yellow",
    delete: "red",
    replace: "orange",
  })[action];

const actionIcon = (action: CRUD["action"]): string =>
  ({
    create: "+",
    update: "~",
    delete: "-",
    noop: "•",
    replace: "!",
  })[action];

const bindingActionColor = (
  action: BindNode["action"],
): Parameters<typeof Text>[0]["color"] =>
  ({
    attach: "green",
    detach: "red",
    noop: "gray",
    reattach: "orange",
  })[action];

const bindingActionIcon = (action: BindNode["action"]): string =>
  ({
    attach: "+",
    detach: "-",
    noop: "•",
    reattach: "~",
  })[action];
