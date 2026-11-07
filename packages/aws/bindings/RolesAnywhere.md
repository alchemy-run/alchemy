<!-- Docs for the generated AWS.RolesAnywhere bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetSubject

Runtime binding for `rolesanywhere:GetSubject`.

Reads a *subject* — the audit record IAM Roles Anywhere keeps for each
certificate identity that has requested credentials, including the
certificates presented and the time of the last authentication attempt.
Account-level operation — subjects are chosen per request at runtime, so
the binding takes no resource argument. Provide the implementation with
`Effect.provide(AWS.RolesAnywhere.GetSubjectHttp)`.
### Auditing Certificate Identities
**Example:** Inspect a Subject's Credentials
```typescript
// init — account-level binding, no resource argument
const getSubject = yield* AWS.RolesAnywhere.GetSubject();

// runtime
const { subject } = yield* getSubject({ subjectId });
const lastSeen = subject?.lastSeenAt;
```

@binding

## ListSubjects

Runtime binding for `rolesanywhere:ListSubjects`.

Lists the *subjects* — the audit records IAM Roles Anywhere keeps for each
certificate identity that has requested credentials in the account and
Region. The backbone of workload-identity auditing: which certificates
authenticated, and when they were last seen.
Account-level operation — the binding takes no resource argument. Provide
the implementation with `Effect.provide(AWS.RolesAnywhere.ListSubjectsHttp)`.
### Auditing Certificate Identities
**Example:** List Authenticated Subjects
```typescript
// init — account-level binding, no resource argument
const listSubjects = yield* AWS.RolesAnywhere.ListSubjects();

// runtime
const { subjects } = yield* listSubjects();
```

@binding
