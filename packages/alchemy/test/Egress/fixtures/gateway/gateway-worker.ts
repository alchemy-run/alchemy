import * as Cloudflare from "@/Cloudflare";
import { serveTestGateway } from "./serve.ts";

/** Serves {@link TestGateway} from a Worker. */
export default class GatewayWorker extends Cloudflare.Worker<GatewayWorker>()(
  "EgressGatewayWorker",
  { main: import.meta.url },
  serveTestGateway,
) {}
