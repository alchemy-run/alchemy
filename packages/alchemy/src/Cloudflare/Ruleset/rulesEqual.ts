import { deepEqual } from "../../Diff.ts";
import type { OutputRule, Rule } from "./Ruleset.ts";

/** Compare API rules without their generated identity/version fields. */
export const rulesEqual = (
  observed: readonly OutputRule[],
  desired: readonly Rule[],
) =>
  observed.length === desired.length &&
  observed.every((rule, index) => {
    const wanted = desired[index]!;
    const normalize = (value: OutputRule | Rule) =>
      Object.fromEntries(
        Object.entries({ enabled: true, description: "", ...value }).filter(
          ([key, item]) =>
            item !== undefined &&
            key !== "version" &&
            key !== "lastUpdated" &&
            (key !== "id" || wanted.id !== undefined) &&
            (key !== "ref" || wanted.ref !== undefined),
        ),
      );
    return deepEqual(normalize(rule), normalize(wanted));
  });
