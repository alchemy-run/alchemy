import { checkoutLive } from "../workflows/checkout-live.ts";
import { Default } from "./cluster.ts";

export default checkoutLive(import.meta.url, Default);
