import crypto from "node:crypto";
import * as Redacted from "effect/Redacted";
import { Client } from "pg";
import type { SqlFile } from "../../Sql/SqlFile.ts";
import type { PostgresOrigin } from "./PostgresOrigin.ts";

type TrackedSqlFileAction = "reject" | "reapply";

const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export interface PostgresLogicalDatabaseOwner {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly version: number;
}

export interface AppRolePrivilegeState {
  readonly hash: string;
  readonly ready: boolean;
}

const validateIdentifier = (label: string, value: string) => {
  if (!POSTGRES_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} "${value}" must start with a lowercase letter and contain only lowercase letters, numbers, and underscores.`,
    );
  }
};

const quoteIdentifier = (value: string) => {
  validateIdentifier("Postgres identifier", value);
  return `"${value}"`;
};

const quoteExternalIdentifier = (label: string, value: string) => {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(
      `${label} "${value}" must be a non-empty Postgres identifier.`,
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
};

const quoteQualifiedIdentifier = (schema: string, value: string) =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(value)}`;

const postgresErrorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const hashJson = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const originConnectionUrl = (origin: PostgresOrigin, database: string) => {
  const url = new URL(`${origin.scheme}://localhost`);
  url.hostname = origin.host;
  url.port = String(origin.port);
  url.username = origin.user;
  url.password = Redacted.value(origin.password);
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
};

const stripPgSslQueryParams = (uri: string): string => {
  try {
    const url = new URL(uri);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return uri;
  }
};

const withPostgresClient = async <A>(
  origin: PostgresOrigin,
  database: string,
  use: (client: Client) => Promise<A>,
) => {
  const client = new Client({
    connectionString: stripPgSslQueryParams(
      originConnectionUrl(origin, database),
    ),
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
};

const ignoreDatabaseAlreadyExists = (error: unknown) => {
  if (postgresErrorCode(error) === "42P04") return;
  throw error;
};

const createDatabase = async (client: Client, databaseName: string) => {
  try {
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    );
  } catch (error) {
    ignoreDatabaseAlreadyExists(error);
  }
};

export const databaseExists = async (
  origin: PostgresOrigin,
  databaseName: string,
) => {
  validateIdentifier("Postgres database", databaseName);

  return withPostgresClient(origin, "postgres", async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );
    return rows[0]?.exists === true;
  });
};

export const ensureDatabase = async (
  origin: PostgresOrigin,
  databaseName: string,
) => {
  validateIdentifier("Postgres database", databaseName);

  await withPostgresClient(origin, "postgres", async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );

    if (rows[0]?.exists !== true) {
      await createDatabase(client, databaseName);
    }
  });
};

export const dropDatabase = async (
  origin: PostgresOrigin,
  databaseName: string,
) => {
  validateIdentifier("Postgres database", databaseName);

  await withPostgresClient(origin, "postgres", async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );

    if (rows[0]?.exists === true) {
      await client.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
    }
  });
};

export const readDatabaseOwnership = async (input: {
  readonly databaseName: string;
  readonly origin: PostgresOrigin;
  readonly ownerResourceType: string;
  readonly tableName: string;
}) => {
  validateIdentifier("Postgres database", input.databaseName);
  validateIdentifier("Postgres ownership table", input.tableName);

  return withPostgresClient(
    input.origin,
    input.databaseName,
    async (client) => {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${input.tableName}`],
      );

      if (exists.rows[0]?.exists !== true) return undefined;

      const owners = await client.query<PostgresLogicalDatabaseOwner>(
        `SELECT logical_id AS "logicalId", resource_type AS "resourceType", owner_version AS "version"
       FROM ${quoteIdentifier(input.tableName)}
       WHERE resource_type = $1
       LIMIT 1`,
        [input.ownerResourceType],
      );

      return owners.rows[0];
    },
  );
};

export const ensureDatabaseOwnership = async (input: {
  readonly databaseName: string;
  readonly origin: PostgresOrigin;
  readonly owner: PostgresLogicalDatabaseOwner;
  readonly tableName: string;
}) => {
  validateIdentifier("Postgres database", input.databaseName);
  validateIdentifier("Postgres ownership table", input.tableName);

  const table = quoteIdentifier(input.tableName);

  await withPostgresClient(input.origin, input.databaseName, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        resource_type text PRIMARY KEY,
        logical_id text NOT NULL,
        owner_version integer NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `INSERT INTO ${table} (resource_type, logical_id, owner_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (resource_type) DO UPDATE
       SET logical_id = excluded.logical_id,
           owner_version = excluded.owner_version,
           updated_at = now()`,
      [input.owner.resourceType, input.owner.logicalId, input.owner.version],
    );
  });
};

export const readTrackedSqlFileHashes = async (input: {
  readonly databaseName: string;
  readonly origin: PostgresOrigin;
  readonly tableName: string;
}) => {
  validateIdentifier("Postgres database", input.databaseName);
  validateIdentifier("Postgres tracking table", input.tableName);

  return withPostgresClient(
    input.origin,
    input.databaseName,
    async (client) => {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${input.tableName}`],
      );

      if (exists.rows[0]?.exists !== true) return {};

      const hashes = await client.query<{ name: string; hash: string }>(
        `SELECT name, hash FROM ${quoteIdentifier(input.tableName)} ORDER BY name`,
      );

      return Object.fromEntries(hashes.rows.map((row) => [row.name, row.hash]));
    },
  );
};

const readExistingTrackedSqlFileHashes = async (
  client: Client,
  tableName: string,
): Promise<Record<string, string>> => {
  const hashes = await client.query<{ name: string; hash: string }>(
    `SELECT name, hash FROM ${quoteIdentifier(tableName)} ORDER BY name`,
  );
  return Object.fromEntries(hashes.rows.map((row) => [row.name, row.hash]));
};

export const removedRecordNames = (
  desiredFiles: readonly Pick<SqlFile, "id">[],
  existingRecords: Record<string, string>,
) => {
  const desiredNames = new Set(desiredFiles.map((file) => file.id));
  return Object.keys(existingRecords)
    .filter((name) => !desiredNames.has(name))
    .sort();
};

const rejectRemovedTrackedSqlFiles = (
  tableName: string,
  removedNames: readonly string[],
) => {
  if (removedNames.length > 0) {
    throw new Error(
      `Refusing to remove tracked SQL file records from ${tableName}: ${removedNames.join(
        ", ",
      )}. Create a new forward migration/import instead.`,
    );
  }
};

const applyTrackedSqlFile = async (input: {
  readonly changedFileAction: TrackedSqlFileAction;
  readonly client: Client;
  readonly file: SqlFile;
  readonly tableName: string;
}) => {
  const existing = await input.client.query<{ hash: string }>(
    `SELECT hash FROM ${quoteIdentifier(input.tableName)} WHERE name = $1`,
    [input.file.id],
  );
  const existingHash = existing.rows[0]?.hash;

  if (existingHash === input.file.hash) return;

  if (existingHash && input.changedFileAction === "reject") {
    throw new Error(
      `Refusing to reapply changed SQL file ${input.file.id}; create a new migration/import file instead.`,
    );
  }

  await input.client.query("BEGIN");
  try {
    await input.client.query(input.file.sql);
    await input.client.query(
      `INSERT INTO ${quoteIdentifier(input.tableName)} (name, hash)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, applied_at = now()`,
      [input.file.id, input.file.hash],
    );
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
};

const applyChangedTrackedSqlFiles = async (input: {
  readonly changedFileAction: TrackedSqlFileAction;
  readonly client: Client;
  readonly files: readonly SqlFile[];
  readonly tableName: string;
}) => {
  await input.client.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(input.tableName)} (
      name text PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of input.files) {
    await applyTrackedSqlFile({
      changedFileAction: input.changedFileAction,
      client: input.client,
      file,
      tableName: input.tableName,
    });
  }
};

export const applyTrackedSqlFiles = async (input: {
  readonly changedFileAction: TrackedSqlFileAction;
  readonly databaseName: string;
  readonly files: readonly SqlFile[];
  readonly origin: PostgresOrigin;
  readonly tableName: string;
}) => {
  validateIdentifier("Postgres database", input.databaseName);
  validateIdentifier("Postgres tracking table", input.tableName);

  await withPostgresClient(input.origin, input.databaseName, async (client) => {
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${input.tableName}`],
    );
    const existingHashes =
      exists.rows[0]?.exists === true
        ? await readExistingTrackedSqlFileHashes(client, input.tableName)
        : {};
    rejectRemovedTrackedSqlFiles(
      input.tableName,
      removedRecordNames(input.files, existingHashes),
    );

    if (input.files.length > 0) {
      await applyChangedTrackedSqlFiles({
        changedFileAction: input.changedFileAction,
        client,
        files: input.files,
        tableName: input.tableName,
      });
    }
  });
};

export const ensureAppRolePrivileges = async (input: {
  readonly databaseName: string;
  readonly excludedTableNames: readonly string[];
  readonly origin: PostgresOrigin;
  readonly roleName: string;
}) => {
  validateIdentifier("Postgres database", input.databaseName);
  input.excludedTableNames.forEach((tableName) =>
    validateIdentifier("Postgres excluded table", tableName),
  );

  const database = quoteIdentifier(input.databaseName);
  const role = quoteExternalIdentifier("Postgres role", input.roleName);

  await withPostgresClient(input.origin, input.databaseName, async (client) => {
    await client.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${role}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    );

    for (const tableName of [...new Set(input.excludedTableNames)]) {
      const table = quoteQualifiedIdentifier("public", tableName);
      const exists = await client.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${tableName}`],
      );
      if (exists.rows[0]?.exists === true) {
        await client.query(
          `REVOKE ALL PRIVILEGES ON TABLE ${table} FROM ${role}`,
        );
      }
    }
  });
};

export const readAppRolePrivileges = async (input: {
  readonly databaseName: string;
  readonly excludedTableNames: readonly string[];
  readonly origin: PostgresOrigin;
  readonly roleName: string;
}): Promise<AppRolePrivilegeState> => {
  validateIdentifier("Postgres database", input.databaseName);
  input.excludedTableNames.forEach((tableName) =>
    validateIdentifier("Postgres excluded table", tableName),
  );

  const excludedTables = new Set(input.excludedTableNames);

  return withPostgresClient(
    input.origin,
    input.databaseName,
    async (client) => {
      const checks: { name: string; ok: boolean }[] = [];
      const roleRows = await client.query<{ oid: string }>(
        "SELECT oid::text AS oid FROM pg_roles WHERE rolname = $1",
        [input.roleName],
      );
      const roleOid = roleRows.rows[0]?.oid;

      if (!roleOid) {
        checks.push({ name: `role:${input.roleName}:exists`, ok: false });
        return {
          hash: hashJson(checks),
          ready: false,
        };
      }

      const databaseChecks = await client.query<{ name: string; ok: boolean }>(
        `SELECT 'database:connect' AS name,
              has_database_privilege($1::oid, current_database(), 'CONNECT') AS ok
       UNION ALL
       SELECT 'database:temporary' AS name,
              has_database_privilege($1::oid, current_database(), 'TEMPORARY') AS ok
       UNION ALL
       SELECT 'schema:public:usage' AS name,
              has_schema_privilege($1::oid, 'public', 'USAGE') AS ok`,
        [roleOid],
      );
      checks.push(...databaseChecks.rows);

      const tableChecks = await client.query<{
        granted: boolean;
        privilege: string;
        tableName: string;
      }>(
        `WITH privileges(privilege) AS (
         VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
       ),
       tables AS (
         SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_type = 'BASE TABLE'
       )
       SELECT
         has_table_privilege(
           $1::oid,
           format('%I.%I', tables.table_schema, tables.table_name),
           privileges.privilege
         ) AS granted,
         privileges.privilege,
         tables.table_name AS "tableName"
       FROM tables
       CROSS JOIN privileges
       ORDER BY tables.table_name, privileges.privilege`,
        [roleOid],
      );
      checks.push(
        ...tableChecks.rows.map((check) => ({
          name: `table:${check.tableName}:${check.privilege.toLowerCase()}`,
          ok: excludedTables.has(check.tableName)
            ? !check.granted
            : check.granted,
        })),
      );

      const sequenceChecks = await client.query<{
        granted: boolean;
        privilege: string;
        sequenceName: string;
      }>(
        `WITH privileges(privilege) AS (
         VALUES ('USAGE'), ('SELECT'), ('UPDATE')
       )
       SELECT
         has_sequence_privilege(
           $1::oid,
           format('%I.%I', sequences.sequence_schema, sequences.sequence_name),
           privileges.privilege
         ) AS granted,
         privileges.privilege,
         sequences.sequence_name AS "sequenceName"
       FROM information_schema.sequences
       CROSS JOIN privileges
       WHERE sequences.sequence_schema = 'public'
       ORDER BY sequences.sequence_name, privileges.privilege`,
        [roleOid],
      );
      checks.push(
        ...sequenceChecks.rows.map((check) => ({
          name: `sequence:${check.sequenceName}:${check.privilege.toLowerCase()}`,
          ok: check.granted,
        })),
      );

      const defaultPrivilegeChecks = await client.query<{
        granted: boolean;
        objectType: string;
        privilege: string;
      }>(
        `WITH desired(object_type, privilege) AS (
         VALUES
           ('r', 'SELECT'),
           ('r', 'INSERT'),
           ('r', 'UPDATE'),
           ('r', 'DELETE'),
           ('S', 'USAGE'),
           ('S', 'SELECT'),
           ('S', 'UPDATE')
       )
       SELECT
         EXISTS (
           SELECT 1
           FROM pg_default_acl default_acl
           CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl
           WHERE default_acl.defaclnamespace = 'public'::regnamespace
             AND default_acl.defaclrole = current_user::regrole
             AND default_acl.defaclobjtype = desired.object_type
             AND acl.grantee = $1::oid
             AND acl.privilege_type = desired.privilege
         ) AS granted,
         desired.object_type AS "objectType",
         desired.privilege
       FROM desired
       ORDER BY desired.object_type, desired.privilege`,
        [roleOid],
      );
      checks.push(
        ...defaultPrivilegeChecks.rows.map((check) => ({
          name: `default:${check.objectType}:${check.privilege.toLowerCase()}`,
          ok: check.granted,
        })),
      );

      const sortedChecks = checks.sort((a, b) => a.name.localeCompare(b.name));
      return {
        hash: hashJson(sortedChecks),
        ready: sortedChecks.every((check) => check.ok),
      };
    },
  );
};
