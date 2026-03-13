# AWS Organizations Landing Zone

This example shows the opinionated `TenantRoot(...)` helper built on top of
Alchemy's canonical `AWS.Organizations.*` and `AWS.IdentityCenter.*` resources.

## RootRoot Model

`RootRoot` is an Alchemy control-plane concept, not a native AWS resource.

- Native AWS supports one real Organization per management account.
- Each tenant Organization has its own `Root -> OUs -> Accounts` hierarchy.
- If a tenant needs its own IAM Identity Center organization instance, that
  tenant must live in its own management account.
- A future `RootRoot` control plane coordinates many `TenantRoot(...)`
  deployments across many management accounts; it does not create nested AWS
  Organizations.

## Before Deploying

Set a globally unique email domain suffix for the example accounts:

```bash
TENANT_EMAIL_DOMAIN=customer-a.example.com
```

The example assumes IAM Identity Center is already enabled in the target
management account and therefore uses `identityCenter.mode = "existing"`.
