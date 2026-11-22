import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Region of the SQL server and database. Some subscriptions (free trials)
 * refuse new SQL servers in `eastus` (`ProvisioningDisabled`), so this
 * example uses `centralus`. The Function stays in the stack's default
 * region.
 */
export const SQL_LOCATION = "centralus";

/** SQL administrator login of the server. The Function signs in as it. */
export const ADMIN_LOGIN = "todoadmin";

/**
 * The administrator password. `Alchemy.Random` generates it once and keeps
 * it in state. Azure SQL wants three of four character kinds (upper case,
 * lower case, digits, symbols), and hex has only two, so a fixed `Az!`
 * prefix adds the other two.
 *
 * `Output.named` gives the value a stable app-setting key, so the deployed
 * Function can read it back.
 */
export const AdminPassword = Effect.gen(function* () {
  const random = yield* Alchemy.Random("SqlAdminPassword", { bytes: 24 });
  return Output.named(
    Output.map(random.text, (hex) => Redacted.make(`Az!${Redacted.value(hex)}`)),
    "SQL_ADMIN_PASSWORD",
  );
});

/** The logical server: the endpoint and firewall. It has no compute charge. */
export const Sql = Effect.gen(function* () {
  const password = yield* AdminPassword;
  return yield* Azure.Sql.Server("Sql", {
    location: SQL_LOCATION,
    administratorLogin: ADMIN_LOGIN,
    administratorLoginPassword: password,
  });
});

/**
 * `0.0.0.0` to `0.0.0.0` is Azure's rule for "allow Azure services". Flex
 * Consumption instances have no fixed outbound IP, so the Function needs it
 * to reach the server's public endpoint. Other clients stay blocked.
 */
export const AllowAzureServices = Effect.gen(function* () {
  const server = yield* Sql;
  return yield* Azure.Sql.FirewallRule("AllowAzureServices", {
    server: server.serverName,
    startIpAddress: "0.0.0.0",
    endIpAddress: "0.0.0.0",
  });
});

/**
 * The app database: Basic tier (5 DTU, 2 GB), the cheapest fixed tier,
 * with locally redundant backups.
 */
export const Todos = Effect.gen(function* () {
  const server = yield* Sql;
  return yield* Azure.Sql.Database("Todos", {
    server: server.serverName,
    sku: { name: "Basic" },
    requestedBackupStorageRedundancy: "Local",
  });
});
