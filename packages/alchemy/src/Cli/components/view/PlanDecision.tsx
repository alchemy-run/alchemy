/** @jsxImportSource react */
import { useMemo, useState, type JSX } from "react";
import type { Plan } from "../../../Plan.ts";
import {
  Box,
  PromptFrame,
  ChoiceGroup,
  useKeyGlyphs,
  useTerminalInput,
} from "../ui/index.ts";
import { Screen, type ScreenController } from "../../CliKit/index.ts";
import { PlanView, PlanViewStore } from "./PlanView.tsx";

export interface PlanDecisionChoice<Value> {
  readonly value: Value;
  readonly label: string;
}

function PlanDecision<Value>(props: {
  readonly plan: Plan;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
  readonly controller: ScreenController<Value>;
}): JSX.Element {
  const { plan, message, choices, initialValue, controller } = props;
  const store = useMemo(() => new PlanViewStore(plan), [plan]);
  const [selected, setSelected] = useState(initialValue);
  const keys = useKeyGlyphs();

  useTerminalInput((_input, key) => {
    if (key.enter) controller.submit(selected);
    else if (key.escape) controller.cancel();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <PlanView store={store} mode="review" viewport="virtual" />
      <PromptFrame
        message={message}
        keys={[
          [keys.upDown, "scroll plan"],
          [keys.leftRight, "choose"],
          [keys.enter, "confirm"],
          [keys.escape, "cancel"],
        ]}
      >
        <ChoiceGroup
          choices={choices}
          value={selected}
          onChange={setSelected}
        />
      </PromptFrame>
    </Box>
  );
}

export const planDecisionScreen = <Value,>(options: {
  readonly plan: Plan;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
}) =>
  Screen.make<Value>("plan decision", (controller) => (
    <PlanDecision {...options} controller={controller} />
  ));
