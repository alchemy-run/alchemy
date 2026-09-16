import * as Layer from "effect/Layer";
import { ServiceProvider } from "./Service.ts";

/**
 * The local Server providers: {@link Service} (a bundled Effect program
 * running as a detached local process, pid tracked in state).
 */
export const providers = () => Layer.mergeAll(ServiceProvider());
