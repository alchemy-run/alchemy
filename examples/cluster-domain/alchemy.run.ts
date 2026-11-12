import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import AwsBankApi from "@cluster-bank/server/AWS/BankApi";
import CloudflareBankApi from "@cluster-bank/server/Cloudflare/BankApi";
import DockerBankApi from "@cluster-bank/server/Docker/BankApi";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Where the bank runs: `docker` (the default) for your local Docker swarm,
 * `aws` for RDS, ECS Fargate and Lambda, `cloudflare` for Durable Objects.
 * Set it with `BANK_TARGET=aws` or `BANK_TARGET=cloudflare`.
 */
export const Target = Config.Literals(["docker", "aws", "cloudflare"], "BANK_TARGET").pipe(
  Config.withDefault("docker" as const),
);

/** The bank on Effect Cluster, on the target `BANK_TARGET` names. */
export default Alchemy.Stack(
  "ClusterBank",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      Cloudflare.providers(),
      Docker.providers(),
      Cluster.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const target = yield* Target;
    if (target === "aws") {
      const api = yield* AwsBankApi;
      return { url: api.functionUrl };
    }
    if (target === "cloudflare") {
      const api = yield* CloudflareBankApi;
      return { url: api.url };
    }
    const api = yield* DockerBankApi;
    // The port Swarm actually published, as it reports it.
    const url = api.ports.pipe(
      Output.map((ports) => `http://localhost:${ports[0]?.external ?? "unpublished"}`),
    );
    return { url, service: api.name };
  }),
);
