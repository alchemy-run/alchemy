import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { ApiGatewayOperation } from "../../src/cloudflare/api-gateway-operation.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("ApiGatewayOperation", () => {
  test("create and delete API operation", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-api-op.com`;
    let zone: Zone;
    let operation: ApiGatewayOperation;

    try {
      // Create a test zone
      zone = await Zone(`${BRANCH_PREFIX}-api-op-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create an API operation
      operation = await ApiGatewayOperation(`${BRANCH_PREFIX}-get-users`, {
        zone,
        endpoint: "/users",
        host: "api.example.com",
        method: "GET",
      });

      expect(operation).toMatchObject({
        zoneId: zone.id,
        zoneName: zone.name,
        endpoint: "/users",
        host: "api.example.com",
        method: "GET",
      });
      expect(operation.operationId).toBeTruthy();
      expect(operation.lastUpdated).toBeTruthy();

      // Create another operation with path parameters
      const operationWithParams = await ApiGatewayOperation(
        `${BRANCH_PREFIX}-get-user-by-id`,
        {
          zone: zone.id, // Test using zone ID string
          endpoint: "/users/{id}",
          host: "api.example.com",
          method: "GET",
        },
      );

      expect(operationWithParams).toMatchObject({
        zoneId: zone.id,
        endpoint: "/users/{id}", // Now returns original endpoint from props
        host: "api.example.com",
        method: "GET",
      });
      expect(operationWithParams.operationId).toBeTruthy();

      // Verify operations are different
      expect(operationWithParams.operationId).not.toBe(operation.operationId);

      // Update the same operation (should update last_updated)
      const updatedOperation = await ApiGatewayOperation(
        `${BRANCH_PREFIX}-get-users`,
        {
          zone,
          endpoint: "/users",
          host: "api.example.com",
          method: "GET",
        },
      );

      expect(updatedOperation.operationId).toBe(operation.operationId);
      expect(updatedOperation.endpoint).toBe("/users");
      expect(updatedOperation.method).toBe("GET");
    } finally {
      await destroy(scope);
    }
  });

  test("create multiple operations for CRUD endpoints", async (scope) => {
    const zoneName = `${BRANCH_PREFIX}-crud-api.com`;
    let zone: Zone;

    try {
      zone = await Zone(`${BRANCH_PREFIX}-crud-zone`, {
        name: zoneName,
        type: "full",
        delete: true,
      });

      // Create CRUD operations
      const operations = await Promise.all([
        ApiGatewayOperation(`${BRANCH_PREFIX}-list-products`, {
          zone,
          endpoint: "/products",
          host: "api.example.com",
          method: "GET",
        }),
        ApiGatewayOperation(`${BRANCH_PREFIX}-create-product`, {
          zone,
          endpoint: "/products",
          host: "api.example.com",
          method: "POST",
        }),
        ApiGatewayOperation(`${BRANCH_PREFIX}-update-product`, {
          zone,
          endpoint: "/products/{id}",
          host: "api.example.com",
          method: "PUT",
        }),
        ApiGatewayOperation(`${BRANCH_PREFIX}-delete-product`, {
          zone,
          endpoint: "/products/{id}",
          host: "api.example.com",
          method: "DELETE",
        }),
      ]);

      // Verify all operations were created
      expect(operations).toHaveLength(4);

      // Verify each has a unique operation ID
      const operationIds = operations.map((op) => op.operationId);
      const uniqueIds = new Set(operationIds);
      expect(uniqueIds.size).toBe(4);

      // Verify methods are correct
      expect(operations[0].method).toBe("GET");
      expect(operations[1].method).toBe("POST");
      expect(operations[2].method).toBe("PUT");
      expect(operations[3].method).toBe("DELETE");
    } finally {
      await destroy(scope);
    }
  });
});
