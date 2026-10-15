import * as Duration from "effect/Duration";
import * as Lambda from "@/AWS/Lambda";
import { serveTestGateway } from "./serve.ts";

/** Serves {@link TestGateway} from a Lambda Web Function, in four Regions. */
export default class GatewayWebFunction extends Lambda.WebFunction<GatewayWebFunction>()(
  "EgressGatewayWebFunction",
  {
    main: import.meta.url,
    authType: "ApplicationManaged",
    regions: ["us-east-1", "eu-west-1", "ap-northeast-1"],
    // A clone streams for as long as it takes.
    timeout: Duration.minutes(15),
  },
  serveTestGateway,
) {}
