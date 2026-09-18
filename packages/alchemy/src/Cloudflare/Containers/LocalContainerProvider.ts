import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import type { ResourceBinding } from "../../Resource.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { generateLocalId, LOCAL_PROVIDERS_URL } from "../LocalRuntime.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
} from "./ContainerApplication.ts";
import {
  createContainerApplicationName,
  makeContainerEnv,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";
import { resolveContainerImage } from "./ContainerImage.ts";

/** Local application metadata; Docker image resources prepare the runtime image. */
export const LocalContainerProvider = () =>
  RpcProvider.effect(
    ContainerPlatform,
    LOCAL_PROVIDERS_URL,
    Effect.gen(function* () {
      const placeholderConfiguration = (
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
      ) =>
        normalizeNulls({
          image: "local",
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          memoryMib: props.memoryMib,
          disk: props.disk,
          environmentVariables: Object.entries(env).map(([name, value]) => ({
            name,
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          })),
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      const makeAttributes = Effect.fn(function* ({
        id,
        news,
        bindings,
        output,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        output: ContainerApplication["Attributes"] | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const env = makeContainerEnv(news, accountId, bindings);
        const { dev, imageHash } = yield* resolveContainerImage(
          news,
          env,
          true,
        );
        return {
          applicationId: output?.applicationId ?? generateLocalId(),
          applicationName: yield* createContainerApplicationName(id, news.name),
          accountId: output?.accountId ?? accountId,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          constraints: news.constraints,
          affinities: news.affinities,
          configuration: placeholderConfiguration(news, env),
          durableObjects: undefined,
          createdAt: new Date().toISOString(),
          version: 1,
          dev: { ...dev, env },
          hash: { image: imageHash },
        } satisfies ContainerApplication["Attributes"];
      });

      return {
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!output) return { action: "update" };
          if (!isResolved(news)) return undefined;
          if (news.imageArtifact?.hash !== output.hash?.image || !output.dev)
            return { action: "update" };
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings, output }) {
          return yield* makeAttributes({ id, news, bindings, output });
        }),
        delete: Effect.fn(function* () {
          // The image resource and Worker runtime own local cleanup.
        }),
      };
    }),
  );
