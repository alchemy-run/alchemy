import * as Cloudflare from "@alchemy.run/cloudflare";
import { scaleWorker } from "./scale.ts";

/** Ten models, laid out as Domain version 1: every object in one class. */
export default class DomainScaleV1Worker extends Cloudflare.Worker<DomainScaleV1Worker>()(
  "DomainScaleWorker",
  { main: import.meta.url },
  scaleWorker(1),
) {}
