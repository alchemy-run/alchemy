import { decryptWithKey, encrypt } from "./encrypt.js";
import { Scope } from "./scope.js";
import { Secret } from "./secret.js";

import type { Type } from "arktype";

// zero-dependency type guard for ArkType
function isType(value: any): value is Type<any, any> {
  return (
    value &&
    typeof value === "object" &&
    typeof value.toJsonSchema === "function"
  );
}

export async function serialize(
  scope: Scope,
  value: any,
  options?: {
    encrypt?: boolean;
  },
): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((value) => serialize(scope, value, options)));
  }
  if (value instanceof Secret) {
    if (!scope.password) {
      throw new Error("Cannot serialize secret without password");
    }
    return {
      "@secret":
        options?.encrypt !== false
          ? await encrypt(value.unencrypted, scope.password)
          : value.unencrypted,
    };
  }
  if (isType(value)) {
    return {
      "@schema": value.toJSON(),
    };
  }
  if (value instanceof Date) {
    return {
      "@date": value.toISOString(),
    };
  }
  if (value instanceof Scope) {
    return undefined;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, value]) => [
          key,
          await serialize(scope, value, options),
        ]),
      ),
    );
  }
  if (typeof value === "function") {
    // can't serialize functions
    return undefined;
  }
  return value;
}

export async function deserialize(scope: Scope, value: any): Promise<any> {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map(async (item) => await deserialize(scope, item)),
    );
  }
  if (value && typeof value === "object") {
    if (typeof value["@secret"] === "string") {
      if (!scope.password) {
        throw new Error("Cannot deserialize secret without password");
      }
      return new Secret(await decryptWithKey(value["@secret"], scope.password));
    }
    if ("@schema" in value) {
      return value["@schema"];
    }
    if ("@date" in value) {
      return new Date(value["@date"]);
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, value]) => [
          key,
          await deserialize(scope, value),
        ]),
      ),
    );
  }
  return value;
}
