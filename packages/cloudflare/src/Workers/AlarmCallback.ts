import type * as cf from "@cloudflare/workers-types";
import { makeDurableObjectCallbackFactory as makeWorkerdCallbackFactory } from "alchemy/Workers/Workerd/AlarmCallback";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
  outsideAlarmPass,
} from "alchemy/Workers/Workerd/AlarmCallback";

/** @internal */
export const makeDurableObjectCallbackFactory = (
  raw: cf.DurableObjectState,
  random: SecureRandom.SecureRandom["Service"],
) => makeWorkerdCallbackFactory(raw, DurableObjectState, random);
