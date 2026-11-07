import type { WorkerdDurableObjectState } from "alchemy/Workers/Workerd/DurableObjectState";

declare const state: WorkerdDurableObjectState;

// A helper written against the ambient global `DurableObjectState`.
const describe = (ctx: DurableObjectState): string => ctx.id.toString();
describe(state.raw);

// @ts-expect-error `raw` stays strictly typed, never `any`.
export const notANumber: number = state.raw;
