//! Shared, source-bound AI annotations. The model never receives filesystem authority.
use super::*;
use std::collections::BTreeSet;

const ANNOTATIONS: TableDefinition<&str, &str> = TableDefinition::new("content_annotations_v1");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentReference { pub path: String, pub sha256: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentImage { pub data: String, pub mime_type: String, pub label: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentEvidence { pub text: String, pub images: Vec<ContentImage>, pub coverage: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentObservation { pub label: String, pub value: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentResult {
    pub title: String, pub description: String, pub tags: Vec<String>,
    pub observations: Vec<ContentObservation>, pub uncertainties: Vec<String>, pub total_tokens: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentAnnotation {
    pub path: String, pub sha256: String,
    #[serde(flatten)] pub result: ContentResult,
    pub coverage: String, pub provider_name: String, pub model: String, pub source: String,
    pub revision: u64, pub created_at_ms: u64, pub updated_at_ms: u64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentReadInput { pub library_id: String, pub reference: ContentReference }
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentAnalyzeInput {
    pub library_id: String, pub reference: ContentReference, pub provider_name: String,
    pub evidence: ContentEvidence, pub expected_revision: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentUpdateInput {
    pub library_id: String, pub reference: ContentReference, pub expected_revision: u64,
    pub title: String, pub description: String, pub tags: Vec<String>,
}

fn invalid(message: &str) -> VaultError { VaultError::InvalidParams(message.into()) }
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn validate_result(result: &ContentResult) -> Result<(), VaultError> {
    if !text(&result.title, 120) || !text(&result.description, 1600) || result.tags.len() > 12
        || result.tags.iter().any(|value| !text(value, 60)) || result.observations.len() > 8
        || result.observations.iter().any(|value| !text(&value.label, 40) || !text(&value.value, 300))
        || result.uncertainties.len() > 6 || result.uncertainties.iter().any(|value| !text(value, 160)) {
        return Err(invalid("CONTENT_INVALID_RESULT"));
    }
    Ok(())
}
fn validate_evidence(evidence: &ContentEvidence, category: FileCategory) -> Result<(), VaultError> {
    if evidence.text.chars().count() > 24_000 || evidence.text.contains('\0') || !text(&evidence.coverage, 240)
        || evidence.images.len() > 6 || evidence.text.trim().is_empty() && evidence.images.is_empty()
        || matches!(category, FileCategory::Photos | FileCategory::Videos) && evidence.images.is_empty() {
        return Err(invalid("CONTENT_INVALID_EVIDENCE"));
    }
    let mut total = 0;
    for image in &evidence.images {
        if !text(&image.label, 120) || image.data.len() > 1_398_104 { return Err(VaultError::TooLarge); }
        let bytes = BASE64.decode(&image.data).map_err(|_| invalid("CONTENT_INVALID_IMAGE"))?;
        total += bytes.len();
        if bytes.len() > 1024 * 1024 || total > 4 * 1024 * 1024 { return Err(VaultError::TooLarge); }
        let signature = match image.mime_type.as_str() {
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        if !signature { return Err(invalid("CONTENT_INVALID_IMAGE")); }
    }
    Ok(())
}
fn current(vault: &Vault, library_id: &str) -> Result<RootPair, VaultError> {
    let pair = vault.root_pair()?;
    if library_identity(&pair) != library_id { return Err(invalid("Home changed; reopen content library")); }
    Ok(pair)
}
fn indexed(db: &Database, reference: &ContentReference) -> Result<FileIndexRecord, VaultError> {
    photo_path(&reference.path, &reference.sha256)?;
    let read = db.begin_read().map_err(db_error)?;
    let files = read.open_table(FILES).map_err(db_error)?;
    let row = files.get(reference.path.as_str()).map_err(db_error)?.ok_or_else(|| invalid("file is not indexed"))?;
    let file: FileIndexRecord = serde_json::from_str(row.value()).map_err(json_error)?;
    if file.path != reference.path || !file.sha256.eq_ignore_ascii_case(&reference.sha256)
        || !matches!(file.category, FileCategory::Photos | FileCategory::Videos | FileCategory::Documents) {
        return Err(invalid("content changed or unsupported; update index"));
    }
    Ok(file)
}
fn source_limit(file: &FileIndexRecord) -> u64 {
    match file.category { FileCategory::Photos => MAX_PHOTO_BYTES, FileCategory::Videos => 64 * 1024 * 1024, _ => 16 * 1024 * 1024 }
}
fn check_source(vault: &Vault, pair: &RootPair, file: &FileIndexRecord) -> Result<(), VaultError> {
    let result = indexed_source_bytes(pair, &file.path, &file.sha256, source_limit(file)).map(|_| ());
    let mut entry = AuditEntry::new("user", Op::Read, &file.path);
    entry.sha256 = Some(file.sha256.clone()); entry.ok = result.is_ok();
    entry.error = result.as_ref().err().map(ToString::to_string);
    vault.inner.audit.record_durable(entry)?;
    result
}
fn read(db: &Database, reference: &ContentReference) -> Result<Option<ContentAnnotation>, VaultError> {
    let txn = db.begin_read().map_err(db_error)?;
    let table = match txn.open_table(ANNOTATIONS) {
        Ok(table) => table, Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None), Err(e) => return Err(db_error(e)),
    };
    let value: Option<ContentAnnotation> = table.get(reference.path.as_str()).map_err(db_error)?
        .map(|row| serde_json::from_str(row.value()).map_err(json_error)).transpose()?;
    Ok(value.filter(|item| item.path == reference.path && item.sha256.eq_ignore_ascii_case(&reference.sha256)))
}
fn write(db: &Database, value: &ContentAnnotation) -> Result<(), VaultError> {
    let serialized = serde_json::to_string(value).map_err(json_error)?;
    let txn = db.begin_write().map_err(db_error)?;
    { txn.open_table(ANNOTATIONS).map_err(db_error)?.insert(value.path.as_str(), serialized.as_str()).map_err(db_error)?; }
    txn.commit().map_err(db_error)
}

pub(super) fn search_matches(db: &Database, needle: &str) -> Result<BTreeSet<(String, String)>, VaultError> {
    let mut found = BTreeSet::new();
    if needle.is_empty() { return Ok(found); }
    let read = db.begin_read().map_err(db_error)?;
    let table = match read.open_table(ANNOTATIONS) {
        Ok(table) => table, Err(redb::TableError::TableDoesNotExist(_)) => return Ok(found), Err(e) => return Err(db_error(e)),
    };
    for row in table.iter().map_err(db_error)? {
        let (_, value) = row.map_err(db_error)?;
        let item: ContentAnnotation = serde_json::from_str(value.value()).map_err(json_error)?;
        if item.result.title.to_lowercase().contains(needle) || item.result.description.to_lowercase().contains(needle)
            || item.result.tags.iter().any(|tag| tag.to_lowercase().contains(needle)) {
            found.insert((item.path, item.sha256.to_lowercase()));
        }
    }
    Ok(found)
}

impl Vault {
    pub fn content_annotation_get(&self, session: &str, input: ContentReadInput) -> Result<Option<ContentAnnotation>, VaultError> {
        self.file_index_audited(session, Op::Read, "content-agent/annotation", || {
            let pair = current(self, &input.library_id)?;
            let Some(db) = open_index(&pair, false)? else { return Ok(None); };
            let file = indexed(&db, &input.reference)?;
            check_source(self, &pair, &file)?;
            read(&db, &input.reference)
        })
    }
    pub fn content_analysis_prepare(&self, session: &str, input: &ContentAnalyzeInput) -> Result<FileIndexRecord, VaultError> {
        self.file_index_audited(session, Op::Read, "content-agent/prepare", || {
            let pair = current(self, &input.library_id)?;
            let db = open_index(&pair, false)?.ok_or_else(|| invalid("file is not indexed"))?;
            let file = indexed(&db, &input.reference)?;
            validate_evidence(&input.evidence, file.category)?;
            if !text(&input.provider_name, 120) { return Err(invalid("CONTENT_PROVIDER_REQUIRED")); }
            if read(&db, &input.reference)?.as_ref().map_or(0, |item| item.revision) != input.expected_revision { return Err(invalid("content revision conflict")); }
            check_source(self, &pair, &file)?;
            Ok(file)
        })
    }
    pub fn content_annotation_save(&self, session: &str, input: ContentAnalyzeInput, model: String, result: ContentResult) -> Result<ContentAnnotation, VaultError> {
        self.file_index_audited(session, Op::Write, "content-agent/save", || {
            validate_result(&result)?;
            let pair = current(self, &input.library_id)?;
            let db = open_index(&pair, false)?.ok_or_else(|| invalid("file is not indexed"))?;
            let file = indexed(&db, &input.reference)?;
            validate_evidence(&input.evidence, file.category)?;
            check_source(self, &pair, &file)?;
            let old = read(&db, &input.reference)?;
            if old.as_ref().map_or(0, |item| item.revision) != input.expected_revision { return Err(invalid("content revision conflict")); }
            let now = now_ms();
            let value = ContentAnnotation { path: file.path, sha256: file.sha256, result, coverage: input.evidence.coverage,
                provider_name: input.provider_name, model, source: "ai".into(), revision: input.expected_revision.checked_add(1).ok_or_else(|| invalid("revision overflow"))?,
                created_at_ms: old.map_or(now, |item| item.created_at_ms), updated_at_ms: now };
            self.require_ai_os_login()?;
            write(&db, &value)?;
            Ok(value)
        })
    }
    pub fn content_annotation_update(&self, session: &str, input: ContentUpdateInput) -> Result<ContentAnnotation, VaultError> {
        self.file_index_audited(session, Op::Write, "content-agent/correct", || {
            let pair = current(self, &input.library_id)?;
            let db = open_index(&pair, false)?.ok_or_else(|| invalid("file is not indexed"))?;
            let file = indexed(&db, &input.reference)?;
            check_source(self, &pair, &file)?;
            let mut old = read(&db, &input.reference)?.ok_or_else(|| invalid("content annotation not found"))?;
            if old.revision != input.expected_revision { return Err(invalid("content revision conflict")); }
            old.result.title = input.title; old.result.description = input.description; old.result.tags = input.tags;
            validate_result(&old.result)?;
            old.source = "user_corrected".into(); old.revision = old.revision.checked_add(1).ok_or_else(|| invalid("revision overflow"))?; old.updated_at_ms = now_ms();
            self.require_ai_os_login()?;
            write(&db, &old)?;
            Ok(old)
        })
    }
    pub fn content_analysis_failed(&self, session: &str) -> Result<(), VaultError> {
        self.file_index_audited(session, Op::Read, "content-agent/model-failed", || Err::<(), _>(invalid("CONTENT_MODEL_FAILED")))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn fixture() -> (tempfile::TempDir, Vault, ContentAnalyzeInput) {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::new(); vault.set_root(dir.path()).unwrap();
        fs::write(dir.path().join("receipt.txt"), "空调购买凭证，保修三年").unwrap();
        let summary = vault.file_index_refresh("user").unwrap();
        let file = vault.file_index_query("user", FileIndexFilter::default()).unwrap().items.remove(0);
        let input = ContentAnalyzeInput { library_id: summary.library_id, reference: ContentReference { path: file.path, sha256: file.sha256 }, provider_name: "test-model".into(),
            evidence: ContentEvidence { text: "空调购买凭证，保修三年".into(), images: vec![], coverage: "文档正文".into() }, expected_revision: 0 };
        (dir, vault, input)
    }
    fn result() -> ContentResult { ContentResult { title: "空调保修凭证".into(), description: "购买凭证中写有三年保修条款".into(), tags: vec!["家电保修".into()], observations: vec![], uncertainties: vec!["实际保修截止日待核对".into()], total_tokens: 88 } }
    fn read_input(input: &ContentAnalyzeInput) -> ContentReadInput { ContentReadInput { library_id: input.library_id.clone(), reference: input.reference.clone() } }

    #[test]
    fn content_annotation_persists_searches_and_supports_revision_checked_correction() {
        let (dir, vault, input) = fixture(); vault.content_analysis_prepare("user", &input).unwrap();
        let saved = vault.content_annotation_save("user", input.clone(), "model".into(), result()).unwrap(); assert_eq!(saved.revision, 1);
        let matches = vault.document_search("user", DocumentSearchInput { library_id: input.library_id.clone(), query: "家电保修".into() }).unwrap(); assert_eq!(matches.items.len(), 1);
        assert_eq!(vault.file_index_query("user", FileIndexFilter { query: Some("家电保修".into()), ..Default::default() }).unwrap().total, 1);
        assert!(vault.content_annotation_save("user", input.clone(), "model".into(), result()).is_err());
        let changed = vault.content_annotation_update("user", ContentUpdateInput { library_id: input.library_id.clone(), reference: input.reference.clone(), expected_revision: 1, title: saved.result.title, description: "用户核对后更正为两年".into(), tags: vec!["两年保修".into()] }).unwrap();
        assert_eq!(changed.source, "user_corrected"); assert_eq!(changed.revision, 2);
        drop(vault); let next = Vault::new(); next.set_root(dir.path()).unwrap();
        assert_eq!(next.content_annotation_get("user", read_input(&input)).unwrap().unwrap().result.tags, vec!["两年保修"]);
    }
    #[test]
    fn content_annotation_rejects_stale_source_cross_home_agent_and_symlink_and_audits_failures() {
        let (dir, vault, input) = fixture();
        assert!(vault.content_analysis_prepare("agent-x", &input).is_err());
        let mut escape = input.clone(); escape.reference.path = "../outside.txt".into(); assert!(vault.content_analysis_prepare("user", &escape).is_err());
        let other = tempfile::tempdir().unwrap(); fs::write(other.path().join("x"), "private").unwrap();
        fs::remove_file(dir.path().join("receipt.txt")).unwrap(); symlink(other.path().join("x"), dir.path().join("receipt.txt")).unwrap();
        assert!(vault.content_analysis_prepare("user", &input).is_err()); assert!(vault.content_annotation_save("user", input.clone(), "model".into(), result()).is_err());
        fs::remove_file(dir.path().join("receipt.txt")).unwrap(); fs::write(dir.path().join("receipt.txt"), "changed").unwrap();
        assert!(vault.content_annotation_save("user", input.clone(), "model".into(), result()).is_err());
        let (audit, _) = vault.audit().read(0, 100); assert!(audit.iter().filter(|entry| entry.path.starts_with("content-agent/") && !entry.ok).count() >= 5);
        vault.set_root(other.path()).unwrap(); assert!(vault.content_annotation_get("user", read_input(&input)).is_err());
    }
    #[test]
    fn content_annotation_is_sha_bound_and_invalid_evidence_or_results_never_persist() {
        let (dir, vault, input) = fixture(); let mut malformed = input.clone(); malformed.evidence.text = "x".repeat(24_001);
        assert!(vault.content_analysis_prepare("user", &malformed).is_err());
        let mut bad = result(); bad.tags = vec!["x".into(); 13]; assert!(vault.content_annotation_save("user", input.clone(), "model".into(), bad).is_err());
        assert!(vault.content_annotation_get("user", read_input(&input)).unwrap().is_none());
        vault.content_annotation_save("user", input.clone(), "model".into(), result()).unwrap();
        fs::write(dir.path().join("receipt.txt"), "新的内容").unwrap();
        assert!(vault.content_annotation_get("user", read_input(&input)).is_err());
        vault.file_index_refresh("user").unwrap();
        assert!(vault.content_annotation_get("user", read_input(&input)).is_err());
        assert_eq!(vault.file_index_query("user", FileIndexFilter { query: Some("家电保修".into()), ..Default::default() }).unwrap().total, 0);
    }
    #[test]
    fn ai_media_labels_are_searchable_without_overwriting_manual_tags_or_other_copies() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::new(); vault.set_root(dir.path()).unwrap();
        let png = b"\x89PNG\r\n\x1a\nsample";
        fs::write(dir.path().join("a.png"), png).unwrap(); fs::write(dir.path().join("copy.png"), png).unwrap();
        fs::write(dir.path().join("clip.mp4"), b"\0\0\0\x18ftypisom\0\0\0\0isom").unwrap();
        let summary = vault.file_index_refresh("user").unwrap();
        for file in vault.file_index_query("user", FileIndexFilter::default()).unwrap().items {
            if file.path == "copy.png" { continue; }
            if file.category == FileCategory::Photos { vault.photo_tags_set("user", &file.path, &file.sha256, vec![PhotoTag { kind: PhotoTagKind::Person, value: "小满".into() }]).unwrap(); }
            let input = ContentAnalyzeInput { library_id: summary.library_id.clone(), reference: ContentReference { path: file.path, sha256: file.sha256 }, provider_name: "test-vision".into(),
                evidence: ContentEvidence { text: "".into(), coverage: "示例画面".into(), images: vec![ContentImage { data: BASE64.encode(png), mime_type: "image/png".into(), label: "取样画面".into() }] }, expected_revision: 0 };
            vault.content_analysis_prepare("user", &input).unwrap(); vault.content_annotation_save("user", input, "model".into(), result()).unwrap();
        }
        let photos = vault.photo_library_query("user", PhotoLibraryFilter { query: Some("家电保修".into()), ..Default::default() }).unwrap();
        assert_eq!(photos.total, 1); assert_eq!(photos.items[0].file.path, "a.png"); assert_eq!(photos.items[0].tags[0].value, "小满");
        assert_eq!(vault.video_library_query("user", PhotoLibraryFilter { query: Some("家电保修".into()), ..Default::default() }).unwrap().total, 1);
    }
}
