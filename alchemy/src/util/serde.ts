import { Scope } from "../scope";
import { Secret } from "../secret";
import { decryptWithKey, encryptWithKey } from "./encrypt";

export async function serialize(scope: Scope, value: any): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((value) => serialize(scope, value)));
  } else if (value instanceof Secret) {
    if (!scope.password) {
      throw new Error("Cannot serialize secret without password");
    }
    return {
      "@secret": await encryptWithKey(value.unencrypted, scope.password),
    };
  } else if (value instanceof Scope) {
    return undefined;
  } else if (value && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, value]) => [
          key,
          await serialize(scope, value),
        ]),
      ),
    );
  }
  return value;
}

export async function deserialize(scope: Scope, value: any): Promise<any> {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map(async (item) => await deserialize(scope, item)),
    );
  } else if (value && typeof value === "object") {
    if (typeof value["@secret"] === "string") {
      if (!scope.password) {
        throw new Error("Cannot deserialize secret without password");
      }
      return new Secret(await decryptWithKey(value["@secret"], scope.password));
    } else {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, value]) => [
            key,
            await deserialize(scope, value),
          ]),
        ),
      );
    }
  }
  return value;
}
