import type * as cf from "@cloudflare/workers-types";
import { makeDurableObjectCallbackFactory as makeNativeFactory } from "alchemy/Workers/Workerd/AlarmCallback";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  initializeAlarmCallbacks,
  dispatchAlarmCallbacks,
} from "alchemy/Workers/Workerd/AlarmCallback";

export const makeDurableObjectCallbackFactory = (state: cf.DurableObjectState) =>
  makeNativeFactory(state, DurableObjectState);
