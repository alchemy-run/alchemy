import * as AWS from "@alchemy.run/aws";
import * as Domain from "@alchemy.run/domain";
import * as DomainAWS from "@alchemy.run/domain/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { runCases } from "../../../Domain/vault/cases.ts";

/** The table the Vault's keys are kept in, one item per subject. */
export const Keys = AWS.DynamoDB.Table("VaultKeys", {
  partitionKey: "subject",
  attributes: { subject: "S" },
});

/** The KMS key every subject's key is wrapped under. */
export const RootKey = AWS.KMS.Key("VaultRootKey", {
  description: "alchemy Domain Vault test root key",
  deletionWindow: "7 days",
});

export class DomainVaultFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "DomainVaultFunction",
) {}

/** `GET /cases/<pairing>` runs the Vault cases against that pairing and answers with what each found. */
export default DomainVaultFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    // A run of the cases is dozens of DynamoDB and KMS calls.
    timeout: Duration.seconds(60),
    memorySize: 1024,
  },
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const vaultOf = <R>(keys: Layer.Layer<Domain.KeyStore | Domain.KeyWrap, never, R>) =>
      Layer.buildWithScope(Domain.VaultLive.pipe(Layer.provide(keys)), scope).pipe(
        Effect.map((context) => Context.get(context, Domain.Vault)),
      );
    const vaults: Record<string, Domain.Vault["Service"]> = {
      "dynamo-kms": yield* vaultOf(
        Layer.merge(DomainAWS.DynamoKeyStore(Keys), DomainAWS.KmsKeyWrap(RootKey)),
      ),
      "dynamo-root": yield* vaultOf(
        Layer.merge(
          DomainAWS.DynamoKeyStore(Keys),
          Domain.RootKeyWrap(Redacted.make("5a".repeat(32))),
        ),
      ),
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, name] = new URL(request.originalUrl).pathname.split("/");
        if (route === "ready") return HttpServerResponse.text("ok");
        const vault = name === undefined ? undefined : vaults[name];
        if (route !== "cases" || vault === undefined) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const results = yield* runCases(`cases-${name}`).pipe(
          Effect.provideService(Domain.Vault, vault),
        );
        return yield* HttpServerResponse.json(results);
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.DynamoDB.GetItemHttp,
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.DeleteItemHttp,
        AWS.KMS.GenerateDataKeyHttp,
        AWS.KMS.DecryptHttp,
      ),
    ),
  ),
);
