import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { formatVpcService, type Attributes } from "./VpcService.ts";

export type VpcServiceLookupProps =
  | {
      /**
       * The Cloudflare-assigned ID for the VPC service.
       */
      serviceId: string;
    }
  | {
      /**
       * The display name of the VPC service.
       */
      name: string;
    };

/**
 * A reference to an existing VPC service — its {@link Attributes} plus a
 * `type: "vpc_service"` marker so it can be bound to a Worker's `env`.
 */
export type VpcServiceLookup = Attributes & { readonly type: "vpc_service" };

const toLookup = (attrs: Attributes): VpcServiceLookup => ({
  ...attrs,
  type: "vpc_service",
});

/**
 * Reference an existing Cloudflare VPC service (managed outside this stack)
 * without managing its lifecycle. Reads the service by `serviceId` or `name`
 * and returns its {@link Attributes}, which can be placed in a Worker's `env`
 * to attach a `vpc_service` binding.
 * @resource
 * @product Workers VPC
 * @category Network
 * @example Reference by ID
 * ```typescript
 * const service = yield* Cloudflare.Lookup.VpcService({
 *   serviceId: "123e4567-e89b-12d3-a456-426614174000",
 * });
 * ```
 *
 * @example Reference by name
 * ```typescript
 * const service = yield* Cloudflare.Lookup.VpcService({
 *   name: "my-vpc-service",
 * });
 * ```
 *
 * @example Bind to a Worker
 * ```typescript
 * const vpc = yield* Cloudflare.Lookup.VpcService({ name: "my-vpc-service" });
 *
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { VPC: vpc },
 * });
 * ```
 */
export const VpcServiceLookup = (props: VpcServiceLookupProps) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    if ("name" in props) {
      const match = yield* connectivity.listDirectoryServices
        .items({ accountId })
        .pipe(
          Stream.filter((s) => s.name === props.name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      if (!match) {
        return yield* Effect.die(`VPC service "${props.name}" not found`);
      }
      return toLookup(formatVpcService(match, accountId));
    }
    const result = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: props.serviceId,
    });
    return toLookup(formatVpcService(result, accountId));
  });

export const isVpcServiceLookup = (value: unknown): value is VpcServiceLookup =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "vpc_service";
