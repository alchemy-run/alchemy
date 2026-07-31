# AWS Lambda

This example deploys a Lambda Function URL backed by DynamoDB and SNS.

## Local development through Live Lambda

Set the AWS profile and region you want to use, then start the stack in dev
mode:

```sh
AWS_PROFILE=your-profile AWS_REGION=us-west-2 bun run dev
```

Alchemy provisions a separate dev Lambda in your AWS account. Its real
Function URL, IAM role, bindings, and AWS event integrations remain active,
while invocations are forwarded through AppSync Events to the handler running
on your machine. Edit `src/JobFunction.ts`; the next invocation uses the
rebuilt local bundle without redeploying the Lambda.

The dev Lambda has its own `alchemy-dev-*` physical name, so switching between
`alchemy dev` and `alchemy deploy` cannot overwrite the deployed function.

Run `bun run destroy` when you are finished. The account-and-region-wide
AppSync Events API named `alchemy` is shared bootstrap infrastructure and is
intentionally retained for later dev sessions.
