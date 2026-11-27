import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { runCases } from "../../../Domain/vault/cases.ts";

/** The database the Vault's keys are kept in, apart from any model's storage. */
export const KeysDatabase = Cloudflare.D1.Database("VaultKeysDatabase");

/** The root key every subject's key is wrapped under, made on the first deploy. */
export const RootKey = Effect.gen(function* () {
  const store = yield* Cloudflare.SecretsStore.Store("VaultSecrets");
  const random = yield* Alchemy.Random("VaultRootKeyValue");
  return yield* Cloudflare.SecretsStore.Secret("VaultRootKey", { store, value: random.text });
});

/** Each pairing of where keys are kept and what wraps them, by the path that runs it. */
const pairings = {
  "host-secret": Layer.merge(Domain.HostKeyStore, DomainCloudflare.SecretKeyWrap(RootKey)),
  "d1-secret": Layer.merge(
    DomainCloudflare.D1KeyStore(KeysDatabase, { table: "wrapped_keys" }),
    DomainCloudflare.SecretKeyWrap(RootKey),
  ),
  "d1-none": Layer.merge(DomainCloudflare.D1KeyStore(KeysDatabase), Domain.NoKeyWrap),
} as const;

const isPairing = (name: string): name is keyof typeof pairings => name in pairings;

/** `GET /cases/<pairing>` runs the Vault cases against that pairing and answers with what each found. */
export default class DomainVaultWorker extends Cloudflare.Worker<DomainVaultWorker>()(
  "DomainVaultWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const vaultOf = <R>(keys: Layer.Layer<Domain.KeyStore | Domain.KeyWrap, never, R>) =>
      Layer.buildWithScope(Domain.VaultLive.pipe(Layer.provide(keys)), scope).pipe(
        Effect.map((context) => Context.get(context, Domain.Vault)),
      );
    const vaults = {
      "host-secret": yield* vaultOf(pairings["host-secret"]),
      "d1-secret": yield* vaultOf(pairings["d1-secret"]),
      "d1-none": yield* vaultOf(pairings["d1-none"]),
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, name] = new URL(request.url, "http://localhost").pathname.split("/");
        if (route !== "cases" || name === undefined || !isPairing(name)) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const results = yield* runCases(`cases-${name}`).pipe(
          Effect.provideService(Domain.Vault, vaults[name]),
        );
        return yield* HttpServerResponse.json(results);
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DomainCloudflare.layerDurableObjects(),
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.SecretsStore.ReadSecretBinding,
      ),
    ),
  ),
) {}
