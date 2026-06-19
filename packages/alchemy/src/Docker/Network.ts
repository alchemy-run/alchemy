import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createNetwork,
  inspectNetworkInfo,
  removeNetwork,
  type NetworkInfo,
} from "./DockerApi.ts";

export interface NetworkProps {
  /**
   * Docker network name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Network driver. @default "bridge" */
  driver?: "bridge" | "host" | "none" | "overlay" | "macvlan" | (string & {});
  /** Enable IPv6 on the network. @default false */
  enableIPv6?: boolean;
  /** Network labels. */
  labels?: Record<string, string>;
}

export interface Network extends Resource<
  "Docker.Network",
  NetworkProps,
  {
    /** Docker network ID. */
    id: string;
    /** Docker network name. */
    name: string;
    /** Network driver. */
    driver: string;
    /** Whether IPv6 is enabled. */
    enableIPv6: boolean;
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
  }
> {}

/**
 * A Docker network managed through the active Docker context.
 *
 * Existing same-name networks are treated as foreign unless the engine is
 * explicitly allowed to adopt them with `--adopt` or `adopt(true)`.
 *
 * @resource
 *
 * @section Creating Networks
 * @example Basic bridge network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "app-network",
 * });
 * ```
 *
 * @section Adoption
 * @example Adopt a pre-existing network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "shared-app-network",
 * }).pipe(adopt(true));
 * ```
 */
export const Network = Resource<Network>("Docker.Network");

const networkName = (id: string, props: NetworkProps, instanceId: string) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      });

export const toNetworkAttributes = (
  info: NetworkInfo,
): Network["Attributes"] => ({
  id: info.Id,
  name: info.Name,
  driver: info.Driver,
  enableIPv6: info.EnableIPv6,
  labels: info.Labels ?? {},
  createdAt: Date.parse(info.Created) || Date.now(),
});

export const NetworkProvider = () =>
  Provider.succeed(Network, {
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
      const name = yield* networkName(id, olds ?? {}, instanceId);
      const info = yield* inspectNetworkInfo(name);
      if (!info) return undefined;
      const attrs = toNetworkAttributes(info);
      return output ? attrs : Unowned(attrs);
    }),
    diff: Effect.fnUntraced(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      const oldComparable = {
        name: olds?.name,
        driver: olds?.driver ?? "bridge",
        enableIPv6: olds?.enableIPv6 ?? false,
        labels: olds?.labels ?? {},
      };
      const newComparable = {
        name: news?.name,
        driver: news?.driver ?? "bridge",
        enableIPv6: news?.enableIPv6 ?? false,
        labels: news?.labels ?? {},
      };
      if (!deepEqual(oldComparable, newComparable)) {
        return { action: "replace" as const, deleteFirst: true };
      }
    }),
    reconcile: Effect.fnUntraced(function* ({
      id,
      instanceId,
      news,
      output,
      session,
    }) {
      const name =
        output?.name ?? (yield* networkName(id, news ?? {}, instanceId));
      const existing = yield* inspectNetworkInfo(name);
      if (existing) {
        return toNetworkAttributes(existing);
      }
      yield* session.note(`Creating Docker network: ${name}`);
      const createdId = yield* createNetwork({
        name,
        driver: news?.driver ?? "bridge",
        enableIPv6: news?.enableIPv6,
        labels: news?.labels,
      }).pipe(
        Effect.catchIf(
          (error) =>
            error.message.includes(`network with name ${name} already exists`),
          () => Effect.succeed(undefined),
        ),
      );
      const info = yield* inspectNetworkInfo(createdId ?? name);
      if (!info) {
        return yield* Effect.die(
          `Docker network could not be inspected: ${name}`,
        );
      }
      return toNetworkAttributes(info);
    }),
    delete: Effect.fnUntraced(function* ({ output, session }) {
      yield* session.note(`Removing Docker network: ${output.name}`);
      yield* removeNetwork(output.id);
    }),
  });
