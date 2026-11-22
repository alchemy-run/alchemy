import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import { bindingRoutes } from "./bindings-routes.ts";

/** A Lambda function (a host outside Modal) driving every Modal binding. */
export default class ModalBindingsFunction extends AWS.Lambda.Function<ModalBindingsFunction>()(
  "ModalBindingsFunction",
  { main: import.meta.url, timeout: Duration.minutes(14), memorySize: 1024 },
  bindingRoutes,
) {}
