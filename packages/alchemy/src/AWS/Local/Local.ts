/**
 * The AWS dev sidecar entry: serves the floci-backed local providers over
 * RPC so their long-lived state — `Bundle.watch` loops hot-swapping Lambda
 * code into the emulator — survives exec-process hot reloads during
 * `alchemy dev`. Mirrors the Cloudflare sidecar entry
 * ([Cloudflare/Local.ts](../../Cloudflare/Local.ts)).
 */
import * as RpcServer from "../../Local/RpcServer.ts";
import { FlociFunctionProvider } from "../Lambda/FlociFunctionProvider.ts";

FlociFunctionProvider().pipe(RpcServer.launch);
