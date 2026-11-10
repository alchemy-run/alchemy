import type * as cf from "@cloudflare/workers-types";
import {
  fromDurableObjectState,
  type WorkerdDurableObjectState,
} from "alchemy/Workers/Workerd/DurableObjectState";

declare const state: WorkerdDurableObjectState;

// A helper written against the module export.
const describe = (ctx: cf.DurableObjectState): string => ctx.id.toString();
describe(state.raw);

// `raw` round-trips through alchemy's converter.
fromDurableObjectState(state.raw);

// @ts-expect-error `raw` stays strictly typed, never `any`.
export const notANumber: number = state.raw;
