//! Networks for commands: each container (and microVM) gets its own network
//! namespace with one interface on a bridge, and reaches out through NAT.
//!
//! What it can't reach is the host's policy: the instance's metadata service
//! (the host's credentials), the host itself, the bridge's other ports (other
//! sessions' commands), and whatever CIDRs the host denies (its VPC: the
//! other hosts). DNS to the host's resolvers is let through first. A lease
//! can narrow egress further to an allowlist of CIDRs.
//!
//! ```text
//! FORWARD  -i blockd0 → BLOCKD: DNS to the resolvers → ACCEPT
//!                               the denied CIDRs     → DROP
//!                               BLOCKD-EGRESS (a lease's allowlist, then DROP)
//!                               → ACCEPT
//! INPUT    -i blockd0: replies → ACCEPT, the rest → DROP
//! nat      -s 10.200.0.0/16 ! -o blockd0 → MASQUERADE
//! ```

use anyhow::{Context, Result, bail};
use std::collections::BTreeSet;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const BRIDGE: &str = "blockd0";
const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 200, 0, 1);
const SUBNET: &str = "10.200.0.0/16";
const PREFIX: u8 = 16;

/// The host's side: the bridge, NAT and the rules every lease shares.
#[derive(Debug)]
pub struct Networks {
    resolvers: Vec<Ipv4Addr>,
    used: Mutex<BTreeSet<u16>>,
}

/// One namespace's network, released when dropped.
pub struct Lease {
    networks: Arc<Networks>,
    index: u16,
    pub address: Ipv4Addr,
    /// Where runtimes join it: `/run/netns/<name>`.
    pub namespace: PathBuf,
    /// For a microVM, a tap on the bridge instead of a namespace.
    pub tap: Option<String>,
    allow: Vec<String>,
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program).args(args).stdin(Stdio::null()).output().with_context(|| format!("running {program}"))?;
    if !output.status.success() {
        bail!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

/// Runs `args`, unless `check` (the same rule with `-C`) says it's there.
fn iptables_once(table: &str, check: &[&str], add: &[&str]) -> Result<()> {
    let exists = Command::new("iptables").args(["-w", "-t", table]).args(check).stderr(Stdio::null()).status()?.success();
    if !exists {
        run("iptables", &[&["-w", "-t", table][..], add].concat())?;
    }
    Ok(())
}

/// The nameservers the host itself uses (not systemd-resolved's stub, which
/// a namespace can't reach).
fn host_resolvers() -> Vec<Ipv4Addr> {
    for file in ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"] {
        let found: Vec<Ipv4Addr> = std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.strip_prefix("nameserver"))
            .filter_map(|address| address.trim().parse::<Ipv4Addr>().ok())
            .filter(|address| !address.is_loopback())
            .collect();
        if !found.is_empty() {
            return found;
        }
    }
    vec![Ipv4Addr::new(1, 1, 1, 1)]
}

impl Networks {
    /// Sets up the bridge and the shared rules (again, if they're there).
    /// `deny` is CIDRs no command reaches, beyond the metadata service.
    pub fn setup(deny: &[String]) -> Result<Arc<Self>> {
        if Command::new("ip").args(["link", "show", BRIDGE]).stdout(Stdio::null()).stderr(Stdio::null()).status()?.success() {
            // A daemon before this one made it.
        } else {
            run("ip", &["link", "add", BRIDGE, "type", "bridge"])?;
        }
        let gateway = format!("{GATEWAY}/{PREFIX}");
        let addresses = Command::new("ip").args(["-4", "addr", "show", BRIDGE]).output()?;
        if !String::from_utf8_lossy(&addresses.stdout).contains(&gateway) {
            run("ip", &["addr", "add", &gateway, "dev", BRIDGE])?;
        }
        run("ip", &["link", "set", BRIDGE, "up"])?;
        std::fs::write("/proc/sys/net/ipv4/ip_forward", "1").context("enabling IP forwarding")?;

        let resolvers = host_resolvers();
        for chain in ["BLOCKD", "BLOCKD-EGRESS"] {
            let _ = Command::new("iptables").args(["-w", "-N", chain]).stderr(Stdio::null()).status();
        }
        // The shared chain, rebuilt: a policy change takes effect on restart.
        run("iptables", &["-w", "-F", "BLOCKD"])?;
        run("iptables", &["-w", "-F", "BLOCKD-EGRESS"])?;
        for resolver in &resolvers {
            for protocol in ["udp", "tcp"] {
                let resolver = resolver.to_string();
                run("iptables", &["-w", "-A", "BLOCKD", "-p", protocol, "-d", &resolver, "--dport", "53", "-j", "ACCEPT"])?;
            }
        }
        let mut denied = vec!["169.254.0.0/16".to_string()];
        denied.extend(deny.iter().cloned());
        for cidr in &denied {
            run("iptables", &["-w", "-A", "BLOCKD", "-d", cidr, "-j", "DROP"])?;
        }
        run("iptables", &["-w", "-A", "BLOCKD", "-j", "BLOCKD-EGRESS"])?;
        run("iptables", &["-w", "-A", "BLOCKD", "-j", "ACCEPT"])?;

        // Replies to what a namespace started come back; it starts nothing
        // toward the host, and the host's other forwarding is untouched.
        iptables_once("filter", &["-C", "FORWARD", "-i", BRIDGE, "-j", "BLOCKD"], &["-I", "FORWARD", "1", "-i", BRIDGE, "-j", "BLOCKD"])?;
        let established = ["-o", BRIDGE, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"];
        iptables_once("filter", &[&["-C", "FORWARD"][..], &established].concat(), &[&["-I", "FORWARD", "1"][..], &established].concat())?;
        iptables_once("filter", &["-C", "INPUT", "-i", BRIDGE, "-j", "DROP"], &["-I", "INPUT", "1", "-i", BRIDGE, "-j", "DROP"])?;
        let replies = ["-i", BRIDGE, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"];
        iptables_once("filter", &[&["-C", "INPUT"][..], &replies].concat(), &[&["-I", "INPUT", "1"][..], &replies].concat())?;
        iptables_once(
            "nat",
            &["-C", "POSTROUTING", "-s", SUBNET, "!", "-o", BRIDGE, "-j", "MASQUERADE"],
            &["-A", "POSTROUTING", "-s", SUBNET, "!", "-o", BRIDGE, "-j", "MASQUERADE"],
        )?;
        Ok(Arc::new(Self { resolvers, used: Mutex::new(BTreeSet::new()) }))
    }

    /// The host's resolvers, for a namespace's `resolv.conf`.
    pub fn resolv_conf(&self) -> String {
        self.resolvers.iter().map(|r| format!("nameserver {r}\n")).collect()
    }

    fn allocate(&self) -> Result<u16> {
        let mut used = self.used.lock().unwrap();
        // .0.1 is the gateway; .255.255 the broadcast.
        let index = (2..u16::MAX).find(|i| !used.contains(i)).context("no addresses left on the bridge")?;
        used.insert(index);
        Ok(index)
    }

    /// A namespace of its own, for a container. `allow` (CIDRs) narrows its
    /// egress; empty, it reaches whatever the host's policy lets through.
    pub fn lease(self: &Arc<Self>, allow: &[String]) -> Result<Lease> {
        let index = self.allocate()?;
        // On failure the lease drops, and takes down what was set up.
        let lease = Lease::new(self, index, allow, None);
        lease.setup_namespace()?;
        lease.restrict()?;
        Ok(lease)
    }

    /// A tap on the bridge, for a microVM: the guest configures the address.
    pub fn tap(self: &Arc<Self>, allow: &[String]) -> Result<Lease> {
        let index = self.allocate()?;
        let name = format!("bdt{index}");
        let lease = Lease::new(self, index, allow, Some(name.clone()));
        let _ = Command::new("ip").args(["link", "del", &name]).stderr(Stdio::null()).status();
        run("ip", &["tuntap", "add", "dev", &name, "mode", "tap"])?;
        run("ip", &["link", "set", &name, "master", BRIDGE, "up"])?;
        run("bridge", &["link", "set", "dev", &name, "isolated", "on"])?;
        lease.restrict()?;
        Ok(lease)
    }
}

impl Lease {
    fn new(networks: &Arc<Networks>, index: u16, allow: &[String], tap: Option<String>) -> Self {
        Self {
            networks: networks.clone(),
            index,
            address: Ipv4Addr::new(10, 200, (index >> 8) as u8, (index & 0xff) as u8),
            namespace: PathBuf::from(format!("/run/netns/bd-{index}")),
            tap,
            allow: allow.to_vec(),
        }
    }

    pub fn gateway(&self) -> Ipv4Addr {
        GATEWAY
    }

    pub fn prefix(&self) -> u8 {
        PREFIX
    }

    /// A MAC address of its own (clones of a snapshot share the template's).
    pub fn mac(&self) -> String {
        format!("06:00:0a:c8:{:02x}:{:02x}", self.index >> 8, self.index & 0xff)
    }

    pub fn resolv_conf(&self) -> String {
        self.networks.resolv_conf()
    }

    fn setup_namespace(&self) -> Result<()> {
        let (ns, host, inside) = (format!("bd-{}", self.index), format!("bdh{}", self.index), format!("bdc{}", self.index));
        let _ = Command::new("ip").args(["netns", "del", &ns]).stderr(Stdio::null()).status();
        let _ = Command::new("ip").args(["link", "del", &host]).stderr(Stdio::null()).status();
        run("ip", &["netns", "add", &ns])?;
        run("ip", &["link", "add", &host, "type", "veth", "peer", "name", &inside])?;
        run("ip", &["link", "set", &inside, "netns", &ns])?;
        run("ip", &["link", "set", &host, "master", BRIDGE, "up"])?;
        // Bridge ports that can't reach each other: only the host's side.
        run("bridge", &["link", "set", "dev", &host, "isolated", "on"])?;
        let address = format!("{}/{PREFIX}", self.address);
        let gateway = GATEWAY.to_string();
        run("ip", &["-n", &ns, "link", "set", &inside, "name", "eth0"])?;
        run("ip", &["-n", &ns, "addr", "add", &address, "dev", "eth0"])?;
        run("ip", &["-n", &ns, "link", "set", "eth0", "up"])?;
        run("ip", &["-n", &ns, "link", "set", "lo", "up"])?;
        run("ip", &["-n", &ns, "route", "add", "default", "via", &gateway])?;
        Ok(())
    }

    /// The allowlist's rules: its CIDRs, then nothing else.
    fn rules(&self) -> Vec<Vec<String>> {
        if self.allow.is_empty() {
            return Vec::new();
        }
        let source = self.address.to_string();
        let mut rules: Vec<Vec<String>> = self
            .allow
            .iter()
            .map(|cidr| ["-s", &source, "-d", cidr, "-j", "ACCEPT"].map(String::from).to_vec())
            .collect();
        rules.push(["-s", &source, "-j", "DROP"].map(String::from).to_vec());
        rules
    }

    fn restrict(&self) -> Result<()> {
        for rule in self.rules() {
            let rule: Vec<&str> = rule.iter().map(String::as_str).collect();
            run("iptables", &[&["-w", "-A", "BLOCKD-EGRESS"][..], &rule].concat())?;
        }
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        for rule in self.rules() {
            let rule: Vec<&str> = rule.iter().map(String::as_str).collect();
            let _ = run("iptables", &[&["-w", "-D", "BLOCKD-EGRESS"][..], &rule].concat());
        }
        match &self.tap {
            Some(tap) => {
                let _ = run("ip", &["link", "del", tap]);
            }
            None => {
                let _ = run("ip", &["netns", "del", &format!("bd-{}", self.index)]);
                let _ = Command::new("ip").args(["link", "del", &format!("bdh{}", self.index)]).stderr(Stdio::null()).status();
            }
        }
        self.networks.used.lock().unwrap().remove(&self.index);
    }
}
