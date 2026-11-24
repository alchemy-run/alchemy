import { DeleteItem } from "@alchemy.run/aws/DynamoDB/DeleteItem";
import { GetItem } from "@alchemy.run/aws/DynamoDB/GetItem";
import { PutItem } from "@alchemy.run/aws/DynamoDB/PutItem";
import type { Table } from "@alchemy.run/aws/DynamoDB/Table";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeyStore, VaultError } from "../Vault.ts";

/**
 * A Vault's keys in a DynamoDB table, one item per subject. The table's
 * partition key is `subject`, a string. Leave point-in-time recovery and
 * backups off for it: a restored table brings shredded keys back.
 *
 * ### Keeping keys in DynamoDB
 * **Example:** A table for the Vault's keys, wrapped under a KMS key
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainAWS from "@alchemy.run/domain/AWS";
 * import * as Layer from "effect/Layer";
 *
 * export const Keys = AWS.DynamoDB.Table("VaultKeys", {
 *   partitionKey: "subject",
 *   attributes: { subject: "S" },
 * });
 * export const RootKey = AWS.KMS.Key("VaultRootKey");
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(DomainAWS.DynamoKeyStore(Keys)),
 *   Layer.provide(DomainAWS.KmsKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       AWS.DynamoDB.GetItemHttp,
 *       AWS.DynamoDB.PutItemHttp,
 *       AWS.DynamoDB.DeleteItemHttp,
 *       AWS.KMS.GenerateDataKeyHttp,
 *       AWS.KMS.DecryptHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const DynamoKeyStore = <E = never, R = never>(
  table: Table | Effect.Effect<Table, E, R>,
): Layer.Layer<KeyStore, E, R | GetItem | PutItem | DeleteItem> =>
  Layer.effect(
    KeyStore,
    Effect.gen(function* () {
      const keys = Effect.isEffect(table) ? yield* table : table;
      const getItem = yield* GetItem(keys);
      const putItem = yield* PutItem(keys);
      const deleteItem = yield* DeleteItem(keys);
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      const get = (subject: string) =>
        getItem({ Key: { subject: { S: subject } }, ConsistentRead: true }).pipe(
          Effect.map((found) => Option.fromNullishOr(found.Item?.key?.S)),
          Effect.mapError(failed(subject)),
        );
      return {
        get,
        create: (subject, key) =>
          putItem({
            Item: { subject: { S: subject }, key: { S: key } },
            ConditionExpression: "attribute_not_exists(subject)",
          }).pipe(
            Effect.as(key),
            // Another caller stored a key first: the subject has that one.
            Effect.catchTag("ConditionalCheckFailedException", () =>
              Effect.map(
                get(subject),
                Option.getOrElse(() => key),
              ),
            ),
            Effect.mapError(failed(subject)),
          ),
        delete: (subject) =>
          deleteItem({ Key: { subject: { S: subject } } }).pipe(
            Effect.asVoid,
            Effect.mapError(failed(subject)),
          ),
      };
    }),
  );
