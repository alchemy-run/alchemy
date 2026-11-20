import * as AWS from "@alchemy.run/aws";
import * as GCP from "@alchemy.run/gcp";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * End-to-end fixture for `Kubernetes.Deployment` on EKS: an Effect HTTP
 * server deployed as a Kubernetes Deployment + LoadBalancer Service.
 *
 * - The target cluster is deployed by the test's phase-1 program and referenced
 *   here via `AWS.EKS.Cluster.ref("EksHostCluster")` (props are an Effect).
 *   Refs resolve from stack state, giving the Deployment the cluster's
 *   `connection` — the reconciler applies the Deployment/Service via
 *   server-side apply against it through the `aws-eks` cluster adapter.
 * - The DynamoDB `Table` is yielded inline (a plain Resource, safe to nest) and
 *   bound via `PutItem`. The binding lands `dynamodb:PutItem` IAM on the
 *   generated pod-identity role and injects the table name into the pod. At
 *   runtime the pod resolves credentials through the EKS Pod Identity
 *   container-credentials chain (`Credentials.fromChain()` in the bootstrap).
 * - `/put?id=x` writes an item so the test can prove the binding worked by
 *   reading it back out-of-band; `/health` gates readiness.
 * - The GCP topic is bound via `Publish`. The pod runs as its Pod Identity
 *   role, so it reaches Pub/Sub through workload identity federation with
 *   no service account key; `/publish` sends a message and `/gcp-identity`
 *   reports what the pod holds.
 */

/** Topic the pod publishes to through federation. */
export const EksHostEvents = GCP.PubSub.Topic("EksHostEvents", {});

/** Body of the message `/publish` sends. */
export const EKS_GCP_MESSAGE = "hello from eks";
export default class EksHostApi extends Kubernetes.Deployment<EksHostApi>()(
  "EksHostApi",
  Effect.gen(function* () {
    const cluster = yield* AWS.EKS.Cluster.ref("EksHostCluster");
    return {
      main: import.meta.url,
      cluster,
      port: 3000,
      serviceType: "LoadBalancer" as const,
    };
  }),
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("EksHostTable", {
      partitionKey: "pk",
      attributes: { pk: "S" },
    });
    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const TableName = yield* table.tableName;
    const publish = yield* GCP.PubSub.Publish(yield* EksHostEvents);
    const readEnv = (name: string) =>
      Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://eks-host");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/put") {
          const id = url.searchParams.get("id") ?? "default";
          yield* putItem({ Item: { pk: { S: id } } });
          return yield* HttpServerResponse.json({
            written: id,
            table: yield* TableName,
          });
        }
        if (url.pathname === "/gcp-identity") {
          return yield* HttpServerResponse.json({
            audience: yield* readEnv("ALCHEMY_GCP_WORKLOAD_IDENTITY_AUDIENCE"),
            hasKey: (yield* readEnv("ALCHEMY_GCP_SERVICE_ACCOUNT_KEY")) !== undefined,
          });
        }
        if (url.pathname === "/publish") {
          return yield* publish({
            body: { messages: [{ data: btoa(EKS_GCP_MESSAGE) }] },
          }).pipe(
            Effect.flatMap((response) => HttpServerResponse.json(response)),
            Effect.catchCause((cause) =>
              HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
            ),
          );
        }
        return HttpServerResponse.text("kubernetes deployment");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AWS.DynamoDB.PutItemHttp, GCP.PubSub.PublishHttp))),
) {}
