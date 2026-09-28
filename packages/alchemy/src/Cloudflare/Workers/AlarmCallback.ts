import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import { makeDurableObjectCallbackFactory as makeNativeFactory } from "../../Workers/Workerd/AlarmCallback.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  initializeAlarmCallbacks,
  dispatchAlarmCallbacks,
} from "../../Workers/Workerd/AlarmCallback.ts";

export const makeDurableObjectCallbackFactory = (
  state: cf.DurableObjectState,
) =>
  makeNativeFactory(state, (context) =>
    context.pipe(Context.omit(DurableObjectState)),
  );
