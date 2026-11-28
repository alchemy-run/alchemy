import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import { Signer, unsignedCredentials, type SignRequest } from "@distilled.cloud/aws/Signer";
import * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Gateway from "alchemy/Gateway";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The gateway's signer, as the sandbox calls it. */
const SIGNER = "AWS.SandboxSigner";

/** Sign `request` as the gateway's own identity. */
const signAsHost = (request: SignRequest) =>
  Effect.gen(function* () {
    const credentials = yield* yield* Credentials;
    const { regionSet, region, signQuery, ...rest } = request;
    const key = {
      accessKeyId: Redacted.value(credentials.accessKeyId),
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    };
    return yield* regionSet === undefined
      ? SigV4.sign({ ...rest, ...key, region, signQuery })
      : SigV4.signV4a({ ...rest, ...key, regionSet: [...regionSet] });
  });

/**
 * Lets a sandbox send its AWS requests itself. With only a gateway, an AWS
 * binding's whole call runs in the gateway, and every byte passes through
 * it. With this Layer too, the binding runs in the sandbox: it asks the
 * gateway for a signature, which is made with the gateway's role, and sends
 * the request straight to AWS. The sandbox never holds a key, and a large
 * upload or download never touches the gateway.
 *
 * The gateway signs any request its role is allowed to make, so what the
 * sandbox can do is what the sandbox's AWS bindings were granted.
 *
 * ### Provide the layer
 * **Example:** Between the bindings and the gateway
 * ```typescript
 * Effect.provide(
 *   Layer.mergeAll(AWS.S3.GetObjectHttp, AWS.S3.PutObjectHttp).pipe(
 *     Layer.provide(AWS.SandboxSigner),
 *     Layer.provide(AWS.Lambda.SandboxGateway),
 *   ),
 * )
 * ```
 *
 * @layer
 * @product Sandbox Signer
 */
export const SandboxSigner: Layer.Layer<never, never, Gateway.Gateway> = Layer.effectDiscard(
  Effect.gen(function* () {
    // The gateway is installed on the sandbox before this Layer is built.
    yield* Gateway.Gateway;
    if (!globalThis.__ALCHEMY_RUNTIME__) return;
    if (globalThis.__ALCHEMY_GATEWAY__) {
      // Kept beside the bindings' clients, for the sandbox to call.
      Gateway.clients.set(SIGNER, {
        sign: signAsHost,
        region: Effect.flatMap(Region, (region) => region),
      });
      return;
    }
    const gateway = (yield* CurrentRuntimeContext)?.gateway;
    if (gateway?.phase !== "sandbox") return;
    const call = gateway.call;
    const region = yield* Effect.cached(
      call(SIGNER, ["region"], undefined).pipe(
        Effect.orDie,
        Effect.map((name) => name as RegionName),
      ),
    );
    const signed: Layer.Layer<any> = Layer.mergeAll(
      Layer.succeed(Signer, {
        sign: (request: SignRequest) =>
          call(SIGNER, ["sign"], [request]) as Effect.Effect<SigV4.SignedRequest, unknown>,
      }),
      unsignedCredentials(region),
      Layer.succeed(Region, region),
      FetchHttpClient.layer,
    );
    // Every AWS binding is built in the sandbox, with its requests signed
    // by the gateway.
    gateway.direct = (id) => (id.startsWith("AWS.") ? signed : undefined);
  }),
);
