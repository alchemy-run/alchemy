import * as Cloudflare from "@alchemy.run/cloudflare";
import { scaleWorker } from "./scale.ts";

/** Ten models, laid out as before Domain versions existed. */
export default class DomainScaleNoneWorker extends Cloudflare.Worker<DomainScaleNoneWorker>()(
  "DomainScaleWorker",
  { main: import.meta.url },
  scaleWorker(undefined),
) {}
