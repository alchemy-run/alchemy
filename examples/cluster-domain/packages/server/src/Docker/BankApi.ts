import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { bankFetch } from "../Http.ts";
import BankLive, { Database } from "./Bank.ts";

/** Published on the host: http://localhost:8080. */
export const PORT = 8080;

/** The bank's HTTP Api, as a service on the local Docker swarm. */
export default class BankApi extends Docker.Service<BankApi>()(
  "BankApi",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: PORT, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(Database)),
  Effect.gen(function* () {
    return { fetch: yield* bankFetch };
  }).pipe(Effect.provide(BankLive)),
) {}
