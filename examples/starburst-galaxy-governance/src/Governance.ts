import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Effect from "effect/Effect";
import { Crm } from "./Crm.ts";

const { Governance, Role } = StarburstGalaxy;

/**
 * EU analysts read `crm.customers`, see only EU rows, and see emails
 * hashed. The email column is tagged `pii` so Galaxy's catalog explorer
 * shows why it is masked.
 */
export const EuCustomers = Effect.gen(function* () {
  const crm = yield* Crm;

  const pii = yield* Governance.Tag("Pii", {
    color: "#D92D20",
    description: "Personal data",
  });
  yield* Governance.TagAssignment("EmailIsPii", {
    tag: pii.tagId,
    catalog: crm.catalogId,
    schema: "crm",
    table: "customers",
    column: "email",
  });

  const euOnly = yield* Governance.RowFilter("EuOnly", { expression: "region = 'EU'" });
  const hashed = yield* Governance.ColumnMask("HashEmail", {
    type: "Varchar",
    expression: 'to_hex(sha256(to_utf8("@column")))',
  });

  const analysts = yield* Role.Role("EuAnalysts", { description: "Reads EU customers" });
  const policy = yield* Governance.Policy("EuCustomers", {
    role: analysts.roleId,
    predicate: "true",
    description: "EU rows of crm.customers, emails hashed",
    scopes: [
      {
        entityKind: "Table",
        entityId: crm.catalogId,
        schemaName: "crm",
        tableName: "customers",
        privileges: { grantKind: "Allow", privilege: ["Select"] },
        rowFilterIds: [euOnly.rowFilterId],
      },
      {
        entityKind: "Column",
        entityId: crm.catalogId,
        schemaName: "crm",
        tableName: "customers",
        columnName: "email",
        columnMaskIds: [hashed.columnMaskId],
      },
    ],
  });

  return { crm, pii, euOnly, hashed, analysts, policy };
});
