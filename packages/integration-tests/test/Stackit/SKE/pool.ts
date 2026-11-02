/**
 * The cheapest 2-vCPU machine on a non-metro zone. One node: SKE needs no more.
 * Its own module because fixtures import it, and they end up in a host's bundle.
 */
export const smallPool = {
  name: "workers",
  machineType: "c1.2",
  availabilityZones: ["eu01-1"],
  minimum: 1,
  maximum: 1,
  volumeSize: 20,
};
