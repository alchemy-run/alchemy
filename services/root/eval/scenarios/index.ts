import type { Scenario } from "../scenario.ts";
import { affinity } from "./affinity.ts";
import { parking } from "./parking.ts";
import {
  rankingAffinity,
  rankingFollows,
  rankingHuman,
} from "./ranking.ts";
import { reviewBounce } from "./review-bounce.ts";
import { routing } from "./routing.ts";
import {
  walkClear,
  walkDeviate,
  walkDrag,
  walkDrill,
} from "./walk.ts";
import { width } from "./width.ts";

/** Every scenario, in the order `all` runs them. */
export const SCENARIOS: ReadonlyArray<Scenario> = [
  routing,
  affinity,
  rankingHuman,
  rankingFollows,
  rankingAffinity,
  walkDrill,
  walkClear,
  walkDrag,
  walkDeviate,
  width,
  parking,
  reviewBounce,
];

export const scenarioByName = (name: string): Scenario | undefined =>
  SCENARIOS.find((scenario) => scenario.name === name);
