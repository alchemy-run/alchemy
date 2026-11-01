import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { TriggerHibernate } from "./TriggerHibernate.ts";

/**
 * HTTP implementation of {@link TriggerHibernate}.
 *
 * @layer
 * @provides Stackit.SKE.TriggerHibernate
 */
export const TriggerHibernateHttp = Layer.effect(
  TriggerHibernate,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.TriggerHibernate",
    access: SKE_ACCESS.hibernate,
    operation: ske.triggerHibernate,
  }),
);
