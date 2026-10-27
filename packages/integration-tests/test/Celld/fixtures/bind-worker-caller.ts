/** A caller-side module (e.g. a Lambda) that only binds a Celld Worker. */
import * as Celld from "@alchemy.run/celld";

export const bind = Celld.bindWorker;
