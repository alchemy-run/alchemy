import * as Azure from "@alchemy.run/azure";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * The PostgreSQL role the API signs in as. It reads and writes rows; it
 * cannot change the schema. Migrations run as the server administrator.
 */
export const APP_ROLE = "app_user";

export const database = Effect.gen(function* () {
  // The administrator password: generated once and kept in state, apart
  // from the server, so a deploy interrupted while the server is created
  // still knows it. Azure wants three of four character kinds and hex has
  // two, so a fixed prefix adds upper case and a symbol.
  const adminRandom = yield* Alchemy.Random("AdminPassword", { bytes: 24 });
  const adminPassword = Output.map(adminRandom.text, (hex) =>
    Redacted.make(`Aa1-${Redacted.value(hex)}`),
  );

  // Burstable Standard_B1ms with 32 GiB storage: the cheapest flexible
  // server. Some subscriptions cannot create flexible servers in eastus
  // (`LocationIsOfferRestricted`), so the server lives in centralus.
  const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
    location: "centralus",
    version: "17",
    administratorLoginPassword: adminPassword,
  });

  // Flex Consumption apps have no fixed outbound addresses. The special
  // 0.0.0.0 rule lets connections from Azure services in; the server
  // still requires TLS and a password.
  yield* Azure.PostgreSQL.FirewallRule("AllowAzureServices", {
    server: server.serverName,
    startIpAddress: "0.0.0.0",
    endIpAddress: "0.0.0.0",
  });

  const db = yield* Azure.PostgreSQL.Database("App", {
    server: server.serverName,
    name: "app",
  });

  // The application role's password: generated once (hex) and kept in state.
  const appPassword = yield* Alchemy.Random("AppPassword", { bytes: 24 });

  // drizzle-kit writes a new migration to ./migrations whenever
  // src/schema.ts changes.
  const schema = yield* Drizzle.Schema("Schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  return { server, db, appPassword, schema };
});
