import * as Layer from "effect/Layer";
import { Alerts } from "./Alerts.ts";
import { makeAlertingBinding, makeAlertsClient } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link Alerts}, on the instance's Alertmanager API.
 *
 * @layer
 * @provides Stackit.Observability.Alerts
 */
export const AlertsHttp = Layer.succeed(Alerts, makeAlertingBinding(makeAlertsClient));
