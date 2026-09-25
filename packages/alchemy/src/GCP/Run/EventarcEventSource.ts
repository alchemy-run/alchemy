import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  EventarcEventSource as EventarcEventSourceTag,
  type CloudEvent,
  type EventarcEventSourceProps,
  type EventarcEventSourceService,
} from "../Eventarc/EventSource.ts";
import { Trigger, type EventFilter } from "../Eventarc/Trigger.ts";
import { Member } from "../IAM/Member.ts";
import {
  grantSelfInvoker,
  hostEndpoint,
  listenForDeliveries,
  pathSegment,
  pushHost,
} from "../PushDelivery.ts";

const lastSegment = (value: string) => value.split("/").pop() ?? value;

/** Default delivery path for an Eventarc subscription. */
export const eventarcPath = (id: string, props: EventarcEventSourceProps) =>
  props.path ?? `/__alchemy/eventarc/${pathSegment(id)}`;

const isStorageEvent = (props: EventarcEventSourceProps) =>
  props.eventFilters.some(
    (filter) =>
      typeof filter === "object" &&
      "attribute" in filter &&
      filter.attribute === "type" &&
      typeof filter.value === "string" &&
      filter.value.startsWith("google.cloud.storage."),
  );

/** Decode a binary-mode CloudEvent delivery. */
const toCloudEvent = (request: HttpServerRequest, body: string): CloudEvent => {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.startsWith("ce-") && typeof value === "string") {
      attributes[name.slice(3)] = value;
    }
  }
  const contentType = request.headers["content-type"] ?? "";
  let data: unknown = body;
  if (contentType.includes("json") && body.length > 0) {
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }
  }
  return {
    id: attributes.id ?? "",
    type: attributes.type ?? "",
    source: attributes.source ?? "",
    subject: attributes.subject,
    time: attributes.time,
    attributes,
    data,
  };
};

/**
 * HTTP implementation of `GCP.Eventarc.EventSource` for `GCP.Run.Service`
 * / `GCP.Function` and `GCP.CloudFunctions.Function`.
 *
 * Deploy-time: grants the host's runtime service account
 * `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on
 * the host (and, for Cloud Storage events, the Storage service agent
 * `roles/pubsub.publisher` on the project, which direct Storage events
 * require), then creates the trigger with that account as its identity.
 * Each grant and the trigger block until GCP reports them in place and
 * healthy. Runtime: claims deliveries on the path, verifies the OIDC
 * token, decodes the binary-mode CloudEvent, and runs the handler; a 2xx
 * acks, a failed handler answers 500 and Eventarc redelivers.
 *
 * @layer
 * @provides GCP.Eventarc.EventSource
 * @category Run
 */
export const EventarcEventSource = Layer.effect(
  EventarcEventSourceTag,
  Effect.gen(function* () {
    const trigger = yield* Trigger;
    const member = yield* Member;

    return Effect.fn(function* <Req = never>(
      id: string,
      props: EventarcEventSourceProps,
      process: (event: CloudEvent) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* pushHost("GCP.Eventarc.EventSource");
      const path = eventarcPath(id, props);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const endpoint = hostEndpoint(host);
        const attrs = host as unknown as Record<string, Output.Output<string>>;
        const env = yield* GcpEnvironment.current;
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* grantSelfInvoker(host);
            const receiver = yield* member(`${host.LogicalId}-EventReceiver`, {
              kind: "project",
              name: env.project,
              role: "roles/eventarc.eventReceiver",
              member: Output.interpolate`serviceAccount:${endpoint.serviceAccount}`,
            });
            const storageAgent = isStorageEvent(props)
              ? yield* member(`${id}-StorageAgentPublisher`, {
                  kind: "project",
                  name: env.project,
                  role: "roles/pubsub.publisher",
                  member: Output.fromEffect(
                    storage
                      .getProjectsServiceAccount({ projectId: env.project })
                      .pipe(
                        Effect.map(
                          (agent) => `serviceAccount:${agent.email_address}`,
                        ),
                        Effect.orDie,
                      ),
                  ),
                })
              : undefined;
            yield* trigger(`${id}-Trigger`, {
              location: props.location ?? attrs.location,
              eventFilters: props.eventFilters as EventFilter[],
              serviceAccount: Output.map(
                Output.all(
                  endpoint.serviceAccount,
                  receiver.member,
                  storageAgent?.member ?? receiver.member,
                ),
                ([email]) => email,
              ),
              destination: {
                cloudRun: {
                  service: Output.map(endpoint.invokerService, lastSegment),
                  region: attrs.location!,
                  path,
                },
              },
            });
          }),
        );
      }

      yield* listenForDeliveries(host, path, (request) =>
        Effect.gen(function* () {
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
          yield* process(toCloudEvent(request, body)).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }),
      );
    }) as EventarcEventSourceService;
  }),
);
