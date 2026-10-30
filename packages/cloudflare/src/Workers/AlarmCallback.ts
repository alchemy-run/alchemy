import type * as cf from "@cloudflare/workers-types";
import { makeDurableObjectCallbackFactory as makeWorkerdCallbackFactory } from "alchemy/Workers/Workerd/AlarmCallback";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
} from "alchemy/Workers/Workerd/AlarmCallback";

/** @internal */
export const makeDurableObjectCallbackFactory = (raw: cf.DurableObjectState) =>
  makeWorkerdCallbackFactory(raw, DurableObjectState);
