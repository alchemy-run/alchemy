import { greeterLive } from "../greeter-live.ts";
import { Default } from "./cluster.ts";

export default greeterLive(import.meta.url, Default);
