import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { bankFetch } from "../Http.ts";
import BankLive from "./Bank.ts";

/** The bank's HTTP Api, as a Worker that reaches the pool through a service binding. */
export default class BankApi extends Cloudflare.Worker<BankApi>()(
  "BankApi",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    return { fetch: yield* bankFetch };
  }).pipe(Effect.provide(BankLive)),
) {}
