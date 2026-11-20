<!-- Docs for the generated AWS.MWAA bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateCliToken

Runtime binding for `airflow:CreateCliToken`.

Bind an {@link Environment} inside a function runtime to mint short-lived
(60-second) Apache Airflow CLI tokens — exchange the token against
`https://{WebServerHostname}/aws_mwaa/cli` to run Airflow CLI commands.
The `CliToken` is `Redacted` — unwrap it with `Redacted.value` when
building the request. Provide the implementation with
`Effect.provide(AWS.MWAA.CreateCliTokenHttp)`.
### Creating CLI Tokens
**Example:** Mint a CLI Token and Run an Airflow Command
```typescript
// init — bind the operation to the environment
const createCliToken = yield* AWS.MWAA.CreateCliToken(environment);

// runtime — mint a token and POST a CLI command to the webserver
const token = yield* createCliToken();
const response = yield* HttpClient.execute(
  HttpClientRequest.post(
    `https://${token.WebServerHostname}/aws_mwaa/cli`,
  ).pipe(
    HttpClientRequest.setHeader(
      "Authorization",
      `Bearer ${Redacted.value(token.CliToken!)}`,
    ),
    HttpClientRequest.bodyText("dags list -o json"),
  ),
);
```

@binding

## GetEnvironment

Runtime binding for `airflow:GetEnvironment`.

Bind an {@link Environment} inside a function runtime to observe the
environment's live status, webserver URL, and last-update details — useful
for health checks and for gating REST API calls on `Status === "AVAILABLE"`.
Provide the implementation with
`Effect.provide(AWS.MWAA.GetEnvironmentHttp)`.
### Describing the Environment
**Example:** Check Environment Health
```typescript
// init — bind the operation to the environment
const getEnvironment = yield* AWS.MWAA.GetEnvironment(environment);

// runtime — observe live status
const result = yield* getEnvironment();
const healthy = result.Environment?.Status === "AVAILABLE";
```

@binding
