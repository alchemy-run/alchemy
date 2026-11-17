import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { bankFetch } from "../Http.ts";
import BankLive from "./Bank.ts";

/** The bank's HTTP Api, as a Lambda function with a public URL. */
export default class BankApi extends Lambda.Function<BankApi>()(
  "BankApi",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    return { fetch: yield* bankFetch };
  }).pipe(Effect.provide(BankLive)),
) {}
