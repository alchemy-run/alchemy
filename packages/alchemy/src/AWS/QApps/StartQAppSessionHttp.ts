import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { StartQAppSession } from "./StartQAppSession.ts";

export const StartQAppSessionHttp = Layer.effect(
  StartQAppSession,
  makeQAppHttpBinding<
    qapps.StartQAppSessionInput,
    qapps.StartQAppSessionOutput,
    qapps.StartQAppSessionError
  >({
    capability: "StartQAppSession",
    iamActions: ["qapps:StartQAppSession"],
    operation: qapps.startQAppSession,
    injectAppId: true,
  }),
);
