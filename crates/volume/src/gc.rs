//! Garbage collection: mark every object reachable from the heads, sweep the
//! rest.
//!
//! A commit uploads its pack, pages and manifest before it moves the head, so
//! for a moment they're reachable from nothing. Objects younger than the grace
//! period are never deleted, which keeps an in-flight commit safe as long as it
//! finishes within it.

use crate::manifest::{Manifest, Page};
use crate::pack::Pack;
use crate::{Error, Hash, Result, Volume};
use std::collections::HashSet;
use std::time::{Duration, SystemTime};

/// How much to keep.
#[derive(Clone, Debug)]
pub struct GcOptions {
    /// Snapshots kept per head, newest first; `None` keeps all of history.
    pub history: Option<usize>,
    /// Objects younger than this are kept even when unreachable.
    pub grace: Duration,
    /// Report what would be deleted without deleting it.
    pub dry_run: bool,
}

impl Default for GcOptions {
    fn default() -> Self {
        Self {
            history: None,
            grace: Duration::from_secs(3600),
            dry_run: false,
        }
    }
}

/// What a collection found and did.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct GcReport {
    pub heads: usize,
    pub snapshots: usize,
    pub reachable: usize,
    pub deleted: usize,
    pub deleted_bytes: u64,
    /// Unreachable but younger than the grace period.
    pub spared: usize,
}

impl Volume {
    pub async fn gc(&self, options: &GcOptions) -> Result<GcReport> {
        let heads = self.heads().await?;
        let mut report = GcReport {
            heads: heads.len(),
            ..Default::default()
        };

        // mark
        let mut manifests: HashSet<Hash> = HashSet::new();
        let mut pages: HashSet<Hash> = HashSet::new();
        let mut packs: HashSet<Hash> = HashSet::new();
        for (_, head) in &heads {
            let mut next = Some(*head);
            let mut depth = 0;
            while let Some(id) = next {
                if options.history.is_some_and(|keep| depth >= keep) || !manifests.insert(id) {
                    break; // pruned, or already marked through another head
                }
                depth += 1;
                let manifest = match self.manifest(&id).await {
                    Ok(manifest) => manifest,
                    Err(Error::Missing(_)) => break, // history pruned earlier
                    Err(e) => return Err(e),
                };
                for page_id in manifest.pages.iter().flatten() {
                    if pages.insert(*page_id) {
                        for entry in self.page_entries(page_id).await?.into_iter().flatten() {
                            packs.insert(entry.pack);
                        }
                    }
                }
                next = manifest.parent;
            }
        }
        report.snapshots = manifests.len();
        let reachable: HashSet<String> = manifests
            .iter()
            .map(Manifest::key)
            .chain(pages.iter().map(Page::key))
            .chain(packs.iter().map(Pack::key))
            .collect();
        report.reachable = reachable.len();

        // sweep
        let cutoff = SystemTime::now() - options.grace;
        for prefix in ["manifests/", "pages/", "packs/"] {
            for object in self.blobs().list(prefix).await? {
                if reachable.contains(&object.key) {
                    continue;
                }
                if object.modified > cutoff {
                    report.spared += 1;
                    continue;
                }
                if !options.dry_run {
                    self.blobs().delete(&object.key).await?;
                }
                report.deleted += 1;
                report.deleted_bytes += object.size;
            }
        }
        if !options.dry_run {
            self.forget_cached();
        }
        Ok(report)
    }
}
