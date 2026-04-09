import * as ServiceMap from "effect/ServiceMap";

export class Request extends ServiceMap.Service<Request, globalThis.Request>()(
  "Request",
) {}
