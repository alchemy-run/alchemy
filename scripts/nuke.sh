bun alchemy unsafe nuke ./stacks/nuke.ts  \
  --exclude 'Cloudflare.Zone*' \
  --exclude 'Cloudflare.Account*' \
  --exclude 'Cloudflare.Dns*' \
  --exclude 'Cloudflare.ApiToken.*' \
  --exclude 'Cloudflare.Secret*' \
  --exclude 'Cloudflare.Organization.*' \
  --exclude 'AWS.IAM.User' \
  --exclude 'AWS.IAM.SAMLProvider' \
  --exclude 'AWS.IAM.OpenIDConnectProvider' \
  --exclude 'AWS.IAM.AccountAlias' \
  --exclude 'AWS.IAM.AccountPasswordPolicy' \
  --exclude 'AWS.IAM.LoginProfile' \
  --exclude 'AWS.IdentityCenter*' \
  --exclude 'AWS.Organizations.*'  \
  --profile testing  \
  --concurrency 32 \
  --filter 'resource.Type === "Cloudflare.Worker" && resource.workerName?.startsWith("alchemy-state") || resource.workerName === "Api"' \
  --filter 'resource.Type === "AWS.IAM.Role" && (["alchemy-github-actions", "distilled-github-oidc-role"].includes(resource.roleName) || resource.roleName?.startsWith("AWSReservedSSO"))' \
  "$@"