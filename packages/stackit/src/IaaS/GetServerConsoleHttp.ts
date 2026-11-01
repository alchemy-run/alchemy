import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetServerConsole } from "./GetServerConsole.ts";

/**
 * HTTP implementation of {@link GetServerConsole}.
 *
 * @layer
 * @provides Stackit.IaaS.GetServerConsole
 */
export const GetServerConsoleHttp = Layer.effect(
  GetServerConsole,
  makeServerHttpBinding({
    tag: "Stackit.IaaS.GetServerConsole",
    access: { permissions: ["iaas.server.console-url.get"] },
    operation: iaas.getServerConsole,
  }),
);
