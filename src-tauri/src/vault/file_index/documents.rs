//! User-only document references, bounded reads and reversible collections.
use super::*;
use redb::ReadableTableMetadata;
use serde::de::DeserializeOwned;
use std::collections::BTreeSet;

const FAVORITES: TableDefinition<&str, &str> = TableDefinition::new("document_favorites_v1");
const COLLECTIONS: TableDefinition<&str, &str> = TableDefinition::new("document_collections_v1");
const DOC_BYTES: u64 = 16 * 1024 * 1024;
const BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const TEXT_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DocumentReference {
    pub path: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReadInput {
    pub library_id: String,
    pub reference: DocumentReference,
}
#[derive(Debug, Serialize)]
pub struct DocumentPreview {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    pub size: u64,
    pub sha256: String,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentFavorite {
    pub path: String,
    pub sha256: String,
    pub favorite: bool,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentFavoriteInput {
    pub library_id: String,
    pub reference: DocumentReference,
    pub favorite: bool,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentCollectionKind {
    Organization,
    Packet,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentCollectionStatus {
    Active,
    Reverted,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentCollection {
    pub id: String,
    pub kind: DocumentCollectionKind,
    pub status: DocumentCollectionStatus,
    pub title: String,
    pub references: Vec<DocumentReference>,
    pub missing: Vec<String>,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCollectionInput {
    pub library_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub kind: DocumentCollectionKind,
    pub status: DocumentCollectionStatus,
    pub title: String,
    pub references: Vec<DocumentReference>,
    pub missing: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct DocumentLibraryState {
    pub library_id: String,
    pub favorites: Vec<DocumentFavorite>,
    pub collections: Vec<DocumentCollection>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentBundleInput {
    pub library_id: String,
    pub title: String,
    pub references: Vec<DocumentReference>,
    pub missing: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSearchInput {
    pub library_id: String,
    pub query: String,
}
#[derive(Debug, Serialize)]
pub struct DocumentMatch {
    pub file: FileIndexRecord,
    pub snippet: Option<String>,
    pub line: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct DocumentSearchResult {
    pub items: Vec<DocumentMatch>,
    pub catalog_total: usize,
    pub body_examined: usize,
    pub skipped: usize,
    pub incomplete: bool,
}

fn invalid(message: &str) -> VaultError {
    VaultError::InvalidParams(message.into())
}
fn text_valid(text: &str, maximum: usize) -> bool {
    !text.is_empty()
        && text.trim() == text
        && text.chars().count() <= maximum
        && !text.chars().any(char::is_control)
}
fn valid_reference(reference: &DocumentReference) -> Result<(), VaultError> {
    photo_path(&reference.path, &reference.sha256)?;
    if reference.path.chars().any(char::is_control)
        || reference
            .group
            .as_ref()
            .is_some_and(|group| !text_valid(group, 120))
    {
        return Err(invalid("invalid document reference"));
    }
    Ok(())
}
fn validate_collection(
    title: &str,
    references: &[DocumentReference],
    missing: &[String],
) -> Result<(), VaultError> {
    if !text_valid(title, 120)
        || references.is_empty()
        || references.len() > 50
        || missing.len() > 30
        || missing.iter().any(|text| !text_valid(text, 120))
    {
        return Err(invalid("invalid document collection or limits"));
    }
    let mut paths = BTreeSet::new();
    for reference in references {
        valid_reference(reference)?;
        if !paths.insert(&reference.path) {
            return Err(invalid("duplicate document reference"));
        }
    }
    Ok(())
}
fn current_library(vault: &Vault, library_id: &str) -> Result<RootPair, VaultError> {
    let pair = vault.root_pair()?;
    if library_id != library_identity(&pair) {
        return Err(invalid("Home changed; document belongs to another library"));
    }
    Ok(pair)
}
fn indexed_document(
    db: &Database,
    reference: &DocumentReference,
) -> Result<FileIndexRecord, VaultError> {
    valid_reference(reference)?;
    let txn = db.begin_read().map_err(db_error)?;
    let table = txn.open_table(FILES).map_err(db_error)?;
    let value = table
        .get(reference.path.as_str())
        .map_err(db_error)?
        .ok_or_else(|| invalid("document is not indexed"))?;
    let file: FileIndexRecord = serde_json::from_str(value.value()).map_err(json_error)?;
    if file.category != FileCategory::Documents
        || file.path != reference.path
        || !file.sha256.eq_ignore_ascii_case(&reference.sha256)
    {
        return Err(invalid("document changed; update the index"));
    }
    Ok(file)
}
fn rows<T: DeserializeOwned>(
    db: &Database,
    definition: TableDefinition<&str, &str>,
) -> Result<Vec<T>, VaultError> {
    let txn = db.begin_read().map_err(db_error)?;
    let table = match txn.open_table(definition) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(vec![]),
        Err(error) => return Err(db_error(error)),
    };
    let mut result = Vec::new();
    for row in table.iter().map_err(db_error)? {
        if result.len() >= 200 {
            return Err(VaultError::TooLarge);
        }
        let (_, value) = row.map_err(db_error)?;
        result.push(serde_json::from_str(value.value()).map_err(json_error)?);
    }
    Ok(result)
}
fn text_document(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "txt" | "md" | "mdx" | "csv" | "json" | "yaml" | "yml" | "html" | "htm"
    )
}
fn checked_bytes(
    vault: &Vault,
    pair: &RootPair,
    reference: &DocumentReference,
    maximum: u64,
) -> Result<Vec<u8>, VaultError> {
    let result = indexed_source_bytes(pair, &reference.path, &reference.sha256, maximum);
    vault.record_audit(
        "user",
        Op::Read,
        "document-library/source",
        result
            .as_ref()
            .map(|bytes| (Some(sha256_hex(bytes)), Some(bytes.len() as u64))),
    );
    result
}
fn check_sources(
    vault: &Vault,
    pair: &RootPair,
    db: &Database,
    references: &[DocumentReference],
) -> Result<(), VaultError> {
    let mut size = 0;
    for reference in references {
        let file = indexed_document(db, reference)?;
        if file.size > DOC_BYTES || size + file.size > BUNDLE_BYTES {
            return Err(VaultError::TooLarge);
        }
        let bytes = checked_bytes(vault, pair, reference, DOC_BYTES.min(BUNDLE_BYTES - size))?;
        size += bytes.len() as u64;
    }
    Ok(())
}

impl Vault {
    pub fn document_library_state(
        &self,
        session: &str,
    ) -> Result<DocumentLibraryState, VaultError> {
        self.file_index_audited(session, Op::Read, "document-library/state", || {
            let pair = self.root_pair()?;
            let (favorites, collections) = match open_index(&pair, false)? {
                Some(db) => (rows(&db, FAVORITES)?, rows(&db, COLLECTIONS)?),
                None => (vec![], vec![]),
            };
            Ok(DocumentLibraryState {
                library_id: library_identity(&pair),
                favorites,
                collections,
            })
        })
    }

    pub fn document_preview(
        &self,
        session: &str,
        input: DocumentReadInput,
    ) -> Result<DocumentPreview, VaultError> {
        self.file_index_audited(session, Op::Read, "document-library/preview", || {
            let pair = current_library(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("document index is not ready"))?;
            let file = indexed_document(&db, &input.reference)?;
            let bytes = checked_bytes(self, &pair, &input.reference, DOC_BYTES)?;
            let mut result = DocumentPreview {
                kind: "unsupported",
                content: None,
                data_base64: None,
                size: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
                truncated: false,
            };
            if bytes.starts_with(b"%PDF-") {
                result.kind = "pdf";
                result.data_base64 = Some(BASE64.encode(&bytes));
            } else if text_document(&file.path) {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| VaultError::NotUtf8("document".into()))?;
                let mut end = text.len().min(TEXT_BYTES);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                result.kind = "text";
                result.truncated = end < text.len();
                result.content = Some(text[..end].into());
            }
            Ok(result)
        })
    }

    pub fn document_favorite_set(
        &self,
        session: &str,
        input: DocumentFavoriteInput,
    ) -> Result<DocumentFavorite, VaultError> {
        self.file_index_audited(session, Op::Write, "document-library/favorite", || {
            let pair = current_library(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("document index is not ready"))?;
            valid_reference(&input.reference)?;
            if input.favorite {
                check_sources(self, &pair, &db, std::slice::from_ref(&input.reference))?;
            }
            let write = db.begin_write().map_err(db_error)?;
            let record;
            {
                let mut table = write.open_table(FAVORITES).map_err(db_error)?;
                let previous: Option<DocumentFavorite> = table
                    .get(input.reference.path.as_str())
                    .map_err(db_error)?
                    .map(|v| serde_json::from_str(v.value()).map_err(json_error))
                    .transpose()?;
                if previous.as_ref().map_or(0, |item| item.revision) != input.expected_revision {
                    return Err(invalid("document revision conflict; reload first"));
                }
                if !input.favorite
                    && !previous.as_ref().is_some_and(|item| {
                        item.sha256.eq_ignore_ascii_case(&input.reference.sha256)
                    })
                {
                    return Err(invalid("only an existing document favorite can be removed"));
                }
                if previous.is_none() && table.len().map_err(db_error)? >= 200 {
                    return Err(VaultError::TooLarge);
                }
                record = DocumentFavorite {
                    path: input.reference.path,
                    sha256: input.reference.sha256.to_ascii_lowercase(),
                    favorite: input.favorite,
                    revision: input
                        .expected_revision
                        .checked_add(1)
                        .ok_or(VaultError::TooLarge)?,
                    updated_at_ms: now_ms(),
                };
                table
                    .insert(
                        record.path.as_str(),
                        serde_json::to_string(&record).map_err(json_error)?.as_str(),
                    )
                    .map_err(db_error)?;
            }
            self.require_ai_os_login()?;
            write.commit().map_err(db_error)?;
            Ok(record)
        })
    }

    pub fn document_collection_put(
        &self,
        session: &str,
        input: DocumentCollectionInput,
    ) -> Result<DocumentCollection, VaultError> {
        self.file_index_audited(session, Op::Write, "document-library/collection", || {
            if input.id.len() != 32
                || !input
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid("invalid document collection id"));
            }
            validate_collection(&input.title, &input.references, &input.missing)?;
            let pair = current_library(self, &input.library_id)?;
            let db =
                open_index(&pair, false)?.ok_or_else(|| invalid("document index is not ready"))?;
            if input.status == DocumentCollectionStatus::Active {
                check_sources(self, &pair, &db, &input.references)?;
            }
            let write = db.begin_write().map_err(db_error)?;
            let record;
            {
                let mut table = write.open_table(COLLECTIONS).map_err(db_error)?;
                let previous: Option<DocumentCollection> = table
                    .get(input.id.as_str())
                    .map_err(db_error)?
                    .map(|v| serde_json::from_str(v.value()).map_err(json_error))
                    .transpose()?;
                if previous.as_ref().map_or(0, |item| item.revision) != input.expected_revision {
                    return Err(invalid("document revision conflict; reload first"));
                }
                if input.status == DocumentCollectionStatus::Reverted
                    && !previous.as_ref().is_some_and(|old| {
                        old.title == input.title
                            && old.kind == input.kind
                            && old.references == input.references
                            && old.missing == input.missing
                    })
                {
                    return Err(invalid(
                        "revert must preserve the original document references",
                    ));
                }
                if previous.is_none() && table.len().map_err(db_error)? >= 200 {
                    return Err(VaultError::TooLarge);
                }
                record = DocumentCollection {
                    id: input.id,
                    kind: input.kind,
                    status: input.status,
                    title: input.title,
                    references: input.references,
                    missing: input.missing,
                    revision: input
                        .expected_revision
                        .checked_add(1)
                        .ok_or(VaultError::TooLarge)?,
                    updated_at_ms: now_ms(),
                };
                table
                    .insert(
                        record.id.as_str(),
                        serde_json::to_string(&record).map_err(json_error)?.as_str(),
                    )
                    .map_err(db_error)?;
            }
            self.require_ai_os_login()?;
            write.commit().map_err(db_error)?;
            Ok(record)
        })
    }

    pub fn document_search(
        &self,
        session: &str,
        input: DocumentSearchInput,
    ) -> Result<DocumentSearchResult, VaultError> {
        self.file_index_audited(session, Op::Search, "document-library/search", || {
            if !text_valid(&input.query, 120) {
                return Err(invalid("invalid document query"));
            }
            let pair = current_library(self, &input.library_id)?;
            let Some(db) = open_index(&pair, false)? else {
                return Ok(DocumentSearchResult {
                    items: vec![],
                    catalog_total: 0,
                    body_examined: 0,
                    skipped: 0,
                    incomplete: false,
                });
            };
            let txn = db.begin_read().map_err(db_error)?;
            let files = txn.open_table(FILES).map_err(db_error)?;
            let mut result = DocumentSearchResult {
                items: vec![],
                catalog_total: 0,
                body_examined: 0,
                skipped: 0,
                incomplete: false,
            };
            let needle = input.query.to_lowercase();
            let annotated = super::content::search_matches(&db, &needle)?;
            let mut related = BTreeSet::new();
            for collection in rows::<DocumentCollection>(&db, COLLECTIONS)? {
                if collection.status != DocumentCollectionStatus::Active {
                    continue;
                }
                for reference in collection.references {
                    if collection.title.to_lowercase().contains(&needle)
                        || reference
                            .group
                            .as_ref()
                            .is_some_and(|group| group.to_lowercase().contains(&needle))
                    {
                        related.insert((reference.path, reference.sha256.to_lowercase()));
                    }
                }
            }
            let mut bytes_read = 0;
            for row in files.iter().map_err(db_error)? {
                let (_, value) = row.map_err(db_error)?;
                let file: FileIndexRecord =
                    serde_json::from_str(value.value()).map_err(json_error)?;
                if file.category != FileCategory::Documents || excluded(&file.path) {
                    continue;
                }
                result.catalog_total += 1;
                if file.path.to_lowercase().contains(&needle)
                    || file.name.to_lowercase().contains(&needle)
                    || related.contains(&(file.path.clone(), file.sha256.to_lowercase()))
                    || annotated.contains(&(file.path.clone(), file.sha256.to_lowercase()))
                {
                    if result.items.len() < 100 {
                        result.items.push(DocumentMatch {
                            file,
                            snippet: None,
                            line: None,
                        });
                    } else {
                        result.incomplete = true;
                    }
                    continue;
                }
                if !text_document(&file.path)
                    || file.size > 512 * 1024
                    || result.body_examined >= 20
                    || bytes_read + file.size > 4 * 1024 * 1024
                {
                    result.skipped += 1;
                    result.incomplete = true;
                    continue;
                }
                self.require_ai_os_login()?;
                result.body_examined += 1;
                let reference = DocumentReference {
                    path: file.path.clone(),
                    sha256: file.sha256.clone(),
                    group: None,
                };
                valid_reference(&reference)?;
                let read_limit = (512 * 1024).min(4 * 1024 * 1024 - bytes_read);
                match checked_bytes(self, &pair, &reference, read_limit) {
                    Ok(bytes) => {
                        bytes_read += bytes.len() as u64;
                        match std::str::from_utf8(&bytes) {
                            Ok(text) => {
                                if let Some((line, text)) = text
                                    .lines()
                                    .enumerate()
                                    .find(|(_, line)| line.to_lowercase().contains(&needle))
                                {
                                    if result.items.len() < 100 {
                                        result.items.push(DocumentMatch {
                                            file,
                                            snippet: Some(text.chars().take(400).collect()),
                                            line: Some(line + 1),
                                        });
                                    } else {
                                        result.incomplete = true;
                                    }
                                }
                            }
                            Err(_) => {
                                result.skipped += 1;
                                result.incomplete = true;
                            }
                        }
                    }
                    Err(_) => {
                        bytes_read += read_limit;
                        result.skipped += 1;
                        result.incomplete = true;
                    }
                }
            }
            Ok(result)
        })
    }

    pub fn document_bundle_export(
        &self,
        session: &str,
        input: DocumentBundleInput,
    ) -> Result<ReadBinaryResult, VaultError> {
        self.file_index_audited(session, Op::Read, "document-library/export", || {
            validate_collection(&input.title, &input.references, &input.missing)?;
            let pair = current_library(self, &input.library_id)?;
            let db = open_index(&pair, false)?.ok_or_else(|| invalid("document index is not ready"))?;
            let mut archive = TarBuilder::new(GzEncoder::new(Vec::new(), Compression::default()));
            let mut total = 0;
            let mut members = Vec::new();
            for (index, reference) in input.references.iter().enumerate() {
                self.require_ai_os_login()?;
                let file = indexed_document(&db, reference)?;
                if file.size > DOC_BYTES || total + file.size > BUNDLE_BYTES { return Err(VaultError::TooLarge); }
                let bytes = checked_bytes(self, &pair, reference, DOC_BYTES.min(BUNDLE_BYTES - total))?;
                total += bytes.len() as u64;
                let name = reference.path.rsplit('/').next().unwrap_or("document").replace([':', '<', '>', '|', '?', '*'], "_");
                let member = format!("{:02}-{name}", index + 1);
                let mut header = tar::Header::new_gnu(); header.set_size(bytes.len() as u64); header.set_mode(0o600); header.set_cksum();
                archive.append_data(&mut header, &member, bytes.as_slice())?;
                members.push(serde_json::json!({ "path": reference.path, "sha256": reference.sha256, "member": member }));
            }
            let manifest = serde_json::to_vec_pretty(&serde_json::json!({ "schema": "jiaho.document-bundle.v1", "title": input.title, "references": members, "missing": input.missing, "created_at_ms": now_ms() })).map_err(json_error)?;
            let mut header = tar::Header::new_gnu(); header.set_size(manifest.len() as u64); header.set_mode(0o600); header.set_cksum();
            archive.append_data(&mut header, "manifest.json", manifest.as_slice())?;
            let bytes = archive.into_inner()?.finish()?;
            if bytes.len() as u64 > BUNDLE_BYTES + 1024 * 1024 { return Err(VaultError::TooLarge); }
            Ok(ReadBinaryResult { size: bytes.len() as u64, sha256: sha256_hex(&bytes), data_base64: BASE64.encode(&bytes), mime: "application/gzip".into() })
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup() -> (tempfile::TempDir, Vault, String, DocumentReference) {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("docs")).unwrap();
        fs::write(
            tmp.path().join("docs/manual.txt"),
            "设备说明\n滤网用清水清洗\nEND-PRIVATE-CONTENT",
        )
        .unwrap();
        let vault = Vault::new();
        vault.set_root(tmp.path()).unwrap();
        vault.file_index_refresh("user").unwrap();
        let library = vault.document_library_state("user").unwrap().library_id;
        let file = vault
            .file_index_query(
                "user",
                FileIndexFilter {
                    category: Some(FileCategory::Documents),
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .remove(0);
        (
            tmp,
            vault,
            library,
            DocumentReference {
                path: file.path,
                sha256: file.sha256,
                group: None,
            },
        )
    }
    fn favorite(
        library: &str,
        reference: &DocumentReference,
        revision: u64,
    ) -> DocumentFavoriteInput {
        DocumentFavoriteInput {
            library_id: library.into(),
            reference: reference.clone(),
            favorite: true,
            expected_revision: revision,
        }
    }
    fn collection(
        library: &str,
        reference: &DocumentReference,
        revision: u64,
    ) -> DocumentCollectionInput {
        DocumentCollectionInput {
            library_id: library.into(),
            id: "a".repeat(32),
            expected_revision: revision,
            kind: DocumentCollectionKind::Organization,
            status: DocumentCollectionStatus::Active,
            title: "PRIVATE-GROUP-TITLE".into(),
            references: vec![reference.clone()],
            missing: vec!["PRIVATE-MISSING-ITEM".into()],
        }
    }
    fn read(library: &str, reference: &DocumentReference) -> DocumentReadInput {
        DocumentReadInput {
            library_id: library.into(),
            reference: reference.clone(),
        }
    }

    #[test]
    fn document_preview_search_and_private_metadata_survive_reopen_and_refresh() {
        let (tmp, vault, library, reference) = setup();
        let preview = vault
            .document_preview("user", read(&library, &reference))
            .unwrap();
        assert_eq!(preview.kind, "text");
        assert!(preview.content.unwrap().contains("滤网"));
        let found = vault
            .document_search(
                "user",
                DocumentSearchInput {
                    library_id: library.clone(),
                    query: "滤网".into(),
                },
            )
            .unwrap();
        assert_eq!(found.items[0].line, Some(2));
        assert_eq!(found.body_examined, 1);
        vault
            .document_favorite_set("user", favorite(&library, &reference, 0))
            .unwrap();
        vault
            .document_collection_put("user", collection(&library, &reference, 0))
            .unwrap();
        vault.file_index_refresh("user").unwrap();
        let other = Vault::new();
        other.set_root(tmp.path()).unwrap();
        let state = other.document_library_state("user").unwrap();
        assert_eq!(state.favorites.len(), 1);
        assert!(state.favorites[0].favorite);
        assert_eq!(state.collections.len(), 1);
        assert_eq!(state.collections[0].references[0], reference);
        let related = other
            .document_search(
                "user",
                DocumentSearchInput {
                    library_id: library,
                    query: "PRIVATE-GROUP-TITLE".into(),
                },
            )
            .unwrap();
        assert_eq!(related.items.len(), 1);
        assert_eq!(related.body_examined, 0);
        let audit = fs::read_to_string(tmp.path().join(AUDIT_FILE_NAME)).unwrap();
        for private in [
            "END-PRIVATE-CONTENT",
            "PRIVATE-GROUP-TITLE",
            "PRIVATE-MISSING-ITEM",
            "滤网",
        ] {
            assert!(!audit.contains(private), "audit leaked {private}");
        }
    }

    #[test]
    fn document_revision_conflicts_do_not_overwrite_and_revert_keeps_originals() {
        let (tmp, vault, library, reference) = setup();
        vault
            .document_favorite_set("user", favorite(&library, &reference, 0))
            .unwrap();
        assert!(vault
            .document_favorite_set("user", favorite(&library, &reference, 0))
            .is_err());
        vault
            .document_collection_put("user", collection(&library, &reference, 0))
            .unwrap();
        assert!(vault
            .document_collection_put("user", collection(&library, &reference, 0))
            .is_err());
        fs::write(tmp.path().join(&reference.path), "modified after save").unwrap();
        let mut remove = favorite(&library, &reference, 1);
        remove.favorite = false;
        assert!(
            !vault
                .document_favorite_set("user", remove)
                .unwrap()
                .favorite
        );
        let mut revert = collection(&library, &reference, 1);
        revert.status = DocumentCollectionStatus::Reverted;
        let reverted = vault.document_collection_put("user", revert).unwrap();
        assert_eq!(reverted.revision, 2);
        assert_eq!(reverted.status, DocumentCollectionStatus::Reverted);
        assert_eq!(
            fs::read_to_string(tmp.path().join(&reference.path)).unwrap(),
            "modified after save"
        );
        let mut forged = collection(&library, &reference, 2);
        forged.status = DocumentCollectionStatus::Reverted;
        forged.title = "changed title".into();
        assert!(vault.document_collection_put("user", forged).is_err());
        assert_eq!(
            vault.document_library_state("user").unwrap().collections[0].title,
            "PRIVATE-GROUP-TITLE"
        );
    }

    #[test]
    fn document_references_reject_stale_bytes_unknown_files_and_unsafe_links() {
        let (tmp, vault, library, reference) = setup();
        fs::write(tmp.path().join(&reference.path), "changed").unwrap();
        assert!(vault
            .document_preview("user", read(&library, &reference))
            .is_err());
        assert!(vault
            .document_favorite_set("user", favorite(&library, &reference, 0))
            .is_err());
        assert!(vault
            .document_collection_put("user", collection(&library, &reference, 0))
            .is_err());
        assert!(vault
            .document_library_state("user")
            .unwrap()
            .collections
            .is_empty());
        for path in [
            "../outside.txt",
            "/etc/passwd",
            "docs/../manual.txt",
            "tasks/history.json",
            "secrets/master.key",
            ".depdek-file-index/index.redb",
            "docs\\manual.txt",
            "docs/unindexed.txt",
        ] {
            let reference = DocumentReference {
                path: path.into(),
                sha256: "a".repeat(64),
                group: None,
            };
            assert!(
                vault
                    .document_preview("user", read(&library, &reference))
                    .is_err(),
                "accepted {path}"
            );
        }
        for hard in [false, true] {
            let (tmp, vault, library, reference) = setup();
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("outside.txt"), "same-content").unwrap();
            fs::remove_file(tmp.path().join(&reference.path)).unwrap();
            if hard {
                fs::hard_link(
                    outside.path().join("outside.txt"),
                    tmp.path().join(&reference.path),
                )
                .unwrap();
            } else {
                symlink(
                    outside.path().join("outside.txt"),
                    tmp.path().join(&reference.path),
                )
                .unwrap();
            }
            assert!(vault
                .document_preview("user", read(&library, &reference))
                .is_err());
        }
    }

    #[test]
    fn document_archive_contains_exact_selected_originals_and_provenance_without_home_writes() {
        let (tmp, vault, library, reference) = setup();
        let output = vault
            .document_bundle_export(
                "user",
                DocumentBundleInput {
                    library_id: library.clone(),
                    title: "旅行资料".into(),
                    references: vec![reference.clone()],
                    missing: vec!["入场说明".into()],
                },
            )
            .unwrap();
        let bytes = BASE64.decode(&output.data_base64).unwrap();
        assert_eq!(sha256_hex(&bytes), output.sha256);
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
        let mut contents = BTreeMap::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().to_string();
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            contents.insert(path, text);
        }
        assert_eq!(contents.len(), 2);
        assert_eq!(
            contents["01-manual.txt"],
            fs::read_to_string(tmp.path().join(&reference.path)).unwrap()
        );
        let manifest: serde_json::Value = serde_json::from_str(&contents["manifest.json"]).unwrap();
        assert_eq!(manifest["references"][0]["sha256"], reference.sha256);
        assert_eq!(manifest["missing"][0], "入场说明");
        assert!(!tmp.path().join("资料包").exists());
        fs::write(tmp.path().join(&reference.path), "no longer same").unwrap();
        assert!(vault
            .document_bundle_export(
                "user",
                DocumentBundleInput {
                    library_id: library,
                    title: "旅行".into(),
                    references: vec![reference],
                    missing: vec![]
                }
            )
            .is_err());
    }

    #[test]
    fn document_reads_and_exports_require_the_original_library_and_user_session() {
        let (_tmp, vault, library, reference) = setup();
        assert!(vault.document_library_state("agent").is_err());
        assert!(vault
            .document_preview("agent", read(&library, &reference))
            .is_err());
        assert!(vault
            .document_collection_put("agent", collection(&library, &reference, 0))
            .is_err());
        let other = tempfile::tempdir().unwrap();
        vault.set_root(other.path()).unwrap();
        assert!(vault
            .document_preview("user", read(&library, &reference))
            .is_err());
        assert!(vault
            .document_collection_put("user", collection(&library, &reference, 0))
            .is_err());
        assert!(vault
            .document_search(
                "user",
                DocumentSearchInput {
                    library_id: library.clone(),
                    query: "manual".into()
                }
            )
            .is_err());
        assert!(vault
            .document_bundle_export(
                "user",
                DocumentBundleInput {
                    library_id: library,
                    title: "test".into(),
                    references: vec![reference],
                    missing: vec![]
                }
            )
            .is_err());
        assert!(vault
            .document_library_state("user")
            .unwrap()
            .collections
            .is_empty());
    }

    #[test]
    fn document_commands_fail_when_the_local_space_is_locked() {
        let (_tmp, vault, library, reference) = setup();
        let account = tempfile::tempdir().unwrap();
        vault
            .enable_ai_os_login(
                &fs::canonicalize(account.path())
                    .unwrap()
                    .join(".jiaho-onboarding"),
            )
            .unwrap();
        assert!(matches!(
            vault.document_library_state("user"),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.document_preview("user", read(&library, &reference)),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.document_favorite_set("user", favorite(&library, &reference, 0)),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.document_collection_put("user", collection(&library, &reference, 0)),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.document_search(
                "user",
                DocumentSearchInput {
                    library_id: library.clone(),
                    query: "manual".into()
                }
            ),
            Err(VaultError::AuthRequired)
        ));
        assert!(matches!(
            vault.document_bundle_export(
                "user",
                DocumentBundleInput {
                    library_id: library,
                    title: "test".into(),
                    references: vec![reference],
                    missing: vec![]
                }
            ),
            Err(VaultError::AuthRequired)
        ));
    }

    #[test]
    fn document_preview_limits_and_unicode_truncation_are_explicit() {
        let (tmp, vault, library, _) = setup();
        fs::write(tmp.path().join("large.txt"), "你".repeat(50000)).unwrap();
        fs::write(tmp.path().join("fake.pdf"), "not a PDF").unwrap();
        fs::write(tmp.path().join("real.pdf"), "%PDF-1.7\nsynthetic").unwrap();
        fs::write(
            tmp.path().join("huge.txt"),
            vec![b'x'; DOC_BYTES as usize + 1],
        )
        .unwrap();
        vault.file_index_refresh("user").unwrap();
        let files = vault
            .file_index_query("user", FileIndexFilter::default())
            .unwrap()
            .items;
        for file in files {
            let reference = DocumentReference {
                path: file.path.clone(),
                sha256: file.sha256,
                group: None,
            };
            let result = vault.document_preview("user", read(&library, &reference));
            match file.name.as_str() {
                "large.txt" => {
                    let result = result.unwrap();
                    assert!(result.truncated);
                    let text = result.content.unwrap();
                    assert!(text.len() <= TEXT_BYTES);
                    assert!(text.ends_with('你'));
                }
                "fake.pdf" => assert_eq!(result.unwrap().kind, "unsupported"),
                "real.pdf" => assert_eq!(result.unwrap().kind, "pdf"),
                "huge.txt" => assert_eq!(result.unwrap_err().code(), -32003),
                _ => {}
            }
        }
    }

    #[test]
    fn document_search_is_bounded_and_excludes_protected_history() {
        let (tmp, vault, library, _) = setup();
        for index in 0..25 {
            fs::write(
                tmp.path().join(format!("{index:02}.txt")),
                "no matching term",
            )
            .unwrap();
        }
        fs::create_dir_all(tmp.path().join("tasks")).unwrap();
        fs::write(tmp.path().join("tasks/history.json"), "NEEDLE-PRIVATE").unwrap();
        vault.file_index_refresh("user").unwrap();
        let result = vault
            .document_search(
                "user",
                DocumentSearchInput {
                    library_id: library.clone(),
                    query: "NEEDLE-PRIVATE".into(),
                },
            )
            .unwrap();
        assert!(result.items.is_empty());
        assert_eq!(result.body_examined, 20);
        assert!(result.skipped > 0);
        assert!(result.incomplete);
        let result = vault
            .document_search(
                "user",
                DocumentSearchInput {
                    library_id: library,
                    query: "manual.txt".into(),
                },
            )
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].file.name, "manual.txt");
    }

    #[test]
    fn document_collection_validation_covers_duplicates_limits_and_control_input() {
        let (_tmp, vault, library, reference) = setup();
        for mutate in 0..5 {
            let mut input = collection(&library, &reference, 0);
            match mutate {
                0 => input.references.push(reference.clone()),
                1 => input.references = vec![reference.clone(); 51],
                2 => input.missing = vec!["missing".into(); 31],
                3 => input.title = "title\nnot allowed".into(),
                _ => input.references[0].group = Some("x".repeat(121)),
            }
            assert!(vault.document_collection_put("user", input).is_err());
        }
        assert!(vault
            .document_library_state("user")
            .unwrap()
            .collections
            .is_empty());
    }
}
