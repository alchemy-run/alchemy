import { unlink, writeFile } from "node:fs/promises";
import type { OpenAPIV3 } from "openapi-types";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import {
  ApiShield,
  getGlobalSettingsForZone,
  getOperationsForZone,
} from "../../src/cloudflare/api-shield.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { Schema } from "../../src/cloudflare/schema.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
  quiet: false,
});

const api = await createCloudflareApi({});

describe("ApiShield", () => {
  test("create and update schema validation with inline schema", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-schema-val-2.com`;
    let zone: Zone;
    let schema: Schema<string>;
    let validation: ApiShield;

    try {
      // Create a test zone
      zone = await Zone(`${BRANCH_PREFIX}-schema-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create schema first
      schema = await Schema(`${BRANCH_PREFIX}-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: List of users
    post:
      operationId: createUser
      responses:
        '201':
          description: User created
  /users/{id}:
    get:
      operationId: getUser
      responses:
        '200':
          description: User details
    delete:
      operationId: deleteUser
      responses:
        '204':
          description: User deleted
`,
        name: "test-api-schema",
        enabled: true,
      });

      // Create schema validation using the schema
      validation = await ApiShield(`${BRANCH_PREFIX}-validation`, {
        zone,
        schema,
        defaultAction: "none",
      });

      expect(validation).toMatchObject({
        zoneId: zone.id,
        zoneName: zone.name,
        schema: {
          id: schema.id,
          name: "test-api-schema",
          kind: "openapi_v3",
          validationEnabled: true,
        },
        settings: {
          defaultMitigationAction: "none",
        },
      });

      // Verify that operations were created correctly from the schema
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/users/{id}", action: "none" },
        { method: "get", endpoint: "/users", action: "none" },
        { method: "get", endpoint: "/users/{id}", action: "none" },
        { method: "post", endpoint: "/users", action: "none" },
      ]);

      // Also verify that operations exist in Cloudflare
      const cloudflareOperations = await getOperationsForZone(api, zone.id);
      expect(cloudflareOperations.length).toBeGreaterThanOrEqual(4);

      // Update with operation overrides using path-based configuration
      validation = await ApiShield(`${BRANCH_PREFIX}-validation`, {
        zone,
        schema,
        defaultAction: "none",
        actions: {
          "/users": {
            get: "none",
            post: "none",
          },
          "/users/{id}": {
            get: "none",
            delete: "none",
          },
        },
        unknownOperationAction: "none",
      });

      expect(validation.settings.defaultMitigationAction).toBe("none");
      expect(validation.settings.overrideMitigationAction).toBe("none");

      // Verify operation-specific settings were applied correctly
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/users/{id}", action: "none" },
        { method: "get", endpoint: "/users", action: "none" },
        { method: "get", endpoint: "/users/{id}", action: "none" },
        { method: "post", endpoint: "/users", action: "none" },
      ]);

      // Verify global settings
      const globalSettings = await getGlobalSettingsForZone(api, zone.id);
      expect(globalSettings.validation_default_mitigation_action).toBe("none");
      expect(globalSettings.validation_override_mitigation_action).toBe("none");
    } finally {
      await destroy(scope);
    }
  });

  test("create schema validation from file", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-schema-file.com`;
    let zone: Zone;
    let schema: Schema<URL>;
    let validation: ApiShield;

    try {
      // Create a test zone
      zone = await Zone(`${BRANCH_PREFIX}-schema-file-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create a temporary schema file
      const schemaPath = `/tmp/${BRANCH_PREFIX}-test-schema.yaml`;
      await writeFile(
        schemaPath,
        `
openapi: 3.0.0
info:
  title: File Test API
  version: 2.0.0
servers:
  - url: https://${zoneName}
paths:
  /products:
    get:
      operationId: listProducts
      responses:
        '200':
          description: Product list
  /orders:
    post:
      operationId: createOrder
      responses:
        '201':
          description: Order created
`,
      );

      // Create schema from file URL
      const fileUrl = new URL(`file://${schemaPath}`);
      schema = await Schema(`${BRANCH_PREFIX}-file-schema`, {
        zone: zone.id, // Test using zone ID string
        schema: fileUrl,
        name: "file-based-schema",
        enabled: false, // Start disabled
      });

      // Create schema validation from the schema
      validation = await ApiShield(`${BRANCH_PREFIX}-file-validation`, {
        zone: zone.id,
        schema,
        defaultAction: "none",
      });

      expect(validation).toMatchObject({
        zoneId: zone.id,
        schema: {
          id: schema.id,
          name: "file-based-schema",
          validationEnabled: false,
        },
        settings: {
          defaultMitigationAction: "none",
        },
      });

      // Verify operations were created even with validation disabled
      expectOperations(validation.operations, [
        { method: "get", endpoint: "/products", action: "none" },
        { method: "post", endpoint: "/orders", action: "none" },
      ]);

      // Update validation with action overrides
      validation = await ApiShield(`${BRANCH_PREFIX}-file-validation`, {
        zone: zone.id,
        schema,
        defaultAction: "none",
        actions: {
          "/orders": "none",
          "/products": "none",
        },
      });

      expect(validation.settings.defaultMitigationAction).toBe("none");

      // Verify operations still correct after updating validation
      expectOperations(validation.operations, [
        { method: "get", endpoint: "/products", action: "none" },
        { method: "post", endpoint: "/orders", action: "none" },
      ]);

      // Clean up temp file
      await unlink(schemaPath);
    } finally {
      await destroy(scope);
    }
  });

  test("create schema validation with typed OpenAPI object", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-typed-api.com`;
    let zone: Zone;
    let schema: Schema<OpenAPIV3.Document>;
    let validation: ApiShield;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-typed-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Define a typed OpenAPI schema
      const apiSchema: OpenAPIV3.Document = {
        openapi: "3.0.0",
        info: {
          title: "Typed API",
          version: "1.0.0",
        },
        servers: [{ url: `https://${zoneName}` }],
        paths: {
          "/products": {
            get: {
              operationId: "listProducts",
              responses: {
                "200": {
                  description: "Successful response",
                },
              },
            },
            post: {
              operationId: "createProduct",
              responses: {
                "201": {
                  description: "Product created",
                },
              },
            },
          },
        },
      };

      // Create schema with typed object
      schema = await Schema(`${BRANCH_PREFIX}-typed-schema`, {
        zone,
        schema: apiSchema,
        name: "typed-api-schema",
        enabled: true,
      });

      // Create schema validation with typed object
      validation = await ApiShield(`${BRANCH_PREFIX}-typed-validation`, {
        zone,
        schema,
        defaultAction: "none",
      });

      expect(validation).toMatchObject({
        zoneId: zone.id,
        zoneName: zone.name,
        schema: {
          id: schema.id,
          name: "typed-api-schema",
          kind: "openapi_v3",
          validationEnabled: true,
        },
        settings: {
          defaultMitigationAction: "none",
        },
      });

      // Verify operations were created from typed schema
      expectOperations(validation.operations, [
        { method: "get", endpoint: "/products", action: "none" },
        { method: "post", endpoint: "/products", action: "none" },
      ]);
    } finally {
      await destroy(scope);
    }
  });

  test("default action only - all operations use default", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-default-only.com`;
    let zone: Zone;
    let schema: Schema<string>;
    let validation: ApiShield;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-default-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create schema with multiple operations
      schema = await Schema(`${BRANCH_PREFIX}-default-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: Default Action API
  version: 1.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
    post:
      operationId: createUser
      responses:
        '201':
          description: Success
  /products:
    get:
      operationId: getProducts
      responses:
        '200':
          description: Success
  /orders:
    post:
      operationId: createOrder
      responses:
        '201':
          description: Success
    delete:
      operationId: deleteOrder
      responses:
        '204':
          description: Success
`,
        name: "default-action-schema",
        enabled: true,
      });

      // Create schema validation using only default action
      validation = await ApiShield(`${BRANCH_PREFIX}-default-validation`, {
        zone,
        schema,
        defaultAction: "none", // Only specify default action
      });

      // Verify all operations use the default action
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/orders", action: "none" },
        { method: "get", endpoint: "/products", action: "none" },
        { method: "get", endpoint: "/users", action: "none" },
        { method: "post", endpoint: "/orders", action: "none" },
        { method: "post", endpoint: "/users", action: "none" },
      ]);

      expect(validation.settings.defaultMitigationAction).toBe("none");
    } finally {
      await destroy(scope);
    }
  });

  test("default action with partial per-route overrides", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-partial-routes.com`;
    let zone: Zone;
    let schema: Schema<string>;
    let validation: ApiShield;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-partial-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create schema with mixed operations
      schema = await Schema(`${BRANCH_PREFIX}-partial-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: Partial Routes API
  version: 1.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
    post:
      operationId: createUser
      responses:
        '201':
          description: Success
  /products:
    get:
      operationId: getProducts
      responses:
        '200':
          description: Success
    post:
      operationId: createProduct
      responses:
        '201':
          description: Success
  /orders:
    post:
      operationId: createOrder
      responses:
        '201':
          description: Success
    delete:
      operationId: deleteOrder
      responses:
        '204':
          description: Success
`,
        name: "partial-routes-schema",
        enabled: true,
      });

      // Create schema validation with mixed action configuration
      validation = await ApiShield(`${BRANCH_PREFIX}-partial-validation`, {
        zone,
        schema,
        defaultAction: "none", // Default action
        actions: {
          // Override specific routes/methods
          "/users": "none", // Blanket action for all methods on /users
          "/orders": {
            post: "block", // Block order creation
            delete: "none", // Log order deletion
          },
          // /products will use default action "none"
        },
      });

      // Verify mixed actions:
      // - /users/* should be "none" (blanket override)
      // - /orders/post should be "block", /orders/delete should be "none" (per-method)
      // - /products/* should be "none" (default)
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/orders", action: "none" }, // Overridden per-method
        { method: "get", endpoint: "/products", action: "none" }, // Default action
        { method: "get", endpoint: "/users", action: "none" }, // Blanket override
        { method: "post", endpoint: "/orders", action: "block" }, // Overridden per-method
        { method: "post", endpoint: "/products", action: "none" }, // Default action
        { method: "post", endpoint: "/users", action: "none" }, // Blanket override
      ]);

      expect(validation.settings.defaultMitigationAction).toBe("none");
    } finally {
      await destroy(scope);
    }
  });

  test("all routes explicitly specified", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-all-routes.com`;
    let zone: Zone;
    let schema: Schema<string>;
    let validation: ApiShield;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-all-routes-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create schema with all routes
      schema = await Schema(`${BRANCH_PREFIX}-all-routes-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: All Routes API
  version: 1.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
    post:
      operationId: createUser
      responses:
        '201':
          description: Success
  /products:
    get:
      operationId: getProducts
      responses:
        '200':
          description: Success
  /admin:
    get:
      operationId: getAdmin
      responses:
        '200':
          description: Success
    post:
      operationId: adminAction
      responses:
        '200':
          description: Success
`,
        name: "all-routes-schema",
        enabled: true,
      });

      // Create schema validation with all routes explicitly specified
      validation = await ApiShield(`${BRANCH_PREFIX}-all-routes-validation`, {
        zone,
        schema,
        defaultAction: "none", // This should be overridden for all operations
        actions: {
          "/users": {
            get: "none",
            post: "block",
          },
          "/products": "none",
          "/admin": "block", // Block all admin operations
        },
      });

      // Verify all operations have their specified actions
      expectOperations(validation.operations, [
        { method: "get", endpoint: "/admin", action: "block" }, // Blanket admin block
        { method: "get", endpoint: "/products", action: "none" }, // Explicit none
        { method: "get", endpoint: "/users", action: "none" }, // Per-method override
        { method: "post", endpoint: "/admin", action: "block" }, // Blanket admin block
        { method: "post", endpoint: "/users", action: "block" }, // Per-method override
      ]);

      expect(validation.settings.defaultMitigationAction).toBe("none");
    } finally {
      await destroy(scope);
    }
  });

  test("schema change with operation removal", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-schema-change.com`;
    let zone: Zone;
    let schema: Schema<string>;
    let updatedSchema: Schema<string>;
    let validation: ApiShield;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-change-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create initial schema with multiple operations
      schema = await Schema(`${BRANCH_PREFIX}-initial-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: Initial API
  version: 1.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
    post:
      operationId: createUser
      responses:
        '201':
          description: Success
  /products:
    get:
      operationId: getProducts
      responses:
        '200':
          description: Success
    delete:
      operationId: deleteProduct
      responses:
        '204':
          description: Success
  /orders:
    post:
      operationId: createOrder
      responses:
        '201':
          description: Success
  /legacy:
    get:
      operationId: getLegacy
      responses:
        '200':
          description: Success
`,
        name: "initial-schema",
        enabled: true,
      });

      // Create initial validation
      validation = await ApiShield(`${BRANCH_PREFIX}-change-validation`, {
        zone,
        schema,
        defaultAction: "none",
      });

      // Verify all initial operations are created
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/products", action: "none" },
        { method: "get", endpoint: "/legacy", action: "none" },
        { method: "get", endpoint: "/products", action: "none" },
        { method: "get", endpoint: "/users", action: "none" },
        { method: "post", endpoint: "/orders", action: "none" },
        { method: "post", endpoint: "/users", action: "none" },
      ]);

      // Create updated schema with reduced operations (remove /legacy and /orders endpoints)
      updatedSchema = await Schema(`${BRANCH_PREFIX}-updated-schema`, {
        zone,
        schema: `
openapi: 3.0.0
info:
  title: Updated API
  version: 2.0.0
servers:
  - url: https://${zoneName}
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
    post:
      operationId: createUser
      responses:
        '201':
          description: Success
  /products:
    get:
      operationId: getProducts
      responses:
        '200':
          description: Success
    delete:
      operationId: deleteProduct
      responses:
        '204':
          description: Success
`,
        name: "updated-schema",
        enabled: true,
      });

      // Update validation with the new schema
      validation = await ApiShield(`${BRANCH_PREFIX}-change-validation`, {
        zone,
        schema: updatedSchema,
        defaultAction: "none", // Also change default action
        actions: {
          "/products": {
            delete: "block", // Override delete action
          },
        },
      });

      // Verify only the remaining operations exist with updated actions
      expectOperations(validation.operations, [
        { method: "delete", endpoint: "/products", action: "block" }, // Overridden action
        { method: "get", endpoint: "/products", action: "none" }, // Default action
        { method: "get", endpoint: "/users", action: "none" }, // Default action
        { method: "post", endpoint: "/users", action: "none" }, // Default action
      ]);

      expect(validation.settings.defaultMitigationAction).toBe("none");

      // Verify that the API no longer contains the old operations from the previous schema
      const cloudflareOperations = await getOperationsForZone(api, zone.id);

      // The operations should only contain the ones from our updated schema
      // (plus any other operations that might exist from other tests, but not the removed ones)
      const ourOperations = cloudflareOperations.filter(
        (op) =>
          op.endpoint.includes("/users") || op.endpoint.includes("/products"),
      );
      expect(ourOperations.length).toBe(4); // 2 users + 2 products operations
    } finally {
      await destroy(scope);
    }
  });
});

// Helper function for clean operation testing
function expectOperations(
  operations: any[],
  expected: Array<{ method: string; endpoint: string; action: string }>,
  type: "alchemy" | "cloudflare" = "alchemy",
) {
  // Sort operations for consistent comparison
  const sorted = operations.sort((a, b) => {
    const aKey =
      type === "alchemy"
        ? `${a.endpoint}-${a.method}`
        : `${a.endpoint}-${a.method}`;
    const bKey =
      type === "alchemy"
        ? `${b.endpoint}-${b.method}`
        : `${b.endpoint}-${b.method}`;
    return aKey.localeCompare(bKey);
  });

  // Sort expected operations the same way
  const sortedExpected = expected.sort((a, b) =>
    `${a.endpoint}-${a.method}`.localeCompare(`${b.endpoint}-${b.method}`),
  );

  // Check length
  expect(sorted.length).toBe(sortedExpected.length);

  // Check each operation
  for (let i = 0; i < sorted.length; i++) {
    const actual = sorted[i];
    const exp = sortedExpected[i];

    expect(actual.method.toLowerCase()).toBe(exp.method.toLowerCase());
    expect(actual.endpoint).toBe(exp.endpoint);

    if (type === "alchemy") {
      expect(actual.action).toBe(exp.action);
      expect(actual.operationId).toBeTruthy();
    } else {
      expect(actual.mitigation_action).toBe(exp.action);
      expect(actual.operation_id).toBeTruthy();
    }
  }
}
