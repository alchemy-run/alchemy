# RouteTableAssociation

**Type:** `AWS.EC2.RouteTableAssociation`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| routeTableId | `Input<RouteTableId>` | Yes | - | The ID of the route table. Required. |
| subnetId | `Input<SubnetId>` | No | - | The ID of the subnet to associate with the route table. Either subnetId or gatewayId is required, but not both. |
| gatewayId | `Input<string>` | No | - | The ID of the gateway (internet gateway or virtual private gateway) to associate with the route table. Either subnetId or gatewayId is required, but not both. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| associationId | `RouteTableAssociationId` | The ID of the association. |
| routeTableId | `Props["routeTableId"]` | The ID of the route table. |
| subnetId | `Props["subnetId"]` | The ID of the subnet (if the association is with a subnet). |
| gatewayId | `Props["gatewayId"]` | The ID of the gateway (if the association is with a gateway). |
| associationState | `{     state: EC2.RouteTableAssociationStateCode;     statusMessage?: string;   }` | The state of the association. |
