/** @jsxImportSource react */
import { useState, type JSX } from "react";
import {
  BooleanChoice,
  Box,
  KeyBar,
  Text,
  useGlyphs,
  useKeyGlyphs,
  useTerminalInput,
  useTerminalSize,
} from "../CliKit/components.ts";
import { Screen, theme, type ScreenController } from "../CliKit/index.ts";
import type { Plan as AlchemyPlan } from "../../Plan.ts";
import { countPlanRows, Plan } from "./Plan.tsx";

export interface ApprovePlanProps {
  plan: AlchemyPlan;
  controller: ScreenController<boolean>;
}

/**
 * Plan approval prompt: the plan tree followed by the same Yes/No choice and
 * key bar that `CliKit.confirm` renders. Escape cancels (treated as "no" by
 * the caller); Ctrl+C is handled centrally by the screen runner.
 */
export function ApprovePlan(props: ApprovePlanProps): JSX.Element {
  const { plan, controller } = props;
  const [approved, setApproved] = useState(true);
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const totalRows = countPlanRows(plan);
  const visibleRows = Math.max(4, rows - 14);
  const maxOffset = Math.max(0, totalRows - visibleRows);
  const [offset, setOffset] = useState(0);
  const scroll = (delta: number) =>
    setOffset((current) => Math.max(0, Math.min(maxOffset, current + delta)));

  const complete = (answer: boolean) =>
    controller.submit(
      answer,
      <Text color={answer ? theme.color.success : theme.color.danger}>
        {answer ? glyphs.success : glyphs.error} Proceed?{" "}
        {answer ? "Yes" : "No"}
      </Text>,
    );

  useTerminalInput((input, key) => {
    if (key.left || key.right || key.tab) setApproved((current) => !current);
    else if (key.up) scroll(-1);
    else if (key.down) scroll(1);
    else if (key.pageUp) scroll(-visibleRows);
    else if (key.pageDown) scroll(visibleRows);
    else if (key.home) setOffset(0);
    else if (key.end) setOffset(maxOffset);
    else if (key.enter) complete(approved);
    else if (key.escape) controller.cancel();
    else if (key.ctrl || key.meta) return;
    else if (input.toLowerCase() === "y") complete(true);
    else if (input.toLowerCase() === "n") complete(false);
  });

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Plan plan={plan} offset={offset} limit={visibleRows} />
      <Box flexDirection="column" gap={1}>
        <Text bold>Proceed?</Text>
        <BooleanChoice value={approved} />
        <KeyBar
          keys={[
            ...(maxOffset > 0 ? ([[keys.upDown, "scroll plan"]] as const) : []),
            [keys.yesNo, "choose"],
            [keys.enter, "confirm"],
            [keys.escape, "cancel"],
          ]}
        />
      </Box>
    </Box>
  );
}

export const approvePlanScreen = (plan: AlchemyPlan) =>
  Screen.make<boolean>("plan approval", (controller) => (
    <ApprovePlan plan={plan} controller={controller} />
  ));
