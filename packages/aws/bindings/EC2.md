<!-- Docs for the generated AWS.EC2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AuthorizeSecurityGroupIngress

Runtime binding for the `AuthorizeSecurityGroupIngress` operation scoped to
the bound {@link SecurityGroup} (IAM action
`ec2:AuthorizeSecurityGroupIngress` on the security group ARN).

Adds an inbound rule to the group at runtime — the classic dynamic
IP-allowlisting Lambda that opens a port for an operator's current address.
Pair with {@link RevokeSecurityGroupIngress} to remove the rule afterwards.
Provide the implementation with
`Effect.provide(AWS.EC2.AuthorizeSecurityGroupIngressHttp)`.
### Dynamic Security Group Rules
**Example:** Allowlist an address for SSH
```typescript
// init — bind the operation to the security group
const authorizeIngress = yield* AWS.EC2.AuthorizeSecurityGroupIngress(group);

// runtime — open port 22 for the caller's address
yield* authorizeIngress({
  IpProtocol: "tcp",
  FromPort: 22,
  ToPort: 22,
  CidrIp: "203.0.113.7/32",
});
```

@binding

## AuthorizeSecurityGroupIngress.Request

`AuthorizeSecurityGroupIngress` request with `GroupId` injected from the
bound {@link SecurityGroup}.

## CreateSnapshot

Runtime binding for the `CreateSnapshot` operation scoped to the bound
{@link Volume} (IAM actions `ec2:CreateSnapshot` + `ec2:CreateTags` on the
volume ARN and the region-wide snapshot wildcard — snapshot creation
authorizes against both the source volume and the new snapshot).

Creates a point-in-time EBS snapshot of the volume — e.g. a Lambda that
takes an application-consistent backup before a risky migration. The
snapshot is created `pending` and completes asynchronously. Provide the
implementation with `Effect.provide(AWS.EC2.CreateSnapshotHttp)`.
### Volume Backups
**Example:** Snapshot the bound volume
```typescript
// init — bind the operation to the volume
const createSnapshot = yield* AWS.EC2.CreateSnapshot(volume);

// runtime — take a point-in-time backup
const snapshot = yield* createSnapshot({
  Description: "pre-migration backup",
});
console.log(snapshot.SnapshotId, snapshot.State);
```

@binding

## CreateSnapshot.Request

`CreateSnapshot` request with `VolumeId` injected from the bound
{@link Volume}.

## DescribeInstanceStatus

Runtime binding for the `DescribeInstanceStatus` operation scoped to the
bound {@link Instance} (IAM action `ec2:DescribeInstanceStatus`;
`Describe*` actions do not support resource-level permissions, so the grant
is on `*`).

Reads the instance's system/instance status checks and scheduled events —
e.g. a Lambda that alerts on failed reachability checks. Pass
`IncludeAllInstances: true` to also see the status while the instance is
stopped. Provide the implementation with
`Effect.provide(AWS.EC2.DescribeInstanceStatusHttp)`.
### Observing Instances
**Example:** Check the instance's status checks
```typescript
// init — bind the operation to the instance
const describeStatus = yield* AWS.EC2.DescribeInstanceStatus(instance);

// runtime — read status checks (even while stopped)
const result = yield* describeStatus({ IncludeAllInstances: true });
console.log(result.InstanceStatuses?.[0]?.InstanceStatus?.Status);
```

@binding

## DescribeInstanceStatus.Request

`DescribeInstanceStatus` request with `InstanceIds` injected from the bound
{@link Instance}.

## GetConsoleOutput

Runtime binding for the `GetConsoleOutput` operation scoped to the bound
{@link Instance} (IAM action `ec2:GetConsoleOutput` on the instance ARN).

Fetches the instance's serial console output (base64-encoded) — e.g. a
diagnostics Lambda that captures boot logs when a host fails its health
checks. Pass `Latest: true` for the most recent output on supported
instance types. Provide the implementation with
`Effect.provide(AWS.EC2.GetConsoleOutputHttp)`.
### Diagnostics
**Example:** Capture the instance's console output
```typescript
// init — bind the operation to the instance
const getConsoleOutput = yield* AWS.EC2.GetConsoleOutput(instance);

// runtime — fetch the (base64-encoded) boot log
const result = yield* getConsoleOutput({ Latest: true });
const log = Buffer.from(result.Output ?? "", "base64").toString("utf8");
```

@binding

## GetConsoleOutput.Request

`GetConsoleOutput` request with `InstanceId` injected from the bound
{@link Instance}.

## GetPasswordData

Runtime binding for the `GetPasswordData` operation scoped to the bound
{@link Instance} (IAM action `ec2:GetPasswordData` on the instance ARN).

Retrieves the encrypted Windows administrator password for the instance.
The `PasswordData` field is sensitive and surfaces as
`Redacted.Redacted<string>` — decrypt it with the launch key pair's private
key. Linux instances return an empty value. Provide the implementation with
`Effect.provide(AWS.EC2.GetPasswordDataHttp)`.
### Diagnostics
**Example:** Fetch the encrypted Windows administrator password
```typescript
// init — bind the operation to the instance
const getPasswordData = yield* AWS.EC2.GetPasswordData(instance);

// runtime — the ciphertext is Redacted; unwrap explicitly to decrypt
const result = yield* getPasswordData();
const ciphertext = result.PasswordData; // Redacted<string>
```

@binding

## GetPasswordData.Request

`GetPasswordData` request with `InstanceId` injected from the bound
{@link Instance}.

## RebootInstance

Runtime binding for the `RebootInstances` operation scoped to the bound
{@link Instance} (IAM action `ec2:RebootInstances` on the instance ARN).

Requests an asynchronous reboot of the instance — e.g. a remediation Lambda
that bounces a wedged host after a failed health check. Provide the
implementation with `Effect.provide(AWS.EC2.RebootInstanceHttp)`.
### Instance Lifecycle Control
**Example:** Reboot the bound instance
```typescript
// init — bind the operation to the instance
const rebootInstance = yield* AWS.EC2.RebootInstance(instance);

// runtime — request the reboot (asynchronous)
yield* rebootInstance();
```

@binding

## RebootInstance.Request

`RebootInstances` request with `InstanceIds` injected from the bound
{@link Instance}.

## RevokeSecurityGroupIngress

Runtime binding for the `RevokeSecurityGroupIngress` operation scoped to
the bound {@link SecurityGroup} (IAM action
`ec2:RevokeSecurityGroupIngress` on the security group ARN).

Removes an inbound rule from the group at runtime — the cleanup half of the
dynamic IP-allowlisting pattern (see
{@link AuthorizeSecurityGroupIngress}). Provide the implementation with
`Effect.provide(AWS.EC2.RevokeSecurityGroupIngressHttp)`.
### Dynamic Security Group Rules
**Example:** Remove a previously allowlisted address
```typescript
// init — bind the operation to the security group
const revokeIngress = yield* AWS.EC2.RevokeSecurityGroupIngress(group);

// runtime — close port 22 for the address again
yield* revokeIngress({
  IpProtocol: "tcp",
  FromPort: 22,
  ToPort: 22,
  CidrIp: "203.0.113.7/32",
});
```

@binding

## RevokeSecurityGroupIngress.Request

`RevokeSecurityGroupIngress` request with `GroupId` injected from the bound
{@link SecurityGroup}.

## StartInstance

Runtime binding for the `StartInstances` operation scoped to the bound
{@link Instance} (IAM action `ec2:StartInstances` on the instance ARN).

Starts the stopped instance — the classic scheduled Lambda that powers dev
boxes on in the morning. Starting an already-running instance succeeds
without effect. Provide the implementation with
`Effect.provide(AWS.EC2.StartInstanceHttp)`.
### Instance Lifecycle Control
**Example:** Start the bound instance
```typescript
// init — bind the operation to the instance
const startInstance = yield* AWS.EC2.StartInstance(instance);

// runtime — power the instance on
const result = yield* startInstance();
console.log(result.StartingInstances?.[0]?.CurrentState?.Name);
```

@binding

## StartInstance.Request

`StartInstances` request with `InstanceIds` injected from the bound
{@link Instance}.

## StopInstance

Runtime binding for the `StopInstances` operation scoped to the bound
{@link Instance} (IAM action `ec2:StopInstances` on the instance ARN).

Stops the running instance — the other half of the scheduled
start/stop-Lambda pattern that powers dev fleets off overnight. Pass
`Hibernate: true` for hibernation-enabled instances. Provide the
implementation with `Effect.provide(AWS.EC2.StopInstanceHttp)`.
### Instance Lifecycle Control
**Example:** Stop the bound instance
```typescript
// init — bind the operation to the instance
const stopInstance = yield* AWS.EC2.StopInstance(instance);

// runtime — power the instance off
const result = yield* stopInstance();
console.log(result.StoppingInstances?.[0]?.CurrentState?.Name);
```

@binding

## StopInstance.Request

`StopInstances` request with `InstanceIds` injected from the bound
{@link Instance}.
