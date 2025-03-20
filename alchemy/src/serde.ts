import { decryptWithKey, encryptWithKey } from "./encrypt";
import { Secret, getSecretPassphrase } from "./secret";

export async function serialize(value: any): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map(serialize));
  } else if (value instanceof Secret) {
    return {
      "@secret": await encryptWithKey(value.unencrypted, getSecretPassphrase()),
    };
  } else if (value && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, value]) => [
          key,
          await serialize(value),
        ]),
      ),
    );
  }
  return value;
}

export async function deserialize(value: any): Promise<any> {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map(async (item) => await deserialize(item)),
    );
  } else if (value && typeof value === "object") {
    if (typeof value["@secret"] === "string") {
      return new Secret(
        await decryptWithKey(value["@secret"], getSecretPassphrase()),
      );
    } else {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, value]) => [
            key,
            await deserialize(value),
          ]),
        ),
      );
    }
  }
  return value;
}
