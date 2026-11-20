<!-- Docs for the generated AWS.NotificationsContacts bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ActivateEmailContact

Runtime binding for `notifications-contacts:ActivateEmailContact`.

Activate the bound email contact with the activation code the address
owner received (see {@link SendActivationCode}) — e.g. from a
confirmation form in your app. Provide the implementation with
`Effect.provide(AWS.NotificationsContacts.ActivateEmailContactHttp)`.
### Activating a Contact
**Example:** Activate with a User-Supplied Code
```typescript
// init — bind the operation to the contact
const activate = yield* AWS.NotificationsContacts.ActivateEmailContact(contact);

// runtime — the user pasted the code from the activation email
yield* activate({ code: Redacted.make(userSuppliedCode) });
```

@binding

## ActivateEmailContact.Request

Request for {@link ActivateEmailContact} — the bound contact's ARN is
injected automatically. The activation `code` is the one AWS emailed to
the contact's address (a one-time token — pass it as
`Redacted.make(code)` to keep it out of logs).

## GetEmailContact

Runtime binding for `notifications-contacts:GetEmailContact`.

Read the bound email contact — most usefully its activation `status`,
which flips from `inactive` to `active` once the address owner confirms
the activation email. Provide the implementation with
`Effect.provide(AWS.NotificationsContacts.GetEmailContactHttp)`.
### Checking Activation Status
**Example:** Read the Contact's Status
```typescript
// init — bind the operation to the contact
const getContact = yield* AWS.NotificationsContacts.GetEmailContact(contact);

// runtime
const result = yield* getContact();
const isActive = result.emailContact.status === "active";
```

@binding

## SendActivationCode

Runtime binding for `notifications-contacts:SendActivationCode`.

Send (or re-send) the activation email to the bound contact's address.
The email contains the activation code the address owner uses to confirm
the contact (directly via the emailed link, or through your app via
{@link ActivateEmailContact}). Provide the implementation with
`Effect.provide(AWS.NotificationsContacts.SendActivationCodeHttp)`.
### Activating a Contact
**Example:** Re-send the Activation Email
```typescript
// init — bind the operation to the contact
const sendActivationCode =
  yield* AWS.NotificationsContacts.SendActivationCode(contact);

// runtime — e.g. behind a "resend confirmation email" button
yield* sendActivationCode();
```

@binding
