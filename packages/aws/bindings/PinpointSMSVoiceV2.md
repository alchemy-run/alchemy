<!-- Docs for the generated AWS.PinpointSMSVoiceV2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CarrierLookup

Runtime binding for `sms-voice:CarrierLookup`.

Looks up carrier metadata for a destination phone number — its E.164
normalization, country, carrier name, and number type (`MOBILE`,
`LANDLINE`, `VOIP`, …). Use it to validate destinations before
sending. Account-level: lookups act on raw phone numbers, so the
deploy-time grant is `sms-voice:CarrierLookup` on `*`. Each lookup
incurs a small per-request fee. Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.CarrierLookupHttp)`.
### Validating Destinations
**Example:** Check a Number Before Sending
```typescript
// init — bind the account-level operation
const carrierLookup = yield* AWS.PinpointSMSVoiceV2.CarrierLookup();

// runtime
const info = yield* carrierLookup({ PhoneNumber: "+12065550100" });
const isMobile = info.PhoneNumberType === "MOBILE";
```

@binding

## DeleteKeyword

Runtime binding for `sms-voice:DeleteKeyword`.

Deletes a keyword from the bound origination phone number. Keywords
`HELP` and `STOP` cannot be deleted (they are carrier-mandated). The
deploy-time half grants `sms-voice:DeleteKeyword` on the number.
Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.DeleteKeywordHttp)`.
### Managing Keywords
**Example:** Remove a Keyword
```typescript
// init
const deleteKeyword = yield* AWS.PinpointSMSVoiceV2.DeleteKeyword(number);

// runtime
yield* deleteKeyword({ Keyword: "INFO" });
```

@binding

## DeleteKeyword.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller supplies the keyword to remove.

## DeleteOptedOutNumber

Runtime binding for `sms-voice:DeleteOptedOutNumber`.

Removes a destination phone number from the bound opt-out list, opting
the end user back in to receiving messages. Numbers that opted
themselves out by replying with a keyword can only be removed once
every 30 days. The deploy-time half grants
`sms-voice:DeleteOptedOutNumber` on the list. Provide the
implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.DeleteOptedOutNumberHttp)`.
### Managing Opt-Outs
**Example:** Opt a Number Back In
```typescript
// init
const deleteOptedOut =
  yield* AWS.PinpointSMSVoiceV2.DeleteOptedOutNumber(optOuts);

// runtime
yield* deleteOptedOut({ OptedOutNumber: "+12065550100" });
```

@binding

## DeleteOptedOutNumber.Request

The `OptOutListName` is injected by the binding from the bound opt-out
list; the caller supplies the destination number to opt back in.

## DescribeKeywords

Runtime binding for `sms-voice:DescribeKeywords`.

Lists the keywords configured on the bound origination phone number
(one page per call — pass `NextToken` from the previous response to
continue). The deploy-time half grants `sms-voice:DescribeKeywords` on
the number. Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.DescribeKeywordsHttp)`.
### Managing Keywords
**Example:** List the Number's Keywords
```typescript
// init
const describeKeywords =
  yield* AWS.PinpointSMSVoiceV2.DescribeKeywords(number);

// runtime
const { Keywords } = yield* describeKeywords({});
const info = (Keywords ?? []).find((k) => k.Keyword === "INFO");
```

@binding

## DescribeKeywords.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller may filter by keyword or page with `NextToken`.

## DescribeOptedOutNumbers

Runtime binding for `sms-voice:DescribeOptedOutNumbers`.

Lists the opted-out destination numbers in the bound opt-out list (one
page per call — pass `NextToken` from the previous response to
continue). Use it to check whether a number opted out before sending.
The deploy-time half grants `sms-voice:DescribeOptedOutNumbers` on the
list. Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbersHttp)`.
### Managing Opt-Outs
**Example:** Check a Number Before Sending
```typescript
// init
const describeOptedOut =
  yield* AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbers(optOuts);

// runtime
const { OptedOutNumbers } = yield* describeOptedOut({
  OptedOutNumbers: ["+12065550100"],
});
const optedOut = (OptedOutNumbers ?? []).length > 0;
```

@binding

## DescribeOptedOutNumbers.Request

The `OptOutListName` is injected by the binding from the bound opt-out
list; the caller may filter by number or page with `NextToken`.

## PutKeyword

Runtime binding for `sms-voice:PutKeyword`.

Creates or updates a keyword on the bound origination phone number —
when an end user texts the keyword to the number, End User Messaging
SMS automatically replies with `KeywordMessage` (or opts them out /
back in when `KeywordAction` is set). The deploy-time half grants
`sms-voice:PutKeyword` on the number. Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.PutKeywordHttp)`.
### Managing Keywords
**Example:** Register an Auto-Reply Keyword
```typescript
// init
const putKeyword = yield* AWS.PinpointSMSVoiceV2.PutKeyword(number);

// runtime
yield* putKeyword({
  Keyword: "INFO",
  KeywordMessage: "Visit https://example.com for details.",
});
```

@binding

## PutKeyword.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller supplies the keyword and its response message.

## PutMessageFeedback

Runtime binding for `sms-voice:PutMessageFeedback`.

Marks a sent message's feedback record as `RECEIVED` or `FAILED`. When
a message is sent with `MessageFeedbackEnabled: true`, End User
Messaging SMS waits for this signal — set `RECEIVED` when your
application observes the user acting on the message (e.g. entering the
one-time passcode); records not updated within an hour are marked
`FAILED`. Account-level: feedback acts on message IDs, so the
deploy-time grant is `sms-voice:PutMessageFeedback` on `*`. Provide
the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.PutMessageFeedbackHttp)`.
### Message Feedback
**Example:** Confirm an OTP Was Used
```typescript
// init — bind the account-level operation
const putFeedback = yield* AWS.PinpointSMSVoiceV2.PutMessageFeedback();

// runtime — after the user enters the code sent in `MessageId`
yield* putFeedback({
  MessageId: messageId,
  MessageFeedbackStatus: "RECEIVED",
});
```

@binding

## PutOptedOutNumber

Runtime binding for `sms-voice:PutOptedOutNumber`.

Adds a destination phone number to the bound opt-out list — further
messages to it through numbers using this list are suppressed. Use it
to honor opt-out requests arriving through channels other than the
carrier keywords (support tickets, web forms). The deploy-time half
grants `sms-voice:PutOptedOutNumber` on the list. Provide the
implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.PutOptedOutNumberHttp)`.
### Managing Opt-Outs
**Example:** Opt a Number Out from a Lambda
```typescript
// init
const optOuts = yield* AWS.PinpointSMSVoiceV2.OptOutList("OptOuts");
const putOptedOut = yield* AWS.PinpointSMSVoiceV2.PutOptedOutNumber(optOuts);

// runtime
yield* putOptedOut({ OptedOutNumber: "+12065550100" });
```

@binding

## PutOptedOutNumber.Request

The `OptOutListName` is injected by the binding from the bound opt-out
list; the caller supplies the destination number to opt out.

## SendMediaMessage

Runtime binding for `sms-voice:SendMediaMessage`.

Sends a multimedia message (MMS) from the bound origination phone
number. `MediaUrls` reference S3 objects (`s3://bucket/key`) holding the
attachments. The deploy-time half grants `sms-voice:SendMediaMessage` on
the number and the runtime half injects its ARN as the request's
`OriginationIdentity`. The bound number must carry the `MMS` capability.
Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.SendMediaMessageHttp)`.
### Sending Media Messages
**Example:** Send an MMS with an S3 Attachment
```typescript
// init
const sendMedia = yield* AWS.PinpointSMSVoiceV2.SendMediaMessage(number);

// runtime
const { MessageId } = yield* sendMedia({
  DestinationPhoneNumber: "+12065550100",
  MessageBody: "Here is your receipt",
  MediaUrls: ["s3://my-bucket/receipts/1234.png"],
});
```

@binding

## SendMediaMessage.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller supplies the destination, body, and media URLs.

## SendTextMessage

Runtime binding for `sms-voice:SendTextMessage`.

Sends an SMS message from the bound origination phone number to one
recipient — the effectful call made from a deployed Lambda or Task. The
deploy-time half grants `sms-voice:SendTextMessage` on the number and
the runtime half injects its ARN as the request's `OriginationIdentity`.
Provide the implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.SendTextMessageHttp)`.
### Sending Text Messages
**Example:** Send an SMS from a Lambda
```typescript
// init — lease a number and bind the send operation
const number = yield* AWS.PinpointSMSVoiceV2.PhoneNumber("Sender", {
  isoCountryCode: "US",
  messageType: "TRANSACTIONAL",
  numberCapabilities: ["SMS"],
  numberType: "TOLL_FREE",
});
const sendText = yield* AWS.PinpointSMSVoiceV2.SendTextMessage(number);

// runtime
const { MessageId } = yield* sendText({
  DestinationPhoneNumber: "+12065550100",
  MessageBody: "Your code is 123456",
  MessageType: "TRANSACTIONAL",
});
```

@binding

## SendTextMessage.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller supplies the destination and message body.

## SendVoiceMessage

Runtime binding for `sms-voice:SendVoiceMessage`.

Sends a voice message from the bound origination phone number — Amazon
Polly converts the text (or SSML) `MessageBody` into speech. The
deploy-time half grants `sms-voice:SendVoiceMessage` on the number and
the runtime half injects its ARN as the request's `OriginationIdentity`.
The bound number must carry the `VOICE` capability. Provide the
implementation with
`Effect.provide(AWS.PinpointSMSVoiceV2.SendVoiceMessageHttp)`.
### Sending Voice Messages
**Example:** Call a Recipient with a Spoken Message
```typescript
// init
const sendVoice = yield* AWS.PinpointSMSVoiceV2.SendVoiceMessage(number);

// runtime
const { MessageId } = yield* sendVoice({
  DestinationPhoneNumber: "+12065550100",
  MessageBody: "Your appointment is confirmed for tomorrow at nine A M.",
  MessageBodyTextType: "TEXT",
  VoiceId: "JOANNA",
});
```

@binding

## SendVoiceMessage.Request

The `OriginationIdentity` is injected by the binding from the bound
phone number; the caller supplies the destination and message body.
