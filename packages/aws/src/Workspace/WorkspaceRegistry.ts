import { WorkspaceError } from "@alchemy.run/sandbox/Workspace";
/**
 * Which host has which session, for an `AWS.Workspace` with more than one
 * host: a DynamoDB table of hosts (each with its address and when it last
 * said it was alive) and sessions (each with the host that has it and how
 * long its claim lasts). Any host takes any request; a request for a session
 * another live host has is forwarded there, inside the VPC. A session no
 * live host has is claimed by the host that got the request.
 *
 * The table only routes. What protects a session's disk is the head's lease
 * in the store: a host that claims a session whose last host is gone
 * supersedes that host's lease when it mounts the head.
 *
 * NOT exported from `index.ts`.
 */
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/** A host's claim on a session lasts this long unless renewed. */
export const CLAIM = Duration.toMillis(Duration.minutes(1));
/** Hosts say they're alive this often. */
export const HEARTBEAT = Duration.seconds(10);

const fail = (message: string, cause?: unknown) => new WorkspaceError({ message, cause });

export interface Me {
  /** The instance's id. */
  readonly id: string;
  /** Where other hosts reach this one: `<private ip>:<port>`. */
  readonly address: string;
}

/** This instance's id and private address, from its metadata service (IMDSv2). */
export const whoAmI = (port: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const token = yield* client
      .execute(
        HttpClientRequest.put("http://169.254.169.254/latest/api/token").pipe(
          HttpClientRequest.setHeader("x-aws-ec2-metadata-token-ttl-seconds", "21600"),
        ),
      )
      .pipe(Effect.flatMap((response) => response.text));
    const read = (path: string) =>
      client
        .execute(
          HttpClientRequest.get(`http://169.254.169.254/latest/meta-data/${path}`).pipe(
            HttpClientRequest.setHeader("x-aws-ec2-metadata-token", token),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.text
              : Effect.succeed(undefined as string | undefined),
          ),
        );
    const id = yield* read("instance-id");
    const ip = yield* read("local-ipv4");
    return { id: id ?? "local", address: `${ip ?? "127.0.0.1"}:${port}`, read } as const;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) => fail("reading this instance's metadata", cause)),
  );

/** A session's owner, as the table says. */
export interface Owner {
  readonly host: string;
  readonly address: string;
  readonly until: number;
}

export const makeRegistry = (table: string, me: Me) => {
  const sessionKey = (session: string) => ({ S: `session#${session}` });
  const toError = (what: string) => (cause: unknown) => fail(`the registry: ${what}`, cause);

  /** Who has `session`, if anyone does and their claim hasn't lapsed. */
  const owner = Effect.fn(function* (session: string) {
    const { Item } = yield* dynamodb
      .getItem({ TableName: table, Key: { pk: sessionKey(session) }, ConsistentRead: true })
      .pipe(Effect.mapError(toError(`reading ${session}`)));
    if (!Item) return undefined;
    const found: Owner = {
      host: Item.host?.S ?? "",
      address: Item.address?.S ?? "",
      until: Number(Item.until?.N ?? 0),
    };
    return found.until > Date.now() ? found : undefined;
  });

  /** One attempt to claim `session`: false if another live host has it. */
  const tryClaim = (session: string) => {
    const now = Date.now();
    return dynamodb
      .putItem({
        TableName: table,
        Item: {
          pk: sessionKey(session),
          host: { S: me.id },
          address: { S: me.address },
          until: { N: String(now + CLAIM) },
          expires: { N: String(Math.ceil((now + 24 * 3600_000) / 1000)) },
        },
        ConditionExpression: "attribute_not_exists(pk) OR #until < :now OR #host = :me",
        ExpressionAttributeNames: { "#until": "until", "#host": "host" },
        ExpressionAttributeValues: { ":now": { N: String(now) }, ":me": { S: me.id } },
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("ConditionalCheckFailedException", () => Effect.succeed(false)),
        Effect.mapError(toError(`claiming ${session}`)),
      );
  };

  /**
   * Claims `session` for this host, unless another live host has it.
   * Returns who has it now: this host, or the other one.
   */
  const claim = Effect.fn(function* (session: string) {
    // A claim that lapsed between the two reads is tried again.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (yield* tryClaim(session)) {
        return { host: me.id, address: me.address, until: Date.now() + CLAIM } satisfies Owner;
      }
      const other = yield* owner(session);
      if (other) return other;
    }
    return yield* fail(`the registry: ${session} is changing hands too fast to claim`);
  });

  /** Extends this host's claim on `session`; false if another host has it now. */
  const renew = (session: string) =>
    dynamodb
      .updateItem({
        TableName: table,
        Key: { pk: sessionKey(session) },
        UpdateExpression: "SET #until = :until",
        ConditionExpression: "#host = :me",
        ExpressionAttributeNames: { "#until": "until", "#host": "host" },
        ExpressionAttributeValues: {
          ":until": { N: String(Date.now() + CLAIM) },
          ":me": { S: me.id },
        },
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("ConditionalCheckFailedException", () => Effect.succeed(false)),
        Effect.mapError(toError(`renewing ${session}`)),
      );

  /** Gives `session` up (its head is snapshotted and unmounted). */
  const release = (session: string) =>
    dynamodb
      .deleteItem({
        TableName: table,
        Key: { pk: sessionKey(session) },
        ConditionExpression: "#host = :me",
        ExpressionAttributeNames: { "#host": "host" },
        ExpressionAttributeValues: { ":me": { S: me.id } },
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTag("ConditionalCheckFailedException", () => Effect.void),
        Effect.mapError(toError(`releasing ${session}`)),
      );

  /** This host is alive: its address, and how many sessions it has. */
  const heartbeat = (sessions: number, draining: boolean) =>
    dynamodb
      .putItem({
        TableName: table,
        Item: {
          pk: { S: `host#${me.id}` },
          address: { S: me.address },
          at: { N: String(Date.now()) },
          sessions: { N: String(sessions) },
          draining: { BOOL: draining },
          expires: { N: String(Math.ceil(Date.now() / 1000) + 300) },
        },
      })
      .pipe(Effect.asVoid, Effect.mapError(toError("the heartbeat")));

  return { me, owner, claim, renew, release, heartbeat };
};

export type Registry = ReturnType<typeof makeRegistry>;

/**
 * Sends `request` (its method, path, headers and body) to the host at
 * `address`, and answers what it answers. A forwarded request is marked, so
 * it's never forwarded again.
 */
export const forward = (
  address: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<{ readonly status: number; readonly body: string }, WorkspaceError> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(request.url, "http://host");
    const response = yield* client.execute(
      request.pipe(
        HttpClientRequest.setUrl(`http://${address}${url.pathname}${url.search}`),
        HttpClientRequest.setHeader(FORWARDED, "1"),
      ),
    );
    return { status: response.status, body: yield* response.text };
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) => fail(`forwarding to ${address}`, cause)),
  );

export const FORWARDED = "x-alchemy-workspace-forwarded";
