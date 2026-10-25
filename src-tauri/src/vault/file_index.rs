//! Private, rebuildable file KV index. All filesystem authority remains inside Vault.
use super::*;
use redb::{Database, MultimapTableDefinition, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::{Duration, Instant, UNIX_EPOCH};

#[path = "file_index/import.rs"]
mod import;
pub use import::{FileLibraryImportInput, FileLibraryImportResult};
#[path = "file_index/documents.rs"]
mod documents;
pub use documents::*;
#[path = "file_index/videos.rs"]
mod videos;
pub use videos::*;
#[path = "file_index/content.rs"]
mod content;
pub use content::*;
#[path = "file_index/photo_classification.rs"]
mod photo_classification;
pub use photo_classification::*;
#[path = "file_index/family.rs"]
mod family;
pub use family::*;

const PRIVATE: &str = ".depdek-file-index";
const FILES: TableDefinition<&str, &str> = TableDefinition::new("files_v1");
const SHA: MultimapTableDefinition<&str, &str> = MultimapTableDefinition::new("sha_v1");
const CATEGORY: MultimapTableDefinition<&str, &str> = MultimapTableDefinition::new("category_v1");
const META: TableDefinition<&str, &str> = TableDefinition::new("meta_v1");
const PHOTO_TAGS: TableDefinition<&str, &str> = TableDefinition::new("photo_tags_v1");
const IMPORTS: TableDefinition<&str, &str> = TableDefinition::new("imports_v1");
const MAX_PHOTO_BYTES: u64 = 12 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_SECONDS: u64 = 300;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FileCategory {
    Photos,
    Documents,
    Videos,
    Mail,
    Other,
}
impl FileCategory {
    fn key(self) -> &'static str {
        match self {
            Self::Photos => "photos",
            Self::Documents => "documents",
            Self::Videos => "videos",
            Self::Mail => "mail",
            Self::Other => "other",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    pub path: String,
    pub original_path: String,
    pub name: String,
    pub sha256: String,
    pub category: FileCategory,
    pub detected_by: String,
    pub size: u64,
    pub modified_ms: u64,
    pub indexed_at_ms: u64,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileIndexCoverage { Imports, HomeSnapshot }
fn legacy_coverage() -> FileIndexCoverage { FileIndexCoverage::HomeSnapshot }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexSummary {
    #[serde(default)]
    pub library_id: String,
    #[serde(default = "legacy_coverage")]
    pub coverage: FileIndexCoverage,
    pub indexed_at_ms: u64,
    pub total: usize,
    pub total_bytes: u64,
    pub categories: BTreeMap<String, usize>,
    pub skipped: usize,
}
impl Default for FileIndexSummary {
    fn default() -> Self {
        Self {
            library_id: String::new(),
            coverage: FileIndexCoverage::Imports,
            indexed_at_ms: 0,
            total: 0,
            total_bytes: 0,
            skipped: 0,
            categories: ["photos", "documents", "videos", "mail", "other"]
                .into_iter()
                .map(|key| (key.into(), 0))
                .collect(),
        }
    }
}
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileIndexFilter {
    pub category: Option<FileCategory>,
    pub query: Option<String>,
    pub sha256: Option<String>,
    pub path_prefix: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct FileIndexResult {
    pub items: Vec<FileIndexRecord>,
    pub total: usize,
    pub summary: FileIndexSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhotoTagKind {
    Person,
    Place,
    Event,
    CapturedDate,
    Note,
    Selection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PhotoTag {
    pub kind: PhotoTagKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoTagRecord {
    pub path: String,
    pub sha256: String,
    pub tags: Vec<PhotoTag>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhotoLibraryFilter {
    pub query: Option<String>,
    pub sha256: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PhotoLibraryItem {
    pub file: FileIndexRecord,
    pub tags: Vec<PhotoTag>,
}

#[derive(Debug, Serialize)]
pub struct PhotoLibraryResult {
    pub items: Vec<PhotoLibraryItem>,
    pub total: usize,
    pub summary: FileIndexSummary,
}

fn validate_photo_tags(tags: &[PhotoTag]) -> Result<(), VaultError> {
    if tags.len() > 16 {
        return Err(VaultError::InvalidParams("too many photo tags".into()));
    }
    for tag in tags {
        if tag.value.trim() != tag.value
            || tag.value.is_empty()
            || tag.value.chars().count() > 120
            || tag.value.chars().any(char::is_control)
            || (tag.kind == PhotoTagKind::Selection && tag.value != "keep")
        {
            return Err(VaultError::InvalidParams("invalid photo tag".into()));
        }
        if tag.kind == PhotoTagKind::CapturedDate {
            let parts: Vec<_> = tag.value.split('-').collect();
            let valid = parts.len() == 3
                && parts[0].len() == 4
                && parts[1].len() == 2
                && parts[2].len() == 2
                && parts
                    .iter()
                    .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
                && parts[0]
                    .parse::<i32>()
                    .ok()
                    .zip(parts[1].parse::<u8>().ok())
                    .zip(parts[2].parse::<u8>().ok())
                    .is_some_and(|((year, month), day)| {
                        time::Month::try_from(month).ok().is_some_and(|month| {
                            time::Date::from_calendar_date(year, month, day).is_ok()
                        })
                    });
            if !valid {
                return Err(VaultError::InvalidParams(
                    "captured_date must be a valid YYYY-MM-DD date".into(),
                ));
            }
        }
    }
    Ok(())
}

fn photo_path(path: &str, sha: &str) -> Result<String, VaultError> {
    if path.len() > 1024
        || path.contains('\\')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || sha.len() != 64
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(VaultError::InvalidParams("invalid photo reference".into()));
    }
    let path = normalize(path)?;
    if excluded(&path) {
        return Err(VaultError::Escape("protected photo path".into()));
    }
    Ok(path)
}

fn indexed_photo(db: &Database, path: &str, sha: &str) -> Result<FileIndexRecord, VaultError> {
    let read = db.begin_read().map_err(db_error)?;
    let files = read.open_table(FILES).map_err(db_error)?;
    let value = files
        .get(path)
        .map_err(db_error)?
        .ok_or_else(|| VaultError::InvalidParams("photo is not indexed".into()))?;
    let file: FileIndexRecord = serde_json::from_str(value.value()).map_err(json_error)?;
    if file.category != FileCategory::Photos || !file.sha256.eq_ignore_ascii_case(sha) {
        return Err(VaultError::InvalidParams(
            "photo changed; refresh the index".into(),
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn indexed_source_bytes(pair: &RootPair, path: &str, expected: &str, maximum: u64) -> Result<Vec<u8>, VaultError> {
    use std::os::unix::fs::MetadataExt;
    let mut directory = root_fd(pair)?;
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_some() {
            directory = managed_open_at(&directory, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                .map_err(db_error)?;
            continue;
        }
        let mut file = open_source(&directory, part)?;
        let before = file.metadata()?;
        if !before.is_file() || before.nlink() != 1 {
            return Err(VaultError::Escape("unsafe photo source".into()));
        }
        if before.len() > maximum {
            return Err(VaultError::TooLarge);
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 > maximum {
            return Err(VaultError::TooLarge);
        }
        if before.len() != bytes.len() as u64
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || after.nlink() != 1
            || !sha256_hex(&bytes).eq_ignore_ascii_case(expected)
        {
            return Err(VaultError::InvalidParams(
                "photo changed; refresh the index".into(),
            ));
        }
        return Ok(bytes);
    }
    Err(VaultError::InvalidParams("missing photo path".into()))
}
#[cfg(not(unix))]
fn indexed_source_bytes(_: &RootPair, _: &str, _: &str, _: u64) -> Result<Vec<u8>, VaultError> {
    Err(io::Error::other("photo preview currently requires Linux or macOS").into())
}

fn photo_bytes(pair: &RootPair, path: &str, expected: &str) -> Result<Vec<u8>, VaultError> {
    indexed_source_bytes(pair, path, expected, MAX_PHOTO_BYTES)
}

fn photo_mime(bytes: &[u8]) -> Result<&'static str, VaultError> {
    if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp")
        && [b"avif".as_slice(), b"avis"].contains(&bytes.get(8..12).unwrap_or_default())
    {
        Ok("image/avif")
    } else {
        Err(VaultError::InvalidParams(
            "photo preview supports JPEG, PNG, GIF, WebP and AVIF".into(),
        ))
    }
}
fn db_error(_: impl std::fmt::Display) -> VaultError {
    io::Error::other("file index unavailable, locked or invalid; original files are unchanged")
        .into()
}
fn json_error(error: serde_json::Error) -> VaultError {
    io::Error::other(error).into()
}
fn now_ms() -> u64 {
    (time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .max(0)
        / 1_000_000) as u64
}
fn library_identity(pair: &RootPair) -> String {
    #[cfg(unix)]
    { use std::os::unix::ffi::OsStrExt; sha256_hex(pair.canonical.as_os_str().as_bytes()) }
    #[cfg(not(unix))]
    { sha256_hex(pair.canonical.to_string_lossy().as_bytes()) }
}

fn excluded(path: &str) -> bool {
    path.split('/').any(|part| {
        let part = part.to_ascii_lowercase();
        part.starts_with('.')
            || matches!(
                part.as_str(),
                "secrets"
                    | "settings"
                    | "mcp"
                    | "team"
                    | "schedule"
                    | "myinfo"
                    | "mydata"
                    | "agents"
                    | "agent"
                    | "tasks"
                    | "node_modules"
                    | "accounts.json"
                    | "credentials.json"
                    | "agent.env"
                    | "master.key"
            )
            || [
                ".db",
                ".redb",
                ".sqlite",
                ".sqlite3",
                ".sqlite-wal",
                ".sqlite-shm",
                ".db-wal",
                ".db-shm",
                ".env",
                ".enc.json",
            ]
            .iter()
            .any(|suffix| part.ends_with(suffix))
    }) || is_protected_path(path)
        || path == "mail/index.json"
}

/// Recognition is deliberately bounded and deterministic, never a model call.
fn classify(path: &str, head: &[u8]) -> (FileCategory, &'static str) {
    use FileCategory::*;
    if head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(b"\xff\xd8\xff")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP"))
        || head.starts_with(b"II*\0")
        || head.starts_with(b"MM\0*")
    {
        return (Photos, "signature");
    }
    if head.starts_with(b"%PDF-") {
        return (Documents, "signature");
    }
    if head.get(4..8) == Some(b"ftyp") {
        let brand = head.get(8..12).unwrap_or_default();
        if [b"heic".as_slice(), b"heix", b"mif1", b"avif", b"avis"].contains(&brand) {
            return (Photos, "signature");
        }
        return (Videos, "signature");
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"AVI ") {
        return (Videos, "signature");
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if path.starts_with("mail/") && path.split('/').count() == 3 && ext == "md" {
        let text = String::from_utf8_lossy(head);
        let plain_headers = text.lines().any(|line| line.starts_with("From:"))
            && text.lines().any(|line| line.starts_with("Subject:"));
        let markdown_headers = text.starts_with("# ")
            && ["- **From:**", "- **To:**", "- **Date:**", "- **UID:**"]
                .iter()
                .all(|field| text.lines().any(|line| line.starts_with(field)));
        if markdown_headers
            || (plain_headers
                && (text.contains("depdek:mail-text") || text.contains("depdek:mail-html")))
        {
            return (Mail, "depdek_mail");
        }
    }
    let category = match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tif" | "tiff"
        | "heic" | "heif" | "avif" | "dng" | "cr2" | "nef" | "arw" => Photos,
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" | "mpeg" | "mpg" | "m2ts" | "wmv"
        | "flv" => Videos,
        "eml" | "msg" | "mbox" => Mail,
        "md" | "mdx" | "txt" | "rtf" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "csv" | "ppt"
        | "pptx" | "odt" | "ods" | "odp" | "pages" | "numbers" | "key" | "epub" | "json"
        | "yaml" | "yml" | "html" | "htm" => Documents,
        _ => Other,
    };
    (
        category,
        if category == Other {
            "fallback"
        } else {
            "extension"
        },
    )
}

impl FileIndexFilter {
    fn validate(&mut self) -> Result<(), VaultError> {
        if self.limit.is_some_and(|n| n == 0 || n > 200)
            || self.offset.is_some_and(|n| n > MAX_FILES)
            || self
                .query
                .as_ref()
                .is_some_and(|s| s.chars().count() > 256 || s.contains('\0'))
        {
            return Err(VaultError::InvalidParams(
                "invalid file index filter".into(),
            ));
        }
        if let Some(sha) = &mut self.sha256 {
            if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(VaultError::InvalidParams(
                    "sha256 must contain 64 hexadecimal digits".into(),
                ));
            }
            sha.make_ascii_lowercase();
        }
        if let Some(prefix) = &mut self.path_prefix {
            if prefix.len() > 1024
                || prefix.contains(['\0', '\\'])
                || prefix.starts_with('/')
                || prefix.split('/').any(|s| s == "..")
            {
                return Err(VaultError::InvalidParams(
                    "invalid index path prefix".into(),
                ));
            }
            *prefix = normalize(prefix)?;
            if !prefix.is_empty() {
                prefix.push('/');
            }
        }
        Ok(())
    }
}

impl Vault {
    fn file_index_audited<T>(
        &self,
        session: &str,
        op: Op,
        subject: &str,
        run: impl FnOnce() -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        // Keep root switches and their audit target stable through completion.
        let _guard = self.inner.file_index_guard.lock().unwrap();
        let result = (|| {
            self.require_ai_os_login()?;
            if session != "user" {
                return Err(VaultError::Escape(
                    "file index is a user-only capability".into(),
                ));
            }
            run()
        })()
        .and_then(|value| {
            self.require_ai_os_login()?;
            Ok(value)
        });
        let mut entry = AuditEntry::new(session, op, subject);
        entry.ok = result.is_ok();
        entry.error = result.as_ref().err().map(ToString::to_string);
        self.inner.audit.record_durable(entry)?;
        result
    }

    pub fn file_index_query(
        &self,
        session: &str,
        mut filter: FileIndexFilter,
    ) -> Result<FileIndexResult, VaultError> {
        self.file_index_audited(session, Op::Search, "file-index/query", || {
            filter.validate()?;
            let pair = self.root_pair()?;
            let Some(db) = open_index(&pair, false)? else {
                return Ok(FileIndexResult {
                    items: vec![],
                    total: 0,
                    summary: FileIndexSummary { library_id: library_identity(&pair), ..Default::default() },
                });
            };
            let txn = db.begin_read().map_err(db_error)?;
            let files = txn.open_table(FILES).map_err(db_error)?;
            let metadata = txn.open_table(META).map_err(db_error)?;
            let mut summary: FileIndexSummary = metadata
                .get("summary")
                .map_err(db_error)?
                .map(|v| serde_json::from_str(v.value()))
                .transpose()
                .map_err(json_error)?
                .unwrap_or_default();
            summary.library_id = library_identity(&pair);
            let mut paths = Vec::new();
            if let Some(sha) = &filter.sha256 {
                let table = txn.open_multimap_table(SHA).map_err(db_error)?;
                for path in table.get(sha.as_str()).map_err(db_error)? {
                    paths.push(path.map_err(db_error)?.value().to_owned());
                }
            } else if let Some(category) = filter.category {
                let table = txn.open_multimap_table(CATEGORY).map_err(db_error)?;
                for path in table.get(category.key()).map_err(db_error)? {
                    paths.push(path.map_err(db_error)?.value().to_owned());
                }
            } else {
                let prefix = filter.path_prefix.as_deref().unwrap_or_default();
                for entry in files.range(prefix..).map_err(db_error)? {
                    let (key, _) = entry.map_err(db_error)?;
                    if !key.value().starts_with(prefix) {
                        break;
                    }
                    paths.push(key.value().to_owned());
                }
            }
            paths.sort();
            let needle = filter
                .query
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let annotated = content::search_matches(&db, &needle)?;
            let mut items = Vec::new();
            let mut total = 0;
            for path in paths {
                if excluded(&path)
                    || filter
                        .path_prefix
                        .as_ref()
                        .is_some_and(|prefix| !path.starts_with(prefix))
                {
                    continue;
                }
                let value = files
                    .get(path.as_str())
                    .map_err(db_error)?
                    .ok_or_else(|| db_error("missing index record"))?;
                let record: FileIndexRecord =
                    serde_json::from_str(value.value()).map_err(json_error)?;
                if filter
                    .category
                    .is_some_and(|category| category != record.category)
                    || (!needle.is_empty()
                        && !path.to_lowercase().contains(&needle)
                        && !record.sha256.starts_with(&needle)
                        && !annotated.contains(&(record.path.clone(), record.sha256.to_lowercase())))
                {
                    continue;
                }
                if total >= filter.offset.unwrap_or(0) && items.len() < filter.limit.unwrap_or(100)
                {
                    items.push(record);
                }
                total += 1;
            }
            self.require_ai_os_login()?;
            Ok(FileIndexResult {
                items,
                total,
                summary,
            })
        })
    }

    pub fn photo_library_query(
        &self,
        session: &str,
        filter: PhotoLibraryFilter,
    ) -> Result<PhotoLibraryResult, VaultError> {
        self.file_index_audited(session, Op::Search, "photo-library/query", || {
            let mut checked = FileIndexFilter {
                query: filter.query,
                sha256: filter.sha256,
                offset: filter.offset,
                limit: filter.limit,
                ..Default::default()
            };
            checked.validate()?;
            if checked.limit.is_some_and(|limit| limit > 100) {
                return Err(VaultError::InvalidParams(
                    "photo query limit exceeds 100".into(),
                ));
            }
            let pair = self.root_pair()?;
            let Some(db) = open_index(&pair, false)? else {
                return Ok(PhotoLibraryResult {
                    items: vec![],
                    total: 0,
                    summary: FileIndexSummary { library_id: library_identity(&pair), ..Default::default() },
                });
            };
            let read = db.begin_read().map_err(db_error)?;
            let files = read.open_table(FILES).map_err(db_error)?;
            let metadata = read.open_table(META).map_err(db_error)?;
            let mut summary: FileIndexSummary = metadata
                .get("summary")
                .map_err(db_error)?
                .map(|value| serde_json::from_str(value.value()))
                .transpose()
                .map_err(json_error)?
                .unwrap_or_default();
            summary.library_id = library_identity(&pair);
            let tags = match read.open_table(PHOTO_TAGS) {
                Ok(table) => Some(table),
                Err(redb::TableError::TableDoesNotExist(_)) => None,
                Err(error) => return Err(db_error(error)),
            };
            let mut paths = Vec::new();
            if let Some(sha) = &checked.sha256 {
                for value in read
                    .open_multimap_table(SHA)
                    .map_err(db_error)?
                    .get(sha.as_str())
                    .map_err(db_error)?
                {
                    paths.push(value.map_err(db_error)?.value().to_owned());
                }
            } else {
                for value in read
                    .open_multimap_table(CATEGORY)
                    .map_err(db_error)?
                    .get("photos")
                    .map_err(db_error)?
                {
                    paths.push(value.map_err(db_error)?.value().to_owned());
                }
            }
            paths.sort();
            let needle = checked.query.unwrap_or_default().trim().to_lowercase();
            let annotated = content::search_matches(&db, &needle)?;
            let mut items = Vec::new();
            let mut total = 0;
            for path in paths {
                if excluded(&path) {
                    continue;
                }
                let value = files
                    .get(path.as_str())
                    .map_err(db_error)?
                    .ok_or_else(|| db_error("missing photo"))?;
                let file: FileIndexRecord =
                    serde_json::from_str(value.value()).map_err(json_error)?;
                if file.category != FileCategory::Photos {
                    continue;
                }
                let stored: Option<PhotoTagRecord> = match &tags {
                    Some(table) => table
                        .get(path.as_str())
                        .map_err(db_error)?
                        .map(|value| serde_json::from_str(value.value()))
                        .transpose()
                        .map_err(json_error)?,
                    None => None,
                };
                let labels = stored
                    .filter(|stored| stored.sha256 == file.sha256)
                    .map(|stored| stored.tags)
                    .unwrap_or_default();
                if !needle.is_empty()
                    && !path.to_lowercase().contains(&needle)
                    && !annotated.contains(&(file.path.clone(), file.sha256.to_lowercase()))
                    && !labels
                        .iter()
                        .any(|tag| tag.value.to_lowercase().contains(&needle))
                {
                    continue;
                }
                if total >= checked.offset.unwrap_or(0) && items.len() < checked.limit.unwrap_or(24)
                {
                    items.push(PhotoLibraryItem { file, tags: labels });
                }
                total += 1;
            }
            Ok(PhotoLibraryResult {
                items,
                total,
                summary,
            })
        })
    }

    pub fn photo_preview(
        &self,
        session: &str,
        path: &str,
        expected_sha256: &str,
    ) -> Result<ReadBinaryResult, VaultError> {
        self.file_index_audited(session, Op::Read, "photo-library/preview", || {
            let path = photo_path(path, expected_sha256)?;
            let pair = self.root_pair()?;
            let db = open_index(&pair, false)?
                .ok_or_else(|| VaultError::InvalidParams("photo index is not ready".into()))?;
            indexed_photo(&db, &path, expected_sha256)?;
            let bytes = photo_bytes(&pair, &path, expected_sha256)?;
            let mime = photo_mime(&bytes)?.to_owned();
            Ok(ReadBinaryResult {
                size: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
                data_base64: BASE64.encode(&bytes),
                mime,
            })
        })
    }

    pub fn photo_tags_set(
        &self,
        session: &str,
        path: &str,
        expected_sha256: &str,
        tags: Vec<PhotoTag>,
    ) -> Result<PhotoTagRecord, VaultError> {
        self.file_index_audited(session, Op::Write, "photo-library/tags", || {
            validate_photo_tags(&tags)?;
            let path = photo_path(path, expected_sha256)?;
            let pair = self.root_pair()?;
            let db = open_index(&pair, false)?
                .ok_or_else(|| VaultError::InvalidParams("photo index is not ready".into()))?;
            let file = indexed_photo(&db, &path, expected_sha256)?;
            // Verify the actual no-follow source too, not only a possibly stale snapshot.
            photo_bytes(&pair, &path, expected_sha256)?;
            self.require_ai_os_login()?;
            let mut unique = Vec::new();
            for tag in tags {
                if !unique.contains(&tag) {
                    unique.push(tag);
                }
            }
            let record = PhotoTagRecord {
                path,
                sha256: file.sha256,
                tags: unique,
                updated_at_ms: now_ms(),
            };
            let write = db.begin_write().map_err(db_error)?;
            {
                let value = serde_json::to_string(&record).map_err(json_error)?;
                write
                    .open_table(PHOTO_TAGS)
                    .map_err(db_error)?
                    .insert(record.path.as_str(), value.as_str())
                    .map_err(db_error)?;
            }
            write.commit().map_err(db_error)?;
            Ok(record)
        })
    }

    pub fn file_index_refresh(&self, session: &str) -> Result<FileIndexSummary, VaultError> {
        self.file_index_audited(session, Op::Write, "file-index/refresh", || {
            let pair = self.root_pair()?;
            let db = open_index(&pair, true)?.ok_or_else(|| db_error("no index"))?;
            let mut scan = Scan {
                records: BTreeMap::new(),
                summary: FileIndexSummary {
                    library_id: library_identity(&pair),
                    coverage: FileIndexCoverage::HomeSnapshot,
                    indexed_at_ms: now_ms(),
                    ..Default::default()
                },
                started: Instant::now(),
                seen: 0,
            };
            scan_home(self, &pair, &mut scan)?;
            self.require_ai_os_login()?;
            let write = db.begin_write().map_err(db_error)?;
            // A single transaction ensures a failed scan never replaces the previous snapshot.
            let old: BTreeMap<String, FileIndexRecord> = {
                let table = write.open_table(FILES).map_err(db_error)?;
                table
                    .iter()
                    .map_err(db_error)?
                    .map(|entry| {
                        let (path, value) = entry.map_err(db_error)?;
                        let record: FileIndexRecord =
                            serde_json::from_str(value.value()).map_err(json_error)?;
                        Ok((path.value().to_owned(), record))
                    })
                    .collect::<Result<_, VaultError>>()?
            };
            write.delete_table(FILES).map_err(db_error)?;
            write.delete_multimap_table(SHA).map_err(db_error)?;
            write.delete_multimap_table(CATEGORY).map_err(db_error)?;
            {
                let mut files = write.open_table(FILES).map_err(db_error)?;
                let mut hashes = write.open_multimap_table(SHA).map_err(db_error)?;
                let mut categories = write.open_multimap_table(CATEGORY).map_err(db_error)?;
                for (path, record) in &mut scan.records {
                    if let Some(original) = old.get(path) {
                        record.original_path = original.original_path.clone();
                        record.file_id = original.file_id.clone();
                    }
                    let value = serde_json::to_string(record).map_err(json_error)?;
                    files
                        .insert(path.as_str(), value.as_str())
                        .map_err(db_error)?;
                    hashes
                        .insert(record.sha256.as_str(), path.as_str())
                        .map_err(db_error)?;
                    categories
                        .insert(record.category.key(), path.as_str())
                        .map_err(db_error)?;
                }
                let value = serde_json::to_string(&scan.summary).map_err(json_error)?;
                write
                    .open_table(META)
                    .map_err(db_error)?
                    .insert("summary", value.as_str())
                    .map_err(db_error)?;
            }
            write.commit().map_err(db_error)?;
            Ok(scan.summary)
        })
    }
}

struct Scan {
    records: BTreeMap<String, FileIndexRecord>,
    summary: FileIndexSummary,
    started: Instant,
    seen: usize,
}
impl Scan {
    fn budget(&self) -> Result<(), VaultError> {
        if self.seen > MAX_FILES * 4
            || self.records.len() >= MAX_FILES
            || self.summary.total_bytes > MAX_BYTES
            || self.started.elapsed() > Duration::from_secs(MAX_SECONDS)
        {
            Err(VaultError::TooLarge)
        } else {
            Ok(())
        }
    }
}

#[cfg(unix)]
fn root_fd(pair: &RootPair) -> Result<fs::File, VaultError> {
    use std::os::unix::fs::OpenOptionsExt;
    Ok(fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&pair.root)?)
}
#[cfg(unix)]
fn secure_metadata(file: &fs::File, directory: bool) -> Result<fs::Metadata, VaultError> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || (directory && !meta.is_dir())
        || (!directory && (!meta.is_file() || meta.nlink() != 1))
    {
        return Err(VaultError::Escape(
            "unsafe file index storage permissions or links".into(),
        ));
    }
    Ok(meta)
}
#[cfg(unix)]
fn open_index(pair: &RootPair, create: bool) -> Result<Option<Database>, VaultError> {
    use std::os::fd::AsRawFd;
    let root = root_fd(pair)?;
    let name = std::ffi::CString::new(PRIVATE).unwrap();
    if create
        && unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } < 0
        && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
    {
        return Err(io::Error::last_os_error().into());
    }
    let directory = match managed_open_at(&root, PRIVATE, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
        Ok(file) => file,
        Err(ManagedReadError::NotFound) if !create => return Ok(None),
        Err(_) => return Err(VaultError::Escape("unsafe file index directory".into())),
    };
    secure_metadata(&directory, true)?;
    let (file, fresh) = match managed_open_at(&directory, "index.redb", libc::O_RDWR, 0) {
        Ok(file) => (file, false),
        Err(ManagedReadError::NotFound) if !create => return Ok(None),
        Err(ManagedReadError::NotFound) => (
            managed_open_at(
                &directory,
                "index.redb",
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
            .map_err(db_error)?,
            true,
        ),
        Err(_) => return Err(VaultError::Escape("unsafe file index database".into())),
    };
    let meta = secure_metadata(&file, false)?;
    if !fresh && meta.len() == 0 {
        return Err(db_error("empty existing database"));
    }
    let mut builder = Database::builder();
    builder.set_cache_size(16 * 1024 * 1024);
    let db = builder.create_file(file).map_err(db_error)?;
    // Initialize a schema only for an explicit refresh, not a read request.
    if create {
        let write = db.begin_write().map_err(db_error)?;
        write.open_table(FILES).map_err(db_error)?;
        write.open_multimap_table(SHA).map_err(db_error)?;
        write.open_multimap_table(CATEGORY).map_err(db_error)?;
        write.open_table(META).map_err(db_error)?;
        write.open_table(IMPORTS).map_err(db_error)?;
        write.commit().map_err(db_error)?;
    }
    Ok(Some(db))
}
#[cfg(not(unix))]
fn open_index(_: &RootPair, _: bool) -> Result<Option<Database>, VaultError> {
    Err(io::Error::other("file index currently requires Linux or macOS").into())
}

#[cfg(unix)]
fn names(directory: &fs::File) -> Result<Vec<String>, VaultError> {
    use std::os::fd::AsRawFd;
    // fdopendir owns the duplicated descriptor; RAII closes on all paths.
    struct Dir(*mut libc::DIR);
    impl Drop for Dir {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let fd = unsafe { libc::dup(directory.as_raw_fd()) };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(io::Error::last_os_error().into());
    }
    let dir = Dir(raw);
    let mut result = Vec::new();
    loop {
        errno::set_errno(errno::Errno(0));
        let entry = unsafe { libc::readdir(dir.0) };
        if entry.is_null() {
            if errno::errno().0 != 0 {
                return Err(io::Error::last_os_error().into());
            }
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        let name = name
            .to_str()
            .map_err(|_| VaultError::NotUtf8("file name".into()))?;
        if name == "." || name == ".." {
            continue;
        }
        if result.len() >= MAX_FILES * 4 {
            return Err(VaultError::TooLarge);
        }
        result.push(name.to_owned());
    }
    result.sort();
    Ok(result)
}

#[cfg(unix)]
fn scan_home(vault: &Vault, pair: &RootPair, scan: &mut Scan) -> Result<(), VaultError> {
    let root = root_fd(pair)?;
    walk(vault, pair, &root, "", 0, scan)
}
#[cfg(not(unix))]
fn scan_home(_: &Vault, _: &RootPair, _: &mut Scan) -> Result<(), VaultError> {
    Err(io::Error::other("file index currently requires Linux or macOS").into())
}

#[cfg(unix)]
fn open_source(directory: &fs::File, name: &str) -> io::Result<fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn walk(
    vault: &Vault,
    pair: &RootPair,
    directory: &fs::File,
    parent: &str,
    depth: usize,
    scan: &mut Scan,
) -> Result<(), VaultError> {
    use std::os::unix::fs::MetadataExt;
    if depth > 64 {
        return Err(VaultError::TooLarge);
    }
    for name in names(directory)? {
        scan.seen += 1;
        scan.budget()?;
        vault.require_ai_os_login()?;
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        if excluded(&path) {
            scan.summary.skipped += 1;
            continue;
        }
        let mut file = match open_source(directory, &name) {
            Ok(file) => file,
            Err(error)
                if matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) =>
            {
                scan.summary.skipped += 1;
                continue;
            }
            Err(error) => {
                let error = VaultError::Io(error);
                vault.record_audit("user", Op::Read, &path, Err(&error));
                return Err(error);
            }
        };
        let before = file.metadata()?;
        if before.is_dir() {
            walk(vault, pair, &file, &path, depth + 1, scan)?;
            continue;
        }
        if !before.is_file() || before.nlink() != 1 {
            scan.summary.skipped += 1;
            continue;
        }
        let result = (|| {
            let mut hash = Sha256::new();
            let mut buf = [0u8; 64 * 1024];
            let mut head = Vec::with_capacity(64 * 1024);
            let mut size = 0;
            loop {
                let length = file.read(&mut buf)?;
                if length == 0 {
                    break;
                }
                if head.len() < 64 * 1024 {
                    head.extend_from_slice(&buf[..length.min(64 * 1024 - head.len())]);
                }
                size += length as u64;
                scan.summary.total_bytes += length as u64;
                scan.budget()?;
                hash.update(&buf[..length]);
            }
            let after = file.metadata()?;
            if before.len() != size
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
                || after.nlink() != 1
            {
                return Err(io::Error::other("file changed during indexing; refresh again").into());
            }
            let (category, detected_by) = classify(&path, &head);
            Ok(FileIndexRecord {
                file_id: None,
                path: path.clone(),
                original_path: pair.root.join(&path).to_string_lossy().into_owned(),
                name,
                sha256: format!("{:x}", hash.finalize()),
                category,
                detected_by: detected_by.into(),
                size,
                modified_ms: after
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .try_into()
                    .unwrap_or(u64::MAX),
                indexed_at_ms: scan.summary.indexed_at_ms,
            })
        })();
        vault.record_audit(
            "user",
            Op::Read,
            &path,
            result
                .as_ref()
                .map(|record: &FileIndexRecord| (Some(record.sha256.clone()), Some(record.size))),
        );
        let record = result?;
        *scan
            .summary
            .categories
            .entry(record.category.key().into())
            .or_default() += 1;
        scan.records.insert(path, record);
        scan.summary.total += 1;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn setup() -> (tempfile::TempDir, Vault) {
        let tmp = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(tmp.path()).unwrap();
        (tmp, vault)
    }
    fn put(tmp: &tempfile::TempDir, path: &str, bytes: &[u8]) {
        let path = tmp.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn query(vault: &Vault) -> FileIndexResult {
        vault
            .file_index_query("user", FileIndexFilter::default())
            .unwrap()
    }

    fn photo_tag(kind: PhotoTagKind, value: &str) -> PhotoTag {
        PhotoTag {
            kind,
            value: value.into(),
        }
    }

    #[test]
    fn photo_tags_are_searchable_persisted_and_not_shared_by_content() {
        let (tmp, vault) = setup();
        put(&tmp, "photos/a.png", b"\x89PNG\r\n\x1a\nphoto");
        put(&tmp, "photos/b.png", b"\x89PNG\r\n\x1a\nphoto");
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        let tags = vec![
            photo_tag(PhotoTagKind::Person, "小满"),
            photo_tag(PhotoTagKind::Event, "第一次看海"),
        ];
        vault
            .photo_tags_set("user", "photos/a.png", &sha, tags.clone())
            .unwrap();
        vault.file_index_refresh("user").unwrap();
        drop(vault);
        let vault = Vault::new();
        vault.set_root(tmp.path()).unwrap();
        let result = vault
            .photo_library_query(
                "user",
                PhotoLibraryFilter {
                    query: Some("小满".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].tags, tags);
        let copies = vault
            .photo_library_query(
                "user",
                PhotoLibraryFilter {
                    sha256: Some(sha),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(copies.total, 2);
        assert!(copies.items[1].tags.is_empty());
        assert_eq!(
            fs::read(tmp.path().join("photos/a.png")).unwrap(),
            b"\x89PNG\r\n\x1a\nphoto"
        );
    }

    #[test]
    fn photo_mutations_and_preview_require_current_source_content() {
        let (tmp, vault) = setup();
        put(&tmp, "a.png", b"\x89PNG\r\n\x1a\noriginal");
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        vault
            .photo_tags_set(
                "user",
                "a.png",
                &sha,
                vec![photo_tag(PhotoTagKind::Event, "生日")],
            )
            .unwrap();
        let preview = vault.photo_preview("user", "a.png", &sha).unwrap();
        assert_eq!(preview.mime, "image/png");
        assert_eq!(preview.sha256, sha);
        put(&tmp, "a.png", b"\x89PNG\r\n\x1a\nchanged");
        assert!(vault.photo_preview("user", "a.png", &sha).is_err());
        assert!(vault.photo_tags_set("user", "a.png", &sha, vec![]).is_err());
        vault.file_index_refresh("user").unwrap();
        assert!(vault
            .photo_library_query("user", PhotoLibraryFilter::default())
            .unwrap()
            .items[0]
            .tags
            .is_empty());
        assert!(vault
            .photo_library_query(
                "user",
                PhotoLibraryFilter {
                    query: Some("生日".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn photo_sources_reject_symlink_hardlink_escape_and_changed_parent() {
        let (tmp, vault) = setup();
        put(&tmp, "photos/a.png", b"\x89PNG\r\n\x1a\nsource");
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        for path in [
            "../a.png",
            "/a.png",
            "photos/../a.png",
            ".depdek-file-index/index.redb",
            "photos\\a.png",
        ] {
            assert!(vault.photo_preview("user", path, &sha).is_err());
            assert!(vault.photo_tags_set("user", path, &sha, vec![]).is_err());
        }
        fs::hard_link(tmp.path().join("photos/a.png"), tmp.path().join("hard.png")).unwrap();
        assert!(vault.photo_preview("user", "photos/a.png", &sha).is_err());
        fs::remove_file(tmp.path().join("hard.png")).unwrap();
        fs::rename(tmp.path().join("photos"), tmp.path().join("original")).unwrap();
        symlink(tmp.path().join("original"), tmp.path().join("photos")).unwrap();
        assert!(vault.photo_preview("user", "photos/a.png", &sha).is_err());
        assert!(vault
            .photo_tags_set("user", "photos/a.png", &sha, vec![])
            .is_err());
        assert!(vault
            .photo_library_query("agent-x", PhotoLibraryFilter::default())
            .is_err());
        assert!(vault
            .photo_preview("agent-x", "photos/a.png", &sha)
            .is_err());
    }

    #[test]
    fn photo_empty_queries_and_invalid_inputs_do_not_initialize_storage() {
        let (tmp, vault) = setup();
        assert_eq!(
            vault
                .photo_library_query("user", PhotoLibraryFilter::default())
                .unwrap()
                .total,
            0
        );
        assert!(!tmp.path().join(PRIVATE).exists());
        assert!(vault
            .photo_library_query(
                "user",
                PhotoLibraryFilter {
                    limit: Some(101),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(vault
            .photo_library_query(
                "user",
                PhotoLibraryFilter {
                    query: Some("x".repeat(257)),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(vault
            .photo_tags_set("user", "a.png", &"0".repeat(64), vec![])
            .is_err());
        assert!(!tmp.path().join(PRIVATE).exists());
    }

    #[test]
    fn photo_preview_and_tag_writes_reject_oversized_sources_before_loading() {
        let (tmp, vault) = setup();
        put(&tmp, "large.png", b"\x89PNG\r\n\x1a\n");
        fs::OpenOptions::new()
            .write(true)
            .open(tmp.path().join("large.png"))
            .unwrap()
            .set_len(MAX_PHOTO_BYTES + 1)
            .unwrap();
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        assert!(matches!(
            vault.photo_preview("user", "large.png", &sha),
            Err(VaultError::TooLarge)
        ));
        assert!(matches!(
            vault.photo_tags_set("user", "large.png", &sha, vec![]),
            Err(VaultError::TooLarge)
        ));
        assert!(vault
            .photo_tags_set("agent", "large.png", &sha, vec![])
            .is_err());
    }

    #[test]
    fn photo_labels_are_bounded_validate_dates_and_allow_correction() {
        let (tmp, vault) = setup();
        put(&tmp, "a.png", b"\x89PNG\r\n\x1a\nsource");
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        for tags in [
            vec![photo_tag(PhotoTagKind::Note, "bad\nvalue")],
            vec![photo_tag(PhotoTagKind::Person, &"人".repeat(121))],
            vec![photo_tag(PhotoTagKind::Selection, "delete")],
            vec![photo_tag(PhotoTagKind::CapturedDate, "2026-02-30")],
            vec![photo_tag(PhotoTagKind::Note, "ok"); 17],
        ] {
            assert!(vault.photo_tags_set("user", "a.png", &sha, tags).is_err());
        }
        let tags = vec![photo_tag(PhotoTagKind::CapturedDate, "2024-02-29")];
        assert_eq!(
            vault
                .photo_tags_set("user", "a.png", &sha, tags.clone())
                .unwrap()
                .tags,
            tags
        );
        assert!(vault
            .photo_tags_set("user", "a.png", &sha, vec![])
            .unwrap()
            .tags
            .is_empty());
        let (audit, _) = vault.inner.audit.read(0, 100);
        assert!(audit
            .iter()
            .any(|entry| entry.path == "photo-library/tags" && !entry.ok));
        assert!(audit
            .iter()
            .any(|entry| entry.path == "photo-library/tags" && entry.ok));
        assert!(!serde_json::to_string(&audit)
            .unwrap()
            .contains("2024-02-29"));
    }

    #[test]
    fn photo_preview_rejects_active_formats_and_isolates_home_and_login() {
        let (tmp, vault) = setup();
        put(&tmp, "active.svg", b"<svg onload='alert(1)'/>");
        vault.file_index_refresh("user").unwrap();
        let sha = query(&vault).items[0].sha256.clone();
        assert!(vault.photo_preview("user", "active.svg", &sha).is_err());
        vault
            .photo_tags_set(
                "user",
                "active.svg",
                &sha,
                vec![photo_tag(PhotoTagKind::Note, "private label")],
            )
            .unwrap();
        let next = tempfile::tempdir().unwrap();
        vault.set_root(next.path()).unwrap();
        assert!(vault
            .photo_library_query("user", PhotoLibraryFilter::default())
            .unwrap()
            .items
            .is_empty());
        let account = tempfile::tempdir().unwrap();
        vault
            .enable_ai_os_login(
                &fs::canonicalize(account.path())
                    .unwrap()
                    .join(".jiaho-onboarding"),
            )
            .unwrap();
        assert!(vault
            .photo_library_query("user", PhotoLibraryFilter::default())
            .is_err());
    }

    #[test]
    fn empty_query_does_not_create_db_and_scan_persists_across_restart() {
        let (tmp, vault) = setup();
        assert_eq!(query(&vault).summary.total, 0);
        assert!(!tmp.path().join(PRIVATE).exists());
        put(&tmp, "资料/家庭记录.TXT", b"hello");
        let summary = vault.file_index_refresh("user").unwrap();
        assert_eq!(summary.total, 1);
        assert_eq!(summary.categories["documents"], 1);
        drop(vault);
        let vault = Vault::new();
        vault.set_root(tmp.path()).unwrap();
        let result = query(&vault);
        let item = &result.items[0];
        assert_eq!(item.path, "资料/家庭记录.TXT");
        assert_eq!(
            item.original_path,
            fs::canonicalize(tmp.path())
                .unwrap()
                .join(&item.path)
                .to_string_lossy()
        );
        assert_eq!(item.sha256, sha256_hex(b"hello"));
        assert_eq!(item.size, 5);
        assert!(item.indexed_at_ms > 0);
        assert!(item.modified_ms > 0);
    }
    #[test]
    fn classification_checks_signatures_before_extensions_and_all_five_buckets() {
        for (path, data, category, method) in [
            ("photo.bin", b"\x89PNG\r\n\x1a\n".as_slice(), FileCategory::Photos, "signature"),
            ("wrong.jpg", b"%PDF-1.7".as_slice(), FileCategory::Documents, "signature"),
            ("a.avif", b"\0\0\0\x18ftypavif".as_slice(), FileCategory::Photos, "signature"),
            ("a.bin", b"\0\0\0\x18ftypisom".as_slice(), FileCategory::Videos, "signature"),
            ("clip.MKV", b"sample".as_slice(), FileCategory::Videos, "extension"),
            ("mail/a/1.md", b"From: a\nSubject: test\n<!-- depdek:mail-text -->".as_slice(), FileCategory::Mail, "depdek_mail"),
            ("mail/a/2.md", b"# subject\n\n- **From:** a\n- **To:** b\n- **Date:** 2026-10-18\n- **UID:** 12\n- **Body format:** empty\n---\n(no body)".as_slice(), FileCategory::Mail, "depdek_mail"),
            ("mail/a/attachments/a.md", b"sample".as_slice(), FileCategory::Documents, "extension"),
            ("mail/a/note.md", b"ordinary note".as_slice(), FileCategory::Documents, "extension"),
            ("letter.EML", b"mail".as_slice(), FileCategory::Mail, "extension"),
            ("music.mp3", b"ID3".as_slice(), FileCategory::Other, "fallback"),
        ] { assert_eq!(classify(path, data), (category, method), "{path}"); }
    }
    #[test]
    fn duplicate_content_keeps_distinct_paths_and_indexed_sha_queries_intersect_categories() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"same");
        put(&tmp, "b.eml", b"same");
        vault.file_index_refresh("user").unwrap();
        let sha = sha256_hex(b"same");
        let filter = FileIndexFilter {
            sha256: Some(sha.to_uppercase()),
            ..Default::default()
        };
        assert_eq!(
            vault
                .file_index_query("user", filter.clone())
                .unwrap()
                .total,
            2
        );
        assert_eq!(
            vault
                .file_index_query(
                    "user",
                    FileIndexFilter {
                        category: Some(FileCategory::Mail),
                        ..filter
                    }
                )
                .unwrap()
                .items[0]
                .path,
            "b.eml"
        );
        assert_eq!(
            vault
                .file_index_query(
                    "user",
                    FileIndexFilter {
                        query: Some(sha[..10].into()),
                        ..Default::default()
                    }
                )
                .unwrap()
                .total,
            2
        );
        assert!(tmp.path().join("a.txt").exists() && tmp.path().join("b.eml").exists());
    }
    #[test]
    fn refresh_updates_hash_removes_deleted_and_replaces_secondary_indices() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"before");
        put(&tmp, "b.txt", b"remove");
        vault.file_index_refresh("user").unwrap();
        let original = query(&vault).items[0].original_path.clone();
        put(&tmp, "a.txt", b"after");
        fs::remove_file(tmp.path().join("b.txt")).unwrap();
        vault.file_index_refresh("user").unwrap();
        assert_eq!(query(&vault).total, 1);
        assert_eq!(query(&vault).items[0].original_path, original);
        assert_eq!(query(&vault).items[0].sha256, sha256_hex(b"after"));
        assert_eq!(
            vault
                .file_index_query(
                    "user",
                    FileIndexFilter {
                        sha256: Some(sha256_hex(b"before")),
                        ..Default::default()
                    }
                )
                .unwrap()
                .total,
            0
        );
    }
    #[test]
    fn query_filters_pagination_and_validation() {
        let (tmp, vault) = setup();
        for path in ["docs/A.txt", "docs/B.txt", "docs2/C.txt"] {
            put(&tmp, path, b"text");
        }
        vault.file_index_refresh("user").unwrap();
        let result = vault
            .file_index_query(
                "user",
                FileIndexFilter {
                    path_prefix: Some("docs".into()),
                    offset: Some(1),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items[0].path, "docs/B.txt");
        assert_eq!(
            vault
                .file_index_query(
                    "user",
                    FileIndexFilter {
                        query: Some("a.TXT".into()),
                        ..Default::default()
                    }
                )
                .unwrap()
                .total,
            1
        );
        for input in [
            r#"{"limit":201}"#,
            r#"{"limit":0}"#,
            r#"{"sha256":"bad"}"#,
            r#"{"path_prefix":"../escape"}"#,
            r#"{"path_prefix":"/root"}"#,
        ] {
            let filter = serde_json::from_str(input).unwrap();
            assert!(vault.file_index_query("user", filter).is_err());
        }
        assert!(serde_json::from_str::<FileIndexFilter>(r#"{"category":"secret"}"#).is_err());
    }
    #[test]
    fn credentials_hidden_aliases_hardlinks_and_external_symlinks_are_not_indexed() {
        let (tmp, vault) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "sensitive").unwrap();
        for path in [
            "mail/accounts.json",
            "mail/index.json",
            "secrets/key.txt",
            "settings/settings.json",
            "agent/wukong/conversations.json",
            "mydata/memory/events.jsonl",
            ".hidden/private.txt",
            "private.env",
            "cache.sqlite",
        ] {
            put(&tmp, path, b"sensitive");
        }
        put(&tmp, "docs/normal.txt", b"public");
        put(&tmp, "mail/home/letter.eml", b"mail");
        symlink(outside.path(), tmp.path().join("external")).unwrap();
        symlink(tmp.path().join("secrets"), tmp.path().join("alias")).unwrap();
        fs::hard_link(
            outside.path().join("secret.txt"),
            tmp.path().join("hard.txt"),
        )
        .unwrap();
        vault.file_index_refresh("user").unwrap();
        let result = query(&vault);
        assert_eq!(result.total, 2);
        assert!(result
            .items
            .iter()
            .all(|v| !v.original_path.contains("secret")));
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "sensitive"
        );
    }
    #[test]
    fn private_db_is_unreachable_even_through_alias_and_never_archived() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"a");
        vault.file_index_refresh("user").unwrap();
        symlink(tmp.path().join(PRIVATE), tmp.path().join("alias")).unwrap();
        for session in ["user", "agent-1"] {
            for path in [".depdek-file-index/index.redb", "alias/index.redb"] {
                assert!(vault.read_file(session, path).is_err());
                assert!(vault.read_binary(session, path).is_err());
                assert!(vault.write_file(session, path, "overwrite").is_err());
                assert!(vault.delete_file(session, path).is_err());
                assert!(vault.stat(session, path).is_err());
            }
            assert!(!vault
                .list_dir(session, ".")
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == PRIVATE));
        }
        put(&tmp, "pack/.depdek-file-index/secret.redb", b"private");
        put(&tmp, "pack/public.txt", b"public");
        vault
            .compress("user", "pack", Some("archive.tar.gz"))
            .unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(
            fs::File::open(tmp.path().join("archive.tar.gz")).unwrap(),
        ));
        assert!(archive.entries().unwrap().all(|entry| !entry
            .unwrap()
            .path()
            .unwrap()
            .to_string_lossy()
            .contains(PRIVATE)));
        assert!(vault.set_root(&tmp.path().join(PRIVATE)).is_err());
    }
    #[test]
    fn unsafe_db_permissions_links_corruption_and_locks_fail_without_reset() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"a");
        vault.file_index_refresh("user").unwrap();
        let dbpath = tmp.path().join(PRIVATE).join("index.redb");
        fs::set_permissions(&dbpath, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(query_result(&vault).is_err());
        fs::set_permissions(&dbpath, fs::Permissions::from_mode(0o600)).unwrap();
        let db = open_index(&vault.root_pair().unwrap(), false)
            .unwrap()
            .unwrap();
        assert!(vault.file_index_refresh("user").is_err());
        drop(db);
        assert_eq!(query(&vault).total, 1);
        let saved = fs::read(&dbpath).unwrap();
        fs::write(&dbpath, b"not a redb database").unwrap();
        assert!(vault.file_index_refresh("user").is_err());
        assert_eq!(fs::read(&dbpath).unwrap(), b"not a redb database");
        fs::write(&dbpath, saved).unwrap();
        fs::rename(&dbpath, tmp.path().join("saved.redb")).unwrap();
        symlink(tmp.path().join("saved.redb"), &dbpath).unwrap();
        assert!(vault.file_index_refresh("user").is_err());
    }
    fn query_result(vault: &Vault) -> Result<FileIndexResult, VaultError> {
        vault.file_index_query("user", FileIndexFilter::default())
    }
    #[test]
    fn failed_scan_preserves_previous_complete_snapshot() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"before");
        vault.file_index_refresh("user").unwrap();
        let stamp = query(&vault).summary.indexed_at_ms;
        put(&tmp, "a.txt", b"after");
        let mut deep = tmp.path().join("deep");
        for _ in 0..66 {
            deep.push("d");
        }
        fs::create_dir_all(deep).unwrap();
        assert!(vault.file_index_refresh("user").is_err());
        let result = query(&vault);
        assert_eq!(result.summary.indexed_at_ms, stamp);
        assert_eq!(result.items[0].sha256, sha256_hex(b"before"));
    }
    #[test]
    fn agents_cannot_query_refresh_or_discover_index_and_failures_are_audited() {
        let (tmp, vault) = setup();
        assert!(vault.file_index_refresh("agent-x").is_err());
        assert!(vault
            .file_index_query("agent-x", FileIndexFilter::default())
            .is_err());
        let entries: Vec<AuditEntry> = fs::read_to_string(tmp.path().join(AUDIT_FILE_NAME))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(entries
            .iter()
            .filter(|entry| entry.path.starts_with("file-index/"))
            .all(|entry| !entry.ok));
        assert_eq!(entries.len(), 2);
    }
    #[test]
    fn root_change_uses_its_own_index_and_scan_budget_is_bounded() {
        let (tmp, vault) = setup();
        put(&tmp, "a.txt", b"a");
        vault.file_index_refresh("user").unwrap();
        let second = tempfile::tempdir().unwrap();
        vault.set_root(second.path()).unwrap();
        assert_eq!(query(&vault).total, 0);
        let scan = Scan {
            records: BTreeMap::new(),
            summary: FileIndexSummary {
                total_bytes: MAX_BYTES + 1,
                ..Default::default()
            },
            started: Instant::now(),
            seen: 0,
        };
        assert!(matches!(scan.budget(), Err(VaultError::TooLarge)));
        assert_eq!(fs::read(tmp.path().join("a.txt")).unwrap(), b"a");
    }
    #[test]
    fn ai_os_login_is_required_before_any_index_read() {
        let (_tmp, vault) = setup();
        let account = tempfile::tempdir().unwrap();
        vault
            .enable_ai_os_login(
                &fs::canonicalize(account.path())
                    .unwrap()
                    .join(".jiaho-onboarding"),
            )
            .unwrap();
        assert!(matches!(
            vault.file_index_query("user", FileIndexFilter::default()),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.file_index_refresh("user"),
            Err(VaultError::AuthRequired)
        ));
    }
}
