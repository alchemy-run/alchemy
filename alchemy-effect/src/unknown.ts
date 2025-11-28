import { type Output, isOutput } from "./output.ts";
import type { Input } from "./input.ts";

// @ts-expect-error - we want to allow any value to be checked for unknown
export const isUnknown = <V>(value: V): value is Output<Input.Resolve<V>> =>
  isOutput(value);
