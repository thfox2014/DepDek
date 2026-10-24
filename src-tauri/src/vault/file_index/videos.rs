//! User-only video references. No transcoder, network, model or arbitrary filesystem access.
use super::*;
use redb::ReadableTableMetadata;
use serde::de::DeserializeOwned;
use std::collections::BTreeSet;

const TAGS: TableDefinition<&str, &str> = TableDefinition::new("video_tags_v1");
const STORIES: TableDefinition<&str, &str> = TableDefinition::new("video_stories_v1");
const VIDEO_BYTES: u64 = 64 * 1024 * 1024;
const STORY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VideoReference {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoReadInput {
    pub library_id: String,
    pub reference: VideoReference,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoTagRecord {
    pub path: String,
    pub sha256: String,
    pub tags: Vec<PhotoTag>,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoTagsInput {
    pub library_id: String,
    pub reference: VideoReference,
    pub tags: Vec<PhotoTag>,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoStory {
    pub id: String,
    pub title: String,
    pub references: Vec<VideoReference>,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoStoryInput {
    pub library_id: String,
    pub id: String,
    pub title: String,
    pub references: Vec<VideoReference>,
    pub expected_revision: u64,
}
#[derive(Debug, Serialize)]
pub struct VideoLibraryItem {
    pub file: FileIndexRecord,
    pub tags: Vec<PhotoTag>,
    pub revision: u64,
}
#[derive(Debug, Serialize)]
pub struct VideoLibraryResult {
    pub items: Vec<VideoLibraryItem>,
    pub total: usize,
    pub summary: FileIndexSummary,
    pub stories: Vec<VideoStory>,
}

fn invalid(message: &str) -> VaultError {
    VaultError::InvalidParams(message.into())
}
fn current(vault: &Vault, library: &str) -> Result<RootPair, VaultError> {
    let pair = vault.root_pair()?;
    if library != library_identity(&pair) {
        return Err(invalid("Home changed; reopen video library"));
    }
    Ok(pair)
}
fn indexed(db: &Database, reference: &VideoReference) -> Result<FileIndexRecord, VaultError> {
    photo_path(&reference.path, &reference.sha256)?;
    if reference.path.chars().any(char::is_control) {
        return Err(invalid("invalid video reference"));
    }
    let txn = db.begin_read().map_err(db_error)?;
    let table = txn.open_table(FILES).map_err(db_error)?;
    let row = table
        .get(reference.path.as_str())
        .map_err(db_error)?
        .ok_or_else(|| invalid("video is not indexed"))?;
    let file: FileIndexRecord = serde_json::from_str(row.value()).map_err(json_error)?;
    if file.category != FileCategory::Videos
        || file.path != reference.path
        || !file.sha256.eq_ignore_ascii_case(&reference.sha256)
    {
        return Err(invalid("video changed; update the index"));
    }
    if file.size > VIDEO_BYTES {
        return Err(VaultError::TooLarge);
    }
    Ok(file)
}
fn mime(bytes: &[u8]) -> Result<&'static str, VaultError> {
    if bytes.get(4..8) == Some(b"ftyp") && classify("", bytes).0 == FileCategory::Videos {
        Ok(if bytes.get(8..12) == Some(b"qt  ") {
            "video/quicktime"
        } else {
            "video/mp4"
        })
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        Ok(if bytes.windows(4).take(4096).any(|part| part == b"webm") {
            "video/webm"
        } else {
            "video/x-matroska"
        })
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"AVI ") {
        Ok("video/x-msvideo")
    } else {
        Err(invalid(
            "unsupported video container; original is unchanged",
        ))
    }
}
fn source(
    vault: &Vault,
    pair: &RootPair,
    reference: &VideoReference,
) -> Result<Vec<u8>, VaultError> {
    let result = indexed_source_bytes(pair, &reference.path, &reference.sha256, VIDEO_BYTES)
        .and_then(|bytes| {
            mime(&bytes)?;
            Ok(bytes)
        });
    let mut entry = AuditEntry::new("user", Op::Read, &reference.path);
    entry.ok = result.is_ok();
    entry.error = result.as_ref().err().map(ToString::to_string);
    vault.inner.audit.record_durable(entry)?;
    result
}
fn get<T: DeserializeOwned>(
    db: &Database,
    table: TableDefinition<&str, &str>,
    key: &str,
) -> Result<Option<T>, VaultError> {
    let txn = db.begin_read().map_err(db_error)?;
    let table = match txn.open_table(table) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
        Err(error) => return Err(db_error(error)),
    };
    table
        .get(key)
        .map_err(db_error)?
        .map(|row| serde_json::from_str(row.value()).map_err(json_error))
        .transpose()
}
fn stories(db: &Database) -> Result<Vec<VideoStory>, VaultError> {
    let txn = db.begin_read().map_err(db_error)?;
    let table = match txn.open_table(STORIES) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(vec![]),
        Err(error) => return Err(db_error(error)),
    };
    if table.len().map_err(db_error)? > 100 {
        return Err(VaultError::TooLarge);
    }
    let mut result: Vec<VideoStory> = Vec::new();
    for row in table.iter().map_err(db_error)? {
        result.push(serde_json::from_str(row.map_err(db_error)?.1.value()).map_err(json_error)?);
    }
    result.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(result)
}
fn put<T: Serialize>(
    db: &Database,
    definition: TableDefinition<&str, &str>,
    key: &str,
    value: &T,
) -> Result<(), VaultError> {
    let json = serde_json::to_string(value).map_err(json_error)?;
    let txn = db.begin_write().map_err(db_error)?;
    {
        txn.open_table(definition)
            .map_err(db_error)?
            .insert(key, json.as_str())
            .map_err(db_error)?;
    }
    txn.commit().map_err(db_error)
}

impl Vault {
    pub fn video_library_query(
        &self,
        session: &str,
        filter: PhotoLibraryFilter,
    ) -> Result<VideoLibraryResult, VaultError> {
        self.file_index_audited(session, Op::Search, "video-library/query", || {
            let mut checked = FileIndexFilter {
                query: filter.query,
                sha256: filter.sha256,
                offset: filter.offset,
                limit: filter.limit,
                ..Default::default()
            };
            checked.validate()?;
            if checked.limit.is_some_and(|value| value > 100) {
                return Err(invalid("video query limit exceeds 100"));
            }
            let pair = self.root_pair()?;
            let Some(db) = open_index(&pair, false)? else {
                return Ok(VideoLibraryResult {
                    items: vec![],
                    total: 0,
                    summary: FileIndexSummary {
                        library_id: library_identity(&pair),
                        ..Default::default()
                    },
                    stories: vec![],
                });
            };
            let txn = db.begin_read().map_err(db_error)?;
            let files = txn.open_table(FILES).map_err(db_error)?;
            let meta = txn.open_table(META).map_err(db_error)?;
            let mut summary: FileIndexSummary = meta
                .get("summary")
                .map_err(db_error)?
                .map(|row| serde_json::from_str(row.value()))
                .transpose()
                .map_err(json_error)?
                .unwrap_or_default();
            summary.library_id = library_identity(&pair);
            let labels = match txn.open_table(TAGS) {
                Ok(table) => Some(table),
                Err(redb::TableError::TableDoesNotExist(_)) => None,
                Err(error) => return Err(db_error(error)),
            };
            let mut items = Vec::new();
            let mut total = 0;
            let needle = checked.query.unwrap_or_default().trim().to_lowercase();
            let annotated = super::content::search_matches(&db, &needle)?;
            let paths = txn.open_multimap_table(CATEGORY).map_err(db_error)?;
            for path in paths.get("videos").map_err(db_error)? {
                let path = path.map_err(db_error)?;
                if excluded(path.value()) {
                    continue;
                }
                let row = files
                    .get(path.value())
                    .map_err(db_error)?
                    .ok_or_else(|| db_error("missing video"))?;
                let file: FileIndexRecord =
                    serde_json::from_str(row.value()).map_err(json_error)?;
                if file.category != FileCategory::Videos
                    || checked
                        .sha256
                        .as_ref()
                        .is_some_and(|sha| sha != &file.sha256)
                {
                    continue;
                }
                let saved: Option<VideoTagRecord> = labels
                    .as_ref()
                    .map(|table| {
                        table
                            .get(file.path.as_str())
                            .map_err(db_error)?
                            .map(|row| serde_json::from_str(row.value()).map_err(json_error))
                            .transpose()
                    })
                    .transpose()?
                    .flatten();
                let saved =
                    saved.filter(|value| value.path == file.path && value.sha256 == file.sha256);
                let revision = saved.as_ref().map_or(0, |value| value.revision);
                let tags = saved.map_or_else(Vec::new, |value| value.tags);
                if !needle.is_empty()
                    && !file.path.to_lowercase().contains(&needle)
                    && !file.sha256.starts_with(&needle)
                    && !annotated.contains(&(file.path.clone(), file.sha256.to_lowercase()))
                    && !tags
                        .iter()
                        .any(|tag| tag.value.to_lowercase().contains(&needle))
                {
                    continue;
                }
                if total >= checked.offset.unwrap_or(0) && items.len() < checked.limit.unwrap_or(12)
                {
                    items.push(VideoLibraryItem {
                        file,
                        tags,
                        revision,
                    });
                }
                total += 1;
            }
            Ok(VideoLibraryResult {
                items,
                total,
                summary,
                stories: stories(&db)?,
            })
        })
    }

    pub fn video_preview(
        &self,
        session: &str,
        input: VideoReadInput,
    ) -> Result<ReadBinaryResult, VaultError> {
        self.file_index_audited(session, Op::Read, "video-library/preview", || {
            let pair = current(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("video index is not ready"))?;
            indexed(&db, &input.reference)?;
            let bytes = source(self, &pair, &input.reference)?;
            Ok(ReadBinaryResult {
                size: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
                mime: mime(&bytes)?.into(),
                data_base64: BASE64.encode(&bytes),
            })
        })
    }

    pub fn video_tags_set(
        &self,
        session: &str,
        input: VideoTagsInput,
    ) -> Result<VideoTagRecord, VaultError> {
        self.file_index_audited(session, Op::Write, "video-library/tags", || {
            validate_photo_tags(&input.tags)?;
            let mut kinds = BTreeSet::new();
            for tag in &input.tags {
                if !kinds.insert(format!("{:?}", tag.kind)) {
                    return Err(invalid("duplicate video tag kind"));
                }
            }
            let pair = current(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("video index is not ready"))?;
            let file = indexed(&db, &input.reference)?;
            let old: Option<VideoTagRecord> = get(&db, TAGS, &file.path)?;
            let revision = old
                .filter(|old| old.sha256 == file.sha256)
                .map_or(0, |old| old.revision);
            if input.expected_revision != revision {
                return Err(invalid("video tag revision conflict; reopen library"));
            }
            source(self, &pair, &input.reference)?;
            self.require_ai_os_login()?;
            let record = VideoTagRecord {
                path: file.path,
                sha256: file.sha256,
                tags: input.tags,
                revision: revision + 1,
                updated_at_ms: now_ms(),
            };
            put(&db, TAGS, &record.path, &record)?;
            Ok(record)
        })
    }

    pub fn video_story_put(
        &self,
        session: &str,
        input: VideoStoryInput,
    ) -> Result<VideoStory, VaultError> {
        self.file_index_audited(session, Op::Write, "video-library/story", || {
            let valid_id = input.id.len() == 36
                && input.id.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    }
                });
            if !valid_id
                || input.title.trim() != input.title
                || input.title.is_empty()
                || input.title.chars().count() > 120
                || input.title.chars().any(char::is_control)
                || input.references.is_empty()
                || input.references.len() > 20
            {
                return Err(invalid("invalid video story or limits"));
            }
            let pair = current(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("video index is not ready"))?;
            let old: Option<VideoStory> = get(&db, STORIES, &input.id)?;
            let revision = old.as_ref().map_or(0, |old| old.revision);
            if input.expected_revision != revision {
                return Err(invalid("video story revision conflict; reopen library"));
            }
            if old.is_none() && stories(&db)?.len() >= 100 {
                return Err(VaultError::TooLarge);
            }
            let mut paths = BTreeSet::new();
            let mut size = 0;
            for reference in &input.references {
                if !paths.insert(&reference.path) {
                    return Err(invalid("duplicate video story reference"));
                }
                let file = indexed(&db, reference)?;
                if file.size > STORY_BYTES - size {
                    return Err(VaultError::TooLarge);
                }
                let bytes = source(self, &pair, reference)?;
                size += bytes.len() as u64;
                if size > STORY_BYTES {
                    return Err(VaultError::TooLarge);
                }
            }
            self.require_ai_os_login()?;
            let story = VideoStory {
                id: input.id,
                title: input.title,
                references: input.references,
                revision: revision + 1,
                updated_at_ms: now_ms(),
            };
            put(&db, STORIES, &story.id, &story)?;
            Ok(story)
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    const MP4: &[u8] = b"\0\0\0\x18ftypisom\0\0\0\0isommp42synthetic-video";
    const STORY: &str = "01234567-0123-4123-8123-0123456789ab";
    fn setup() -> (tempfile::TempDir, Vault) {
        let tmp = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(tmp.path()).unwrap();
        (tmp, vault)
    }
    fn query(vault: &Vault) -> VideoLibraryResult {
        vault
            .video_library_query("user", PhotoLibraryFilter::default())
            .unwrap()
    }
    fn seed(tmp: &tempfile::TempDir, vault: &Vault) -> VideoReference {
        fs::create_dir_all(tmp.path().join("videos")).unwrap();
        fs::write(tmp.path().join("videos/a.mp4"), MP4).unwrap();
        vault.file_index_refresh("user").unwrap();
        let item = query(vault).items.remove(0);
        VideoReference {
            path: item.file.path,
            sha256: item.file.sha256,
        }
    }
    fn read(vault: &Vault, reference: &VideoReference) -> VideoReadInput {
        VideoReadInput {
            library_id: query(vault).summary.library_id,
            reference: reference.clone(),
        }
    }
    fn tag(
        vault: &Vault,
        reference: &VideoReference,
        revision: u64,
        tags: Vec<PhotoTag>,
    ) -> VideoTagsInput {
        VideoTagsInput {
            library_id: query(vault).summary.library_id,
            reference: reference.clone(),
            tags,
            expected_revision: revision,
        }
    }
    fn story(vault: &Vault, references: Vec<VideoReference>, revision: u64) -> VideoStoryInput {
        VideoStoryInput {
            library_id: query(vault).summary.library_id,
            id: STORY.into(),
            title: "一起走过".into(),
            references,
            expected_revision: revision,
        }
    }

    #[test]
    fn video_empty_and_invalid_queries_do_not_create_storage() {
        let (tmp, vault) = setup();
        assert!(query(&vault).items.is_empty());
        assert!(query(&vault).stories.is_empty());
        assert!(!tmp.path().join(PRIVATE).exists());
        for filter in [
            PhotoLibraryFilter {
                limit: Some(101),
                ..Default::default()
            },
            PhotoLibraryFilter {
                sha256: Some("bad".into()),
                ..Default::default()
            },
        ] {
            assert!(vault.video_library_query("user", filter).is_err());
        }
        assert!(!tmp.path().join(PRIVATE).exists());
    }

    #[test]
    fn video_tags_persist_search_paginate_and_do_not_follow_same_content_copies() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        fs::write(tmp.path().join("videos/b.mp4"), MP4).unwrap();
        fs::write(tmp.path().join("photo.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        vault.file_index_refresh("user").unwrap();
        let tags = vec![PhotoTag {
            kind: PhotoTagKind::Event,
            value: "第一次看海".into(),
        }];
        let input = tag(&vault, &reference, 0, tags.clone());
        assert_eq!(vault.video_tags_set("user", input).unwrap().revision, 1);
        vault.file_index_refresh("user").unwrap();
        let next = Vault::new();
        next.set_root(tmp.path()).unwrap();
        assert_eq!(query(&next).total, 2);
        let filtered = next
            .video_library_query(
                "user",
                PhotoLibraryFilter {
                    query: Some("看海".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0].tags, tags);
        assert_eq!(query(&next).items[1].revision, 0);
        assert_eq!(
            next.video_library_query(
                "user",
                PhotoLibraryFilter {
                    sha256: Some(reference.sha256.clone()),
                    offset: Some(1),
                    limit: Some(1),
                    ..Default::default()
                }
            )
            .unwrap()
            .items[0]
                .file
                .path,
            "videos/b.mp4"
        );
        assert_eq!(
            next.video_library_query(
                "user",
                PhotoLibraryFilter {
                    query: Some(reference.sha256[..8].into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .total,
            2
        );
        assert!(next
            .video_tags_set("user", tag(&next, &reference, 0, vec![]))
            .is_err());
        next.video_tags_set("user", tag(&next, &reference, 1, vec![]))
            .unwrap();
        assert!(query(&next).items[0].tags.is_empty());
    }

    #[test]
    fn video_preview_sha_source_and_active_content_are_revalidated() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        let preview = vault
            .video_preview("user", read(&vault, &reference))
            .unwrap();
        assert_eq!(preview.mime, "video/mp4");
        assert_eq!(preview.data_base64, BASE64.encode(MP4));
        fs::write(tmp.path().join(&reference.path), b"changed").unwrap();
        assert!(vault
            .video_preview("user", read(&vault, &reference))
            .is_err());
        assert!(vault
            .video_tags_set("user", tag(&vault, &reference, 0, vec![]))
            .is_err());
        assert!(vault
            .video_story_put("user", story(&vault, vec![reference.clone()], 0))
            .is_err());
        fs::write(tmp.path().join("active.mp4"), b"<script>alert(1)</script>").unwrap();
        vault.file_index_refresh("user").unwrap();
        let file = query(&vault)
            .items
            .into_iter()
            .find(|item| item.file.path == "active.mp4")
            .unwrap()
            .file;
        assert!(vault
            .video_preview(
                "user",
                read(
                    &vault,
                    &VideoReference {
                        path: file.path,
                        sha256: file.sha256
                    }
                )
            )
            .is_err());
        for bytes in [b"\0\0\0\x18ftypavif".as_slice(), b"\x89PNG\r\n\x1a\n"] {
            assert!(mime(bytes).is_err());
        }
        assert_eq!(mime(b"\x1a\x45\xdf\xa3webm").unwrap(), "video/webm");
    }

    #[test]
    fn video_paths_symlinks_hardlinks_and_replaced_parent_are_rejected() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        for path in [
            "../videos/a.mp4",
            "/videos/a.mp4",
            "videos//a.mp4",
            "videos/./a.mp4",
            ".vault-audit.jsonl",
        ] {
            let bad = VideoReference {
                path: path.into(),
                sha256: reference.sha256.clone(),
            };
            assert!(vault.video_preview("user", read(&vault, &bad)).is_err());
            assert!(vault
                .video_tags_set("user", tag(&vault, &bad, 0, vec![]))
                .is_err());
        }
        fs::remove_file(tmp.path().join(&reference.path)).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.mp4"), MP4).unwrap();
        symlink(
            outside.path().join("a.mp4"),
            tmp.path().join(&reference.path),
        )
        .unwrap();
        assert!(vault
            .video_preview("user", read(&vault, &reference))
            .is_err());
        fs::remove_file(tmp.path().join(&reference.path)).unwrap();
        fs::hard_link(
            outside.path().join("a.mp4"),
            tmp.path().join(&reference.path),
        )
        .unwrap();
        assert!(vault
            .video_tags_set("user", tag(&vault, &reference, 0, vec![]))
            .is_err());
        assert!(vault
            .video_story_put("user", story(&vault, vec![reference.clone()], 0))
            .is_err());
        fs::remove_file(tmp.path().join(&reference.path)).unwrap();
        fs::remove_dir(tmp.path().join("videos")).unwrap();
        symlink(outside.path(), tmp.path().join("videos")).unwrap();
        assert!(vault
            .video_preview("user", read(&vault, &reference))
            .is_err());
    }

    #[test]
    fn video_annotations_do_not_survive_changed_sha_and_invalid_fields_fail() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        for tags in [
            vec![PhotoTag {
                kind: PhotoTagKind::CapturedDate,
                value: "2026-02-30".into(),
            }],
            vec![PhotoTag {
                kind: PhotoTagKind::Note,
                value: "private\ntext".into(),
            }],
            vec![PhotoTag {
                kind: PhotoTagKind::Selection,
                value: "delete".into(),
            }],
            vec![
                PhotoTag {
                    kind: PhotoTagKind::Note,
                    value: "ok".into()
                };
                2
            ],
        ] {
            assert!(vault
                .video_tags_set("user", tag(&vault, &reference, 0, tags))
                .is_err());
        }
        vault
            .video_tags_set(
                "user",
                tag(
                    &vault,
                    &reference,
                    0,
                    vec![PhotoTag {
                        kind: PhotoTagKind::Note,
                        value: "private marker".into(),
                    }],
                ),
            )
            .unwrap();
        fs::write(tmp.path().join(&reference.path), [MP4, b"new"].concat()).unwrap();
        vault.file_index_refresh("user").unwrap();
        let next = query(&vault);
        assert!(next.items[0].tags.is_empty());
        assert_eq!(next.items[0].revision, 0);
        let (audit, _) = vault.inner.audit.read(0, 500);
        assert!(!serde_json::to_string(&audit)
            .unwrap()
            .contains("private marker"));
        assert!(audit
            .iter()
            .any(|row| row.path == "video-library/tags" && row.ok));
        assert!(audit
            .iter()
            .any(|row| row.path == "video-library/tags" && !row.ok));
    }

    #[test]
    fn video_story_is_persistent_ordered_revision_checked_and_bounded() {
        let (tmp, vault) = setup();
        let first = seed(&tmp, &vault);
        fs::write(tmp.path().join("videos/b.mp4"), [MP4, b"other"].concat()).unwrap();
        vault.file_index_refresh("user").unwrap();
        let second = query(&vault).items.remove(1).file;
        let second = VideoReference {
            path: second.path,
            sha256: second.sha256,
        };
        let refs = vec![second, first.clone()];
        let saved = vault
            .video_story_put("user", story(&vault, refs.clone(), 0))
            .unwrap();
        assert_eq!(saved.references, refs);
        assert_eq!(saved.revision, 1);
        assert!(vault
            .video_story_put("user", story(&vault, refs.clone(), 0))
            .is_err());
        let reversed = refs.into_iter().rev().collect::<Vec<_>>();
        vault
            .video_story_put("user", story(&vault, reversed.clone(), 1))
            .unwrap();
        let next = Vault::new();
        next.set_root(tmp.path()).unwrap();
        assert_eq!(query(&next).stories[0].references, reversed);
        for refs in [
            vec![],
            vec![first.clone(), first.clone()],
            vec![first.clone(); 21],
        ] {
            assert!(next.video_story_put("user", story(&next, refs, 2)).is_err());
        }
        let mut bad = story(&next, vec![first], 2);
        bad.title = "bad\nname".into();
        assert!(next.video_story_put("user", bad).is_err());
        assert_eq!(query(&next).stories[0].revision, 2);
    }

    #[test]
    fn video_cap_is_checked_before_allocating_and_sources_remain_untouched() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        fs::OpenOptions::new()
            .write(true)
            .open(tmp.path().join(&reference.path))
            .unwrap()
            .set_len(VIDEO_BYTES + 1)
            .unwrap();
        assert!(matches!(
            vault.video_preview("user", read(&vault, &reference)),
            Err(VaultError::TooLarge)
        ));
        assert!(matches!(
            vault.video_tags_set("user", tag(&vault, &reference, 0, vec![])),
            Err(VaultError::TooLarge)
        ));
        assert!(matches!(
            vault.video_story_put("user", story(&vault, vec![reference.clone()], 0)),
            Err(VaultError::TooLarge)
        ));
        assert_eq!(
            fs::metadata(tmp.path().join(reference.path)).unwrap().len(),
            VIDEO_BYTES + 1
        );
    }

    #[test]
    fn video_home_login_and_agent_boundaries_apply_to_every_command() {
        let (tmp, vault) = setup();
        let reference = seed(&tmp, &vault);
        let old_read = read(&vault, &reference);
        let old_tag = tag(&vault, &reference, 0, vec![]);
        let old_story = story(&vault, vec![reference.clone()], 0);
        assert!(vault
            .video_library_query("agent", PhotoLibraryFilter::default())
            .is_err());
        assert!(vault
            .video_preview("agent", read(&vault, &reference))
            .is_err());
        assert!(vault
            .video_tags_set("agent", tag(&vault, &reference, 0, vec![]))
            .is_err());
        assert!(vault
            .video_story_put("agent", story(&vault, vec![reference.clone()], 0))
            .is_err());
        let (other, _) = setup();
        vault.set_root(other.path()).unwrap();
        seed(&other, &vault);
        assert!(vault.video_preview("user", old_read).is_err());
        assert!(vault.video_tags_set("user", old_tag).is_err());
        assert!(vault.video_story_put("user", old_story).is_err());
        assert!(query(&vault).stories.is_empty());
        assert!(query(&vault).items[0].tags.is_empty());
        vault.set_root(tmp.path()).unwrap();
        let library = library_identity(&vault.root_pair().unwrap());
        let account = tempfile::tempdir().unwrap();
        vault
            .enable_ai_os_login(
                &fs::canonicalize(account.path())
                    .unwrap()
                    .join(".jiaho-onboarding"),
            )
            .unwrap();
        assert!(vault
            .video_library_query("user", PhotoLibraryFilter::default())
            .is_err());
        assert!(vault
            .video_preview(
                "user",
                VideoReadInput {
                    library_id: library.clone(),
                    reference: reference.clone()
                }
            )
            .is_err());
        assert!(vault
            .video_tags_set(
                "user",
                VideoTagsInput {
                    library_id: library.clone(),
                    reference: reference.clone(),
                    tags: vec![],
                    expected_revision: 0
                }
            )
            .is_err());
        assert!(vault
            .video_story_put(
                "user",
                VideoStoryInput {
                    library_id: library,
                    references: vec![reference],
                    id: STORY.into(),
                    title: "test".into(),
                    expected_revision: 0
                }
            )
            .is_err());
    }
}
