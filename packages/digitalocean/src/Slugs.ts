/**
 * Datacenter region slug. The literals are the regions DigitalOcean listed
 * in October 2026 and give editor completion; any other string is accepted
 * so new regions work without an Alchemy release.
 */
export type RegionSlug =
  | "ams3"
  | "atl1"
  | "blr1"
  | "fra1"
  | "lon1"
  | "mem1"
  | "mkc1"
  | "nyc1"
  | "nyc2"
  | "nyc3"
  | "ric1"
  | "sfo2"
  | "sfo3"
  | "sgp1"
  | "syd1"
  | "tor1"
  | (string & {});

/**
 * Droplet size slug. The literals are the common CPU sizes DigitalOcean
 * listed in October 2026; any other string, a GPU size included, is accepted.
 */
export type SizeSlug =
  | "s-1vcpu-512mb-10gb"
  | "s-1vcpu-1gb"
  | "s-1vcpu-1gb-intel"
  | "s-1vcpu-1gb-35gb-intel"
  | "s-1vcpu-2gb"
  | "s-1vcpu-2gb-intel"
  | "s-1vcpu-2gb-70gb-intel"
  | "s-2vcpu-2gb"
  | "s-2vcpu-2gb-intel"
  | "s-2vcpu-2gb-90gb-intel"
  | "s-2vcpu-4gb"
  | "s-2vcpu-4gb-intel"
  | "s-2vcpu-4gb-120gb-intel"
  | "s-2vcpu-8gb-160gb-intel"
  | "s-4vcpu-8gb"
  | "s-4vcpu-8gb-intel"
  | "s-4vcpu-8gb-240gb-intel"
  | "c-2"
  | "c-4"
  | "g-2vcpu-8gb"
  | "gd-2vcpu-8gb"
  | "m-2vcpu-16gb"
  | (string & {});

/**
 * Public image slug. Unlisted slugs, Marketplace 1-Click slugs included, are
 * also accepted.
 */
export type ImageSlug =
  | "ubuntu-22-04-x64"
  | "ubuntu-24-04-x64"
  | "ubuntu-26-04-x64"
  | "debian-13-x64"
  | "fedora-43-x64"
  | "fedora-44-x64"
  | "almalinux-8-x64"
  | "almalinux-9-x64"
  | "almalinux-10-x64"
  | "rockylinux-8-x64"
  | "rockylinux-9-x64"
  | "rockylinux-10-x64"
  | "centos-stream-9-x64"
  | "centos-stream-10-x64"
  | "gpu-amd-base"
  | "gpu-h100x1-base"
  | "gpu-h100x8-base"
  | (string & {});
