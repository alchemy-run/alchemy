import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { Credentials } from "./Credentials.ts";

/**
 * Direct HTTP client wrappers for the Vultr v2 API.
 *
 * Vultr returns a flat REST surface. Most endpoints wrap their payload
 * in an envelope keyed by the resource (e.g. `{ instance: ... }`), which
 * we unwrap at the call site for ergonomics.
 */

export class VultrApiError extends Data.TaggedError("VultrApiError")<{
  status: number;
  method: string;
  url: string;
  message: string;
  body?: unknown;
}> {}

export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
  instanceId: string;
}> {}

export type InstanceStatus = "pending" | "active" | "suspended" | "resizing";
export type PowerStatus = "running" | "stopped" | "starting";
export type ServerStatus = "none" | "locked" | "installingbooting" | "ok";

export interface VultrInstanceInfo {
  id: string;
  os: string;
  ram: number;
  disk: number;
  main_ip: string;
  vcpu_count: number;
  region: string;
  plan: string;
  date_created: string;
  status: InstanceStatus;
  allowed_bandwidth: number;
  netmask_v4: string;
  gateway_v4: string;
  power_status: PowerStatus;
  server_status: ServerStatus;
  v6_network: string;
  v6_main_ip: string;
  v6_network_size: number;
  label: string;
  internal_ip: string;
  kvm: string;
  hostname: string;
  tag?: string;
  tags: string[];
  os_id: number;
  app_id: number;
  image_id: string;
  firewall_group_id: string;
  features: string[];
  user_scheme: string;
  pending_charges: number;
  default_password?: string;
  backups?: "enabled" | "disabled";
}

export interface CreateInstanceInput {
  region: string;
  plan: string;
  os_id?: number;
  iso_id?: string;
  snapshot_id?: string;
  app_id?: number;
  image_id?: string;
  label?: string;
  hostname?: string;
  sshkey_id?: string[];
  tags?: string[];
  user_data?: string;
  backups?: "enabled" | "disabled";
  enable_ipv6?: boolean;
  ddos_protection?: boolean;
  firewall_group_id?: string;
  enable_vpc?: boolean;
  attach_vpc?: string[];
  reserved_ipv4?: string;
  script_id?: string;
}

export interface UpdateInstanceInput {
  label?: string;
  plan?: string;
  tags?: string[];
  user_data?: string;
  backups?: "enabled" | "disabled";
  ddos_protection?: boolean;
  enable_ipv6?: boolean;
  firewall_group_id?: string;
}

export interface InstanceListItem {
  id: string;
  label: string;
  tags: string[];
}

const request = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Effect.Effect<A, VultrApiError, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const creds = yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&")
      : "";
    const url = `${creds.apiBaseUrl}${path}${qs}`;

    let req = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(creds.apiKey)}`,
      ),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    if (body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
        Effect.mapError(
          (e) =>
            new VultrApiError({
              status: 0,
              method,
              url,
              message: `Failed to serialize body: ${String(e)}`,
            }),
        ),
      );
    }
    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (e) =>
          new VultrApiError({
            status: 0,
            method,
            url,
            message: `Network error: ${String(e)}`,
          }),
      ),
    );
    if (response.status === 204) {
      return undefined as A;
    }
    const text = yield* response.text.pipe(
      Effect.mapError(
        (e) =>
          new VultrApiError({
            status: response.status,
            method,
            url,
            message: `Failed to read response body: ${String(e)}`,
          }),
      ),
    );
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (response.status >= 400) {
      const errorMessage =
        (typeof parsed === "object" &&
          parsed != null &&
          (parsed as { error?: string }).error) ||
        `HTTP ${response.status}`;
      return yield* new VultrApiError({
        status: response.status,
        method,
        url,
        message: errorMessage,
        body: parsed,
      });
    }
    return parsed as A;
  });

export const createInstance = (input: CreateInstanceInput) =>
  request<{ instance: VultrInstanceInfo }>("POST", "/instances", input);

export const getInstance = (
  instanceId: string,
): Effect.Effect<
  { instance: VultrInstanceInfo },
  VultrApiError | InstanceNotFound,
  Credentials | HttpClient.HttpClient
> =>
  Effect.catchTag(
    request<{ instance: VultrInstanceInfo }>("GET", `/instances/${instanceId}`),
    "VultrApiError",
    (
      e,
    ): Effect.Effect<
      { instance: VultrInstanceInfo },
      VultrApiError | InstanceNotFound
    > =>
      e.status === 404
        ? Effect.fail(new InstanceNotFound({ instanceId }))
        : Effect.fail(e),
  );

export const updateInstance = (
  instanceId: string,
  input: UpdateInstanceInput,
) =>
  request<{ instance: VultrInstanceInfo }>(
    "PATCH",
    `/instances/${instanceId}`,
    input,
  );

export const deleteInstance = (instanceId: string) =>
  request<void>("DELETE", `/instances/${instanceId}`).pipe(
    Effect.catchTag("VultrApiError", (e) =>
      e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
    ),
  );

export const listInstances = (query?: {
  label?: string;
  tag?: string;
  region?: string;
  per_page?: number;
}) =>
  request<{
    instances: VultrInstanceInfo[];
    meta: { total: number; links: { next: string; prev: string } };
  }>("GET", "/instances", undefined, query);

export const startInstance = (instanceId: string) =>
  request<void>("POST", `/instances/${instanceId}/start`);

export const haltInstance = (instanceId: string) =>
  request<void>("POST", `/instances/${instanceId}/halt`);

export const rebootInstance = (instanceId: string) =>
  request<void>("POST", `/instances/${instanceId}/reboot`);

/**
 * Poll `getInstance` until `status === "active"` (or the instance moves
 * to a terminal failure state). Times out after ~10 minutes; Vultr
 * shared-CPU instances usually transition within 60–90s.
 */
export const waitForActive = (instanceId: string) =>
  getInstance(instanceId).pipe(
    Effect.flatMap(({ instance }) =>
      instance.status === "active"
        ? Effect.succeed(instance)
        : Effect.fail(
            new VultrApiError({
              status: 0,
              method: "GET",
              url: `/instances/${instanceId}`,
              message: `instance not yet active (status=${instance.status})`,
            }),
          ),
    ),
    Effect.retry({
      while: (e: unknown) =>
        (e as { _tag?: string })._tag === "VultrApiError" ||
        (e as { _tag?: string })._tag === "InstanceNotFound",
      schedule: Schedule.both(
        Schedule.exponential(Duration.seconds(2), 1.5),
        Schedule.recurs(80),
      ),
    }),
  );
