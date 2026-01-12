# NetworkAclAssociation

**Type:** `AWS.EC2.NetworkAclAssociation`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| networkAclId | `Input<NetworkAclId>` | Yes | - | The ID of the new network ACL to associate with the subnet. |
| subnetId | `Input<SubnetId>` | Yes | - | The ID of the subnet to associate with the network ACL. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| associationId | `NetworkAclAssociationId` | The ID of the association between the network ACL and subnet. |
| networkAclId | `Props["networkAclId"]` | The ID of the network ACL. |
| subnetId | `Props["subnetId"]` | The ID of the subnet. |
