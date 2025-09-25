import { PlanRejected, ReviewPlan, type AnyPlan } from "@alchemy.run/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import pc from "picocolors";
import * as Clack from "./clack.ts";

export const review = Layer.succeed(
  ReviewPlan,
  ReviewPlan.of({
    review: <P extends AnyPlan>(plan: P) =>
      Effect.gen(function* () {
        yield* Clack.note(yield* renderPlan(plan), "Plan");

        const approved = yield* Clack.confirm({
          message: "Are you sure you want to apply these changes?",
        });
        if (Clack.isCancel(approved) || approved === false) {
          yield* Clack.outro("Operation cancelled.");
          yield* Effect.fail(new PlanRejected());
        }

        return plan;
      }),
  }),
);

export const renderPlan = Effect.fn(function* (plan: AnyPlan) {
  // First pass: compute optimal column widths
  let maxActionWidth = 0;
  let maxTypeWidth = 0;

  for (const node of Object.values(plan)) {
    const actionText = `[${node.action}]`;
    const typeText = node.resource.type;

    maxActionWidth = Math.max(maxActionWidth, actionText.length);
    maxTypeWidth = Math.max(maxTypeWidth, typeText.length);
  }

  // Second pass: display with optimal spacing
  return Object.entries(plan)
    .map(([id, node]) => {
      const actionColor =
        node.action === "create"
          ? pc.green
          : node.action === "update"
            ? pc.yellow
            : node.action === "delete"
              ? pc.red
              : pc.gray;
      const actionText = `[${node.action}]`;
      const typeText = node.resource.type;
      const idText = id;
      return `${actionColor(actionText.padEnd(maxActionWidth))} ${pc.cyan(typeText.padEnd(maxTypeWidth))} ${pc.bold(idText)}`;
    })
    .join("\n");
});
