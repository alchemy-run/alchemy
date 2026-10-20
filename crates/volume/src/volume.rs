use crate::manifest::{Entry, Manifest, PAGE_ENTRIES, Page};
use crate::pack::{Pack, PackBuilder, open_chunk};
use crate::store::{BlobStore, MetaStore};
use crate::{EXTENT_SIZE, Error, Hash, Result, is_zero};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::{Arc, Mutex};

/// Imports seal a pack every this many extents (64 MiB before compression).
const IMPORT_PACK_EXTENTS: usize = 256;

/// A change to one extent in a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// The extent's new contents: exactly one extent of bytes.
    Write(Vec<u8>),
    /// The extent is now all zeros (trimmed or discarded).
    Zero,
}

/// Volumes in one store: their snapshots, heads and contents.
///
/// Snapshots and pages are immutable, so they're cached forever once read.
pub struct Volume {
    blobs: Arc<dyn BlobStore>,
    meta: Arc<dyn MetaStore>,
    manifests: Mutex<HashMap<Hash, Arc<Manifest>>>,
    pages: Mutex<HashMap<Hash, Arc<Page>>>,
}

impl Volume {
    pub fn new(blobs: Arc<dyn BlobStore>, meta: Arc<dyn MetaStore>) -> Self {
        Self {
            blobs,
            meta,
            manifests: Mutex::default(),
            pages: Mutex::default(),
        }
    }

    pub fn blobs(&self) -> &Arc<dyn BlobStore> {
        &self.blobs
    }

    // ── heads ──────────────────────────────────────────────────────────

    /// Creates `head` as an empty volume of `size` bytes.
    pub async fn create(&self, head: &str, size: u64) -> Result<Hash> {
        check_size(size)?;
        let id = self
            .put_manifest(&Manifest::empty(size, EXTENT_SIZE as u32))
            .await?;
        self.create_head(head, id).await?;
        Ok(id)
    }

    /// Creates `head` from a disk image (an ext4 image from `mkfs.ext4 -d`,
    /// say), storing only its non-zero extents. A short final extent is padded
    /// with zeros, and `size` is rounded up to whole extents.
    pub async fn import(&self, head: &str, size: u64, mut image: impl Read) -> Result<Hash> {
        let size = size.div_ceil(EXTENT_SIZE) * EXTENT_SIZE;
        check_size(size)?;
        let mut manifest = Manifest::empty(size, EXTENT_SIZE as u32);
        let mut pages: BTreeMap<usize, Page> = BTreeMap::new();
        let mut builder = PackBuilder::new();
        let mut pending: Vec<(u64, Hash)> = Vec::new();
        let mut buffer = vec![0u8; EXTENT_SIZE as usize];
        for extent in 0..manifest.extents() {
            buffer.fill(0);
            if read_full(&mut image, &mut buffer)? == 0 {
                break;
            }
            if !is_zero(&buffer) {
                let chunk = builder.add(&buffer)?;
                pending.push((extent, chunk));
            }
            if pending.len() >= IMPORT_PACK_EXTENTS {
                self.seal_into(&mut pages, std::mem::take(&mut builder), &mut pending)
                    .await?;
            }
        }
        self.seal_into(&mut pages, builder, &mut pending).await?;
        for (index, page) in pages {
            manifest.pages[index] = Some(self.put_page(&page).await?);
        }
        let id = self.put_manifest(&manifest).await?;
        self.create_head(head, id).await?;
        Ok(id)
    }

    /// The snapshot `head` points at.
    pub async fn head(&self, head: &str) -> Result<Hash> {
        self.meta
            .get(head)
            .await?
            .ok_or_else(|| Error::NoHead(head.into()))
    }

    pub async fn heads(&self) -> Result<Vec<(String, Hash)>> {
        self.meta.list().await
    }

    /// A new head `to` on the snapshot `from` points at. Nothing is copied.
    pub async fn fork(&self, from: &str, to: &str) -> Result<Hash> {
        let id = self.head(from).await?;
        self.create_head(to, id).await?;
        Ok(id)
    }

    /// A new head `to` on snapshot `id`.
    pub async fn fork_at(&self, id: Hash, to: &str) -> Result<()> {
        self.manifest(&id).await?; // it must exist
        self.create_head(to, id).await
    }

    /// Points `head` at snapshot `to`: a rewind, or adopting another fork.
    pub async fn reset(&self, head: &str, to: Hash) -> Result<()> {
        self.manifest(&to).await?;
        let current = self.head(head).await?;
        self.meta.cas(head, Some(current), Some(to)).await
    }

    /// Deletes `head`. Its snapshots stay until garbage collection.
    pub async fn drop_head(&self, head: &str) -> Result<()> {
        let current = self.head(head).await?;
        self.meta.cas(head, Some(current), None).await
    }

    async fn create_head(&self, head: &str, id: Hash) -> Result<()> {
        match self.meta.cas(head, None, Some(id)).await {
            Err(Error::Conflict { .. }) => Err(Error::HeadExists(head.into())),
            other => other,
        }
    }

    // ── snapshots ──────────────────────────────────────────────────────

    pub async fn manifest(&self, id: &Hash) -> Result<Arc<Manifest>> {
        if let Some(found) = self.manifests.lock().unwrap().get(id) {
            return Ok(found.clone());
        }
        let key = Manifest::key(id);
        let bytes = self.blobs.get(&key).await?;
        verify(&key, id, &bytes)?;
        let manifest = Arc::new(Manifest::decode(&bytes)?);
        self.manifests.lock().unwrap().insert(*id, manifest.clone());
        Ok(manifest)
    }

    async fn page(&self, id: &Hash) -> Result<Arc<Page>> {
        if let Some(found) = self.pages.lock().unwrap().get(id) {
            return Ok(found.clone());
        }
        let key = Page::key(id);
        let bytes = self.blobs.get(&key).await?;
        verify(&key, id, &bytes)?;
        let page = Arc::new(Page::decode(&bytes)?);
        self.pages.lock().unwrap().insert(*id, page.clone());
        Ok(page)
    }

    /// Where extent `extent` of snapshot `id` is stored; `None` is zeros.
    pub async fn entry(&self, id: &Hash, extent: u64) -> Result<Option<Entry>> {
        let manifest = self.manifest(id).await?;
        if extent >= manifest.extents() {
            return Err(Error::Invalid(format!("extent {extent} is past the end")));
        }
        let (page, slot) = locate(extent);
        match manifest.pages[page] {
            None => Ok(None),
            Some(page_id) => Ok(self.page(&page_id).await?.entries[slot]),
        }
    }

    /// The contents of extent `extent` of snapshot `id`; `None` is zeros.
    pub async fn read_extent(&self, id: &Hash, extent: u64) -> Result<Option<Vec<u8>>> {
        let Some(entry) = self.entry(id, extent).await? else {
            return Ok(None);
        };
        self.read_entry(&entry).await.map(Some)
    }

    /// Fetches one stored extent by its byte range in the pack.
    pub async fn read_entry(&self, entry: &Entry) -> Result<Vec<u8>> {
        let body = self
            .blobs
            .get_range(
                &Pack::key(&entry.pack),
                entry.offset,
                entry.offset + entry.len as u64,
            )
            .await?;
        open_chunk(&body, &entry.chunk, EXTENT_SIZE as usize)
    }

    /// A new snapshot: `base` with `changes` applied. Heads don't move.
    pub async fn snapshot(&self, base: &Hash, changes: Vec<(u64, Change)>) -> Result<Hash> {
        let parent = self.manifest(base).await?;
        let mut by_page: BTreeMap<usize, Vec<(usize, Change)>> = BTreeMap::new();
        for (extent, change) in changes {
            if extent >= parent.extents() {
                return Err(Error::Invalid(format!("extent {extent} is past the end")));
            }
            if let Change::Write(bytes) = &change
                && bytes.len() as u64 != EXTENT_SIZE
            {
                return Err(Error::Invalid(format!(
                    "extent {extent} write of {} bytes",
                    bytes.len()
                )));
            }
            let (page, slot) = locate(extent);
            by_page.entry(page).or_default().push((slot, change));
        }

        let mut builder = PackBuilder::new();
        let mut pages: BTreeMap<usize, Page> = BTreeMap::new();
        let mut pending: Vec<(u64, Hash)> = Vec::new();
        for (page_index, changes) in by_page {
            let mut page = match parent.pages[page_index] {
                Some(id) => (*self.page(&id).await?).clone(),
                None => Page::default(),
            };
            for (slot, change) in changes {
                let extent = (page_index * PAGE_ENTRIES + slot) as u64;
                match change {
                    Change::Zero => page.entries[slot] = None,
                    Change::Write(bytes) if is_zero(&bytes) => page.entries[slot] = None,
                    Change::Write(bytes) => {
                        let chunk = Hash::of(&bytes);
                        let unchanged = page.entries[slot].is_some_and(|e| e.chunk == chunk);
                        if !unchanged {
                            builder.add(&bytes)?;
                            pending.push((extent, chunk));
                        }
                    }
                }
            }
            pages.insert(page_index, page);
        }
        self.seal_into(&mut pages, builder, &mut pending).await?;

        let mut manifest = (*parent).clone();
        manifest.parent = Some(*base);
        for (index, page) in pages {
            manifest.pages[index] = if page.is_empty() {
                None
            } else {
                Some(self.put_page(&page).await?)
            };
        }
        self.put_manifest(&manifest).await
    }

    /// Commits `changes` on top of `base` and moves `head` from `base` to the
    /// new snapshot. With no changes, nothing is written and `base` is
    /// returned. Fails with [`Error::Conflict`] if `head` moved.
    pub async fn commit(
        &self,
        head: &str,
        base: &Hash,
        changes: Vec<(u64, Change)>,
    ) -> Result<Hash> {
        if changes.is_empty() {
            let current = self.head(head).await?;
            if current != *base {
                return Err(Error::Conflict {
                    head: head.into(),
                    expected: Some(*base),
                    found: Some(current),
                });
            }
            return Ok(*base);
        }
        let id = self.snapshot(base, changes).await?;
        self.meta.cas(head, Some(*base), Some(id)).await?;
        Ok(id)
    }

    /// Snapshot `id` and its ancestors, newest first.
    pub async fn history(&self, id: &Hash, limit: usize) -> Result<Vec<Hash>> {
        let mut out = Vec::new();
        let mut next = Some(*id);
        while let Some(current) = next {
            if out.len() >= limit {
                break;
            }
            out.push(current);
            next = self.manifest(&current).await?.parent;
        }
        Ok(out)
    }

    /// The extents that differ between two snapshots. Shared pages are
    /// skipped without being read.
    pub async fn diff(&self, a: &Hash, b: &Hash) -> Result<Vec<u64>> {
        let (ma, mb) = (self.manifest(a).await?, self.manifest(b).await?);
        if ma.size != mb.size {
            return Err(Error::Invalid("snapshots of different sizes".into()));
        }
        let mut changed = Vec::new();
        for (index, (pa, pb)) in ma.pages.iter().zip(&mb.pages).enumerate() {
            if pa == pb {
                continue;
            }
            let load = |id: &Option<Hash>| {
                let id = *id;
                async move {
                    match id {
                        Some(id) => Ok::<_, Error>(self.page(&id).await?),
                        None => Ok(Arc::new(Page::default())),
                    }
                }
            };
            let (ea, eb) = (load(pa).await?, load(pb).await?);
            for slot in 0..PAGE_ENTRIES {
                let chunk = |e: &Option<Entry>| e.map(|e| e.chunk);
                if chunk(&ea.entries[slot]) != chunk(&eb.entries[slot]) {
                    changed.push((index * PAGE_ENTRIES + slot) as u64);
                }
            }
        }
        Ok(changed)
    }

    // ── writing objects ────────────────────────────────────────────────

    /// Seals the pack, uploads it, and points each pending extent at its slot.
    async fn seal_into(
        &self,
        pages: &mut BTreeMap<usize, Page>,
        builder: PackBuilder,
        pending: &mut Vec<(u64, Hash)>,
    ) -> Result<()> {
        if builder.is_empty() {
            return Ok(());
        }
        let pack = builder.seal();
        for (extent, chunk) in pending.drain(..) {
            let slot = pack
                .slot(&chunk)
                .expect("every pending chunk is in its pack");
            let (page, index) = locate(extent);
            pages.entry(page).or_default().entries[index] = Some(Entry {
                chunk,
                pack: pack.id,
                offset: slot.offset,
                len: slot.len,
            });
        }
        self.blobs.put(&Pack::key(&pack.id), pack.bytes).await
    }

    async fn put_page(&self, page: &Page) -> Result<Hash> {
        let bytes = page.encode();
        let id = Hash::of(&bytes);
        self.blobs.put(&Page::key(&id), bytes).await?;
        self.pages
            .lock()
            .unwrap()
            .insert(id, Arc::new(page.clone()));
        Ok(id)
    }

    async fn put_manifest(&self, manifest: &Manifest) -> Result<Hash> {
        let bytes = manifest.encode();
        let id = Hash::of(&bytes);
        self.blobs.put(&Manifest::key(&id), bytes).await?;
        self.manifests
            .lock()
            .unwrap()
            .insert(id, Arc::new(manifest.clone()));
        Ok(id)
    }
}

fn locate(extent: u64) -> (usize, usize) {
    (
        (extent as usize) / PAGE_ENTRIES,
        (extent as usize) % PAGE_ENTRIES,
    )
}

fn check_size(size: u64) -> Result<()> {
    if size == 0 || !size.is_multiple_of(EXTENT_SIZE) {
        return Err(Error::Invalid(format!(
            "size {size} is not a positive multiple of {EXTENT_SIZE}"
        )));
    }
    Ok(())
}

fn verify(key: &str, id: &Hash, bytes: &[u8]) -> Result<()> {
    if Hash::of(bytes) != *id {
        return Err(Error::Corrupt {
            key: key.into(),
            reason: "hash mismatch".into(),
        });
    }
    Ok(())
}

fn read_full(reader: &mut impl Read, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}
