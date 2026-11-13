import { turnstileLive } from "../turnstile-live.ts";
import { Default } from "./cluster.ts";

export default turnstileLive(import.meta.url, Default);
