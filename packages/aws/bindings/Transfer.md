<!-- Docs for the generated AWS.Transfer bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteSshPublicKey

Runtime binding for `transfer:DeleteSshPublicKey`.

Removes an SSH public key from the bound {@link User} by
`SshPublicKeyId` (returned by {@link ImportSshPublicKey} or listed via
{@link DescribeUser}) — the revocation half of key rotation. The
`ServerId` and `UserName` are injected from the binding. Deleting a key
that no longer exists fails with the typed `ResourceNotFoundException`.
Provide the implementation with
`Effect.provide(AWS.Transfer.DeleteSshPublicKeyHttp)`.
### Managing SSH Keys at Runtime
**Example:** Revoke a User's Key
```typescript
// init — bind the operation to the user
const deleteSshPublicKey = yield* AWS.Transfer.DeleteSshPublicKey(user);

// runtime
yield* deleteSshPublicKey({ SshPublicKeyId: keyId }).pipe(
  Effect.catchTag("ResourceNotFoundException", () => Effect.void),
);
```

@binding

## DescribeServer

Runtime binding for `transfer:DescribeServer`.

Reads the bound {@link Server}'s live configuration and state — the
`ServerId` is injected from the binding. Useful for checking whether the
server is `ONLINE`/`OFFLINE` before a {@link StartServer}/{@link StopServer}
call or surfacing endpoint details to an admin portal. Provide the
implementation with `Effect.provide(AWS.Transfer.DescribeServerHttp)`.
### Observing the Server
**Example:** Read the Server State
```typescript
// init — bind the operation to the server
const describeServer = yield* AWS.Transfer.DescribeServer(server);

// runtime
const { Server } = yield* describeServer();
yield* Effect.log(`server is ${Server.State}`);
```

@binding

## DescribeUser

Runtime binding for `transfer:DescribeUser`.

Reads the bound {@link User}'s live configuration — home directory, role,
POSIX profile, and the SSH public keys currently registered (including
their `SshPublicKeyId`s, which {@link DeleteSshPublicKey} needs). The
`ServerId` and `UserName` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Transfer.DescribeUserHttp)`.
### Managing Users at Runtime
**Example:** Read the User's SSH Keys
```typescript
// init — bind the operation to the user
const describeUser = yield* AWS.Transfer.DescribeUser(user);

// runtime
const { User } = yield* describeUser();
const keyIds = (User.SshPublicKeys ?? []).map((k) => k.SshPublicKeyId);
```

@binding

## ImportSshPublicKey

Runtime binding for `transfer:ImportSshPublicKey`.

Registers an additional SSH public key on the bound {@link User} — the
key-rotation half of a self-service credential portal. The `ServerId` and
`UserName` are injected from the binding; only the public key body is
passed at runtime. Returns the new `SshPublicKeyId` for later
{@link DeleteSshPublicKey}. Importing a key that is already registered
fails with the typed `ResourceExistsException`. Provide the
implementation with `Effect.provide(AWS.Transfer.ImportSshPublicKeyHttp)`.
### Managing SSH Keys at Runtime
**Example:** Rotate a User's Key
```typescript
// init — bind the operation to the user
const importSshPublicKey = yield* AWS.Transfer.ImportSshPublicKey(user);

// runtime
const { SshPublicKeyId } = yield* importSshPublicKey({
  SshPublicKeyBody: "ssh-ed25519 AAAA…",
});
```

@binding

## ListUsers

Runtime binding for `transfer:ListUsers`.

Lists the users attached to the bound {@link Server} — the `ServerId` is
injected from the binding. Pass `MaxResults`/`NextToken` to page through
large user sets. The building block for self-service user portals over a
service-managed server. Provide the implementation with
`Effect.provide(AWS.Transfer.ListUsersHttp)`.
### Managing Users at Runtime
**Example:** List the Server's Users
```typescript
// init — bind the operation to the server
const listUsers = yield* AWS.Transfer.ListUsers(server);

// runtime
const { Users } = yield* listUsers();
yield* Effect.log(`users: ${Users.map((u) => u.UserName).join(", ")}`);
```

@binding

## SendWorkflowStepState

Runtime binding for `transfer:SendWorkflowStepState`.

Reports a custom workflow step's outcome back to Transfer Family. A
managed workflow's custom step invokes a Lambda with the workflow id,
execution id, and a callback token; the Lambda MUST call this operation
with `SUCCESS` or `FAILURE` or the step hangs until its timeout. The
action authorizes on the workflow's own ARN, which arrives at runtime
inside the step event, so the grant is on `*`. Provide the
implementation with
`Effect.provide(AWS.Transfer.SendWorkflowStepStateHttp)`.
### Custom Workflow Steps
**Example:** Complete a Custom Step
```typescript
// init — account-level binding, no resource argument
const sendWorkflowStepState = yield* AWS.Transfer.SendWorkflowStepState();

// runtime — inside the Lambda invoked by the workflow's custom step
yield* sendWorkflowStepState({
  WorkflowId: event.serviceMetadata.executionDetails.workflowId,
  ExecutionId: event.serviceMetadata.executionDetails.executionId,
  Token: event.token,
  Status: "SUCCESS",
});
```

@binding

## StartServer

Runtime binding for `transfer:StartServer`.

Brings a stopped {@link Server} from `OFFLINE` back to `ONLINE` so it can
accept file transfers again — the `ServerId` is injected from the binding.
Paired with {@link StopServer} this enables runtime schedules that park
the endpoint outside business hours. The call is asynchronous: the server
passes through `STARTING`; observe progress with {@link DescribeServer}.
Starting a server that is not `OFFLINE` fails with the typed
`InvalidRequestException`. Provide the implementation with
`Effect.provide(AWS.Transfer.StartServerHttp)`.
### Controlling Server Availability
**Example:** Bring the Server Online
```typescript
// init — bind the operation to the server
const startServer = yield* AWS.Transfer.StartServer(server);

// runtime
yield* startServer();
```

@binding

## StopServer

Runtime binding for `transfer:StopServer`.

Takes the bound {@link Server} from `ONLINE` to `OFFLINE` so it stops
accepting file transfers — the `ServerId` is injected from the binding.
Server and user configuration are unaffected. Note stopping does NOT
pause billing; only deleting the server does. The call is asynchronous:
the server passes through `STOPPING`; observe progress with
{@link DescribeServer}. Stopping a server that is not `ONLINE` fails with
the typed `InvalidRequestException`. Provide the implementation with
`Effect.provide(AWS.Transfer.StopServerHttp)`.
### Controlling Server Availability
**Example:** Take the Server Offline
```typescript
// init — bind the operation to the server
const stopServer = yield* AWS.Transfer.StopServer(server);

// runtime
yield* stopServer();
```

@binding

## TestIdentityProvider

Runtime binding for `transfer:TestIdentityProvider`.

Exercises the bound {@link Server}'s custom identity provider
(`API_GATEWAY`, `AWS_LAMBDA`, or `AWS_DIRECTORY_SERVICE`) with a user
name and optional password, returning the provider's raw response and
status code — the `ServerId` is injected from the binding. The password
is `Redacted` end-to-end (distilled marks `UserPassword` sensitive).
Calling it on a `SERVICE_MANAGED` server fails with the typed
`InvalidRequestException`. Provide the implementation with
`Effect.provide(AWS.Transfer.TestIdentityProviderHttp)`.
### Diagnosing Authentication
**Example:** Test a User's Credentials
```typescript
import * as Redacted from "effect/Redacted";

// init — bind the operation to the server
const testIdentityProvider = yield* AWS.Transfer.TestIdentityProvider(server);

// runtime
const result = yield* testIdentityProvider({
  UserName: "alice",
  UserPassword: Redacted.make("secret"),
  ServerProtocol: "SFTP",
});
yield* Effect.log(`identity provider replied ${result.StatusCode}`);
```

@binding
