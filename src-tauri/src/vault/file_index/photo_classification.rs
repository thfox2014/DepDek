//! Read-only, SHA-bound classification projection. Never scans originals or calls a model.
use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoClassificationInput {
    pub library_id: Option<String>, pub dimension: Option<PhotoDimension>, pub label: Option<String>,
    pub status: Option<String>, pub offset: Option<usize>, pub limit: Option<usize>, pub group_offset: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
pub struct ClassifiedPhotoLabel { #[serde(flatten)] pub label: PhotoLabel, pub source: String }
#[derive(Debug, Serialize)]
pub struct ClassifiedPhoto {
    pub file: FileIndexRecord, pub tags: Vec<PhotoTag>, pub labels: Vec<ClassifiedPhotoLabel>,
    pub analyzed: bool, pub needs_review: bool,
}
#[derive(Debug, Serialize)]
pub struct PhotoClassificationGroup {
    pub dimension: PhotoDimension, pub label: String, pub total: usize, pub confirmed: usize,
    pub ai_suggested: usize, pub covers: Vec<PhotoLibraryItem>,
}
#[derive(Debug, Default, Serialize)]
pub struct PhotoClassificationCounts { pub photos: usize, pub annotated: usize, pub unclassified: usize, pub review: usize }
#[derive(Debug, Serialize)]
pub struct PhotoClassificationResult {
    pub items: Vec<ClassifiedPhoto>, pub total: usize, pub groups: Vec<PhotoClassificationGroup>,
    pub group_total: usize, pub counts: PhotoClassificationCounts, pub summary: FileIndexSummary,
}

fn labels(tags: &[PhotoTag], annotation: Option<&ContentAnnotation>) -> Vec<ClassifiedPhotoLabel> {
    let mut values = BTreeMap::new();
    let manual_dimensions: BTreeSet<_> = tags.iter().filter_map(|tag| match tag.kind {
        PhotoTagKind::Person => Some(PhotoDimension::People), PhotoTagKind::Event => Some(PhotoDimension::Event),
        PhotoTagKind::Place => Some(PhotoDimension::Place), _ => None,
    }).collect();
    if let Some(annotation) = annotation {
        let confirmed = annotation.confirmed_photo_labels.is_some();
        for label in annotation.confirmed_photo_labels.as_ref().or(annotation.result.photo_labels.as_ref()).into_iter().flatten() {
            if manual_dimensions.contains(&label.dimension) { continue; }
            values.insert((label.dimension.clone(), label.label.clone()), ClassifiedPhotoLabel {
                label: label.clone(), source: if confirmed { "user" } else { "ai" }.into(),
            });
        }
    }
    for tag in tags {
        let dimension = match tag.kind {
            PhotoTagKind::Person => PhotoDimension::People, PhotoTagKind::Event => PhotoDimension::Event,
            PhotoTagKind::Place => PhotoDimension::Place, _ => continue,
        };
        values.insert((dimension.clone(), tag.value.clone()), ClassifiedPhotoLabel {
            label: PhotoLabel { dimension, label: tag.value.clone(), confidence: 100, evidence: "用户标注".into() }, source: "user".into(),
        });
    }
    values.into_values().collect()
}

impl Vault {
    pub fn photo_classification_query(&self, session: &str, input: PhotoClassificationInput) -> Result<PhotoClassificationResult, VaultError> {
        self.file_index_audited(session, Op::Search, "photo-classification/query", || {
            let limit = input.limit.unwrap_or(12);
            let status = input.status.as_deref().unwrap_or("all");
            if limit == 0 || limit > 100 || input.offset.unwrap_or(0) > MAX_FILES
                || input.group_offset.unwrap_or(0) > MAX_FILES * 16 || !["all", "review", "unclassified"].contains(&status)
                || input.label.as_ref().is_some_and(|value| input.dimension.is_none() || value.trim().is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control)) {
                return Err(VaultError::InvalidParams("invalid photo classification filter".into()));
            }
            let pair = self.root_pair()?;
            let identity = library_identity(&pair);
            if input.library_id.as_ref().is_some_and(|id| *id != identity) { return Err(VaultError::InvalidParams("Home changed".into())); }
            let mut output = PhotoClassificationResult { items: vec![], total: 0, groups: vec![], group_total: 0,
                counts: PhotoClassificationCounts::default(), summary: FileIndexSummary { library_id: identity.clone(), ..Default::default() } };
            let Some(db) = open_index(&pair, false)? else { return Ok(output); };
            let read = db.begin_read().map_err(db_error)?;
            let files = read.open_table(FILES).map_err(db_error)?;
            if let Some(row) = read.open_table(META).map_err(db_error)?.get("summary").map_err(db_error)? {
                output.summary = serde_json::from_str(row.value()).map_err(json_error)?;
                output.summary.library_id = identity.clone();
            }
            let tags = match read.open_table(PHOTO_TAGS) { Ok(table) => Some(table), Err(redb::TableError::TableDoesNotExist(_)) => None, Err(e) => return Err(db_error(e)) };
            let annotations = match read.open_table(content::ANNOTATIONS) { Ok(table) => Some(table), Err(redb::TableError::TableDoesNotExist(_)) => None, Err(e) => return Err(db_error(e)) };
            let mut groups = BTreeMap::<(PhotoDimension, String), PhotoClassificationGroup>::new();
            for row in files.iter().map_err(db_error)? {
                let (_, value) = row.map_err(db_error)?;
                let file: FileIndexRecord = serde_json::from_str(value.value()).map_err(json_error)?;
                if file.category != FileCategory::Photos || excluded(&file.path) { continue; }
                let saved_tags: Option<PhotoTagRecord> = match &tags {
                    Some(table) => table.get(file.path.as_str()).map_err(db_error)?.map(|row| serde_json::from_str(row.value()).map_err(json_error)).transpose()?, None => None,
                };
                let saved_tags = saved_tags.filter(|row| row.path == file.path && row.sha256 == file.sha256).map(|row| row.tags).unwrap_or_default();
                let annotation: Option<ContentAnnotation> = match &annotations {
                    Some(table) => table.get(file.path.as_str()).map_err(db_error)?.map(|row| serde_json::from_str(row.value()).map_err(json_error)).transpose()?, None => None,
                };
                let annotation = annotation.filter(|row| row.path == file.path && row.sha256 == file.sha256);
                let analyzed = annotation.as_ref().is_some_and(|row| row.result.photo_labels.is_some() || row.confirmed_photo_labels.is_some());
                let values = labels(&saved_tags, annotation.as_ref());
                let needs_review = values.iter().any(|item| item.source == "ai" && item.label.confidence < 80)
                    || analyzed && values.is_empty() && !annotation.as_ref().is_some_and(|row| row.confirmed_photo_labels.is_some());
                output.counts.photos += 1;
                output.counts.annotated += usize::from(analyzed);
                output.counts.unclassified += usize::from(!analyzed);
                output.counts.review += usize::from(needs_review);
                for item in &values {
                    if item.source == "ai" && item.label.confidence < 80 || input.dimension.as_ref().is_some_and(|dimension| *dimension != item.label.dimension) { continue; }
                    let key = (item.label.dimension.clone(), item.label.label.clone());
                    let group = groups.entry(key).or_insert_with(|| PhotoClassificationGroup {
                        dimension: item.label.dimension.clone(), label: item.label.label.clone(), total: 0, confirmed: 0, ai_suggested: 0, covers: vec![],
                    });
                    group.total += 1; group.confirmed += usize::from(item.source == "user"); group.ai_suggested += usize::from(item.source == "ai");
                    if group.covers.len() < 3 { group.covers.push(PhotoLibraryItem { file: file.clone(), tags: saved_tags.clone() }); }
                }
                let dimension_matches = input.dimension.as_ref().is_none_or(|dimension| values.iter().any(|item| item.label.dimension == *dimension
                    && input.label.as_ref().is_none_or(|label| *label == item.label.label)
                    && (item.source == "user" || item.label.confidence >= 80)));
                if !dimension_matches || status == "review" && !needs_review || status == "unclassified" && analyzed { continue; }
                if output.total >= input.offset.unwrap_or(0) && output.items.len() < limit {
                    output.items.push(ClassifiedPhoto { file, tags: saved_tags, labels: values, analyzed, needs_review });
                }
                output.total += 1;
            }
            let mut groups: Vec<_> = groups.into_values().collect();
            groups.sort_by(|a,b| b.confirmed.cmp(&a.confirmed).then_with(|| b.total.cmp(&a.total)).then_with(|| a.label.cmp(&b.label)));
            output.group_total = groups.len();
            output.groups = groups.into_iter().skip(input.group_offset.unwrap_or(0)).take(24).collect();
            self.require_ai_os_login()?;
            if library_identity(&self.root_pair()?) != identity { return Err(VaultError::InvalidParams("Home changed".into())); }
            if serde_json::to_vec(&output).map_err(json_error)?.len() > 2 * 1024 * 1024 { return Err(VaultError::TooLarge); }
            Ok(output)
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Vault, ContentAnalyzeInput) {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::new(); vault.set_root(dir.path()).unwrap();
        fs::write(dir.path().join("a.png"), b"\x89PNG\r\n\x1a\nsynthetic").unwrap();
        fs::write(dir.path().join("copy.png"), b"\x89PNG\r\n\x1a\nsynthetic").unwrap();
        let summary = vault.file_index_refresh("user").unwrap();
        let photo = vault.photo_library_query("user", PhotoLibraryFilter::default()).unwrap().items.remove(0);
        let input = ContentAnalyzeInput { library_id: summary.library_id, reference: ContentReference { path: photo.file.path, sha256: photo.file.sha256 }, provider_name: "synthetic-vision".into(),
            evidence: ContentEvidence { text: "".into(), images: vec![ContentImage { data: BASE64.encode(b"\x89PNG\r\n\x1a\nfixture"), mime_type: "image/png".into(), label: "受控样本".into() }], coverage: "仅测试，不是真实识别".into() }, expected_revision: 0 };
        (dir, vault, input)
    }
    fn label(dimension: PhotoDimension, name: &str, confidence: u8) -> PhotoLabel { PhotoLabel { dimension, label: name.into(), confidence, evidence: "合成测试画面依据".into() } }
    fn generated() -> ContentResult { ContentResult { title: "海边的一刻".into(), description: "可见人物及海岸".into(), tags: vec!["海边".into()], observations: vec![], uncertainties: vec!["不知道姓名与城市".into()], total_tokens: 12,
        photo_labels: Some(vec![label(PhotoDimension::People, "单人", 95), label(PhotoDimension::Place, "海边", 96), label(PhotoDimension::Event, "旅行", 55)]) } }
    fn query(vault: &Vault) -> PhotoClassificationResult { vault.photo_classification_query("user", PhotoClassificationInput::default()).unwrap() }
    fn save(vault: &Vault, input: &ContentAnalyzeInput) -> ContentAnnotation { vault.content_annotation_save("user", input.clone(), "vision".into(), generated()).unwrap() }
    fn correct(vault: &Vault, input: &ContentAnalyzeInput, old: &ContentAnnotation, labels: Vec<PhotoLabel>) -> ContentAnnotation {
        vault.content_annotation_update("user", ContentUpdateInput { library_id: input.library_id.clone(), reference: input.reference.clone(), expected_revision: old.revision,
            title: old.result.title.clone(), description: old.result.description.clone(), tags: old.result.tags.clone(), photo_labels: Some(labels) }).unwrap()
    }

    #[test]
    fn multi_dimension_groups_are_sha_bound_and_low_confidence_stays_in_review() {
        let (_dir, vault, input) = fixture(); save(&vault, &input);
        let all = query(&vault); assert_eq!(all.counts.photos, 2); assert_eq!(all.counts.annotated, 1); assert_eq!(all.counts.unclassified, 1); assert_eq!(all.counts.review, 1);
        assert_eq!(all.groups.len(), 2); assert!(all.groups.iter().all(|g| g.total == 1 && g.ai_suggested == 1 && g.confirmed == 0));
        assert!(all.groups.iter().all(|g| g.label != "旅行"));
        let review = vault.photo_classification_query("user", PhotoClassificationInput { status: Some("review".into()), ..Default::default() }).unwrap();
        assert_eq!(review.total, 1); assert_eq!(review.items[0].file.path, "a.png");
        let missing = vault.photo_classification_query("user", PhotoClassificationInput { status: Some("unclassified".into()), ..Default::default() }).unwrap();
        assert_eq!(missing.total, 1); assert_eq!(missing.items[0].file.path, "copy.png");
        let exact = vault.photo_classification_query("user", PhotoClassificationInput { dimension: Some(PhotoDimension::Place), label: Some("海边".into()), ..Default::default() }).unwrap(); assert_eq!(exact.total, 1);
        let wrong = vault.photo_classification_query("user", PhotoClassificationInput { dimension: Some(PhotoDimension::Event), label: Some("海边".into()), ..Default::default() }).unwrap(); assert_eq!(wrong.total, 0);
    }
    #[test]
    fn human_names_win_and_ai_reruns_preserve_explicit_corrections_and_empty_retractions() {
        let (_dir, vault, mut input) = fixture();
        vault.photo_tags_set("user", &input.reference.path, &input.reference.sha256, vec![PhotoTag { kind: PhotoTagKind::Person, value: "小满".into() }]).unwrap();
        let ai = save(&vault, &input);
        let confirmed = correct(&vault, &input, &ai, vec![label(PhotoDimension::Place, "三亚", 100)]);
        input.expected_revision = confirmed.revision;
        let rerun = save(&vault, &input); assert_eq!(rerun.confirmed_photo_labels.as_ref().unwrap()[0].label, "三亚");
        let all = query(&vault); assert!(all.groups.iter().any(|g| g.label == "小满" && g.confirmed == 1));
        assert!(!all.groups.iter().any(|g| g.label == "单人" || g.label == "海边"));
        let cleared = correct(&vault, &input, &rerun, vec![]); input.expected_revision = cleared.revision; save(&vault, &input);
        let all = query(&vault); assert_eq!(all.groups.len(), 1); assert_eq!(all.groups[0].label, "小满"); assert_eq!(all.counts.review, 0);
        assert!(vault.content_annotation_update("user", ContentUpdateInput { library_id: input.library_id, reference: input.reference, expected_revision: 1, title: "x".into(), description: "x".into(), tags: vec![], photo_labels: Some(vec![]) }).is_err());
    }
    #[test]
    fn classifications_survive_reindex_and_reopen_but_not_source_revision_or_other_paths() {
        let (dir, vault, input) = fixture(); save(&vault, &input);
        vault.file_index_refresh("user").unwrap(); assert_eq!(query(&vault).counts.annotated, 1);
        drop(vault); let vault = Vault::new(); vault.set_root(dir.path()).unwrap();
        assert_eq!(query(&vault).groups[0].covers[0].file.path, "a.png");
        fs::write(dir.path().join("a.png"), b"\x89PNG\r\n\x1a\nchanged").unwrap(); vault.file_index_refresh("user").unwrap();
        assert_eq!(query(&vault).counts.annotated, 0); assert!(query(&vault).groups.is_empty());
    }
    #[test]
    fn invalid_ai_labels_never_persist_and_old_content_records_remain_readable() {
        let (_dir, vault, input) = fixture();
        for labels in [None, Some(vec![label(PhotoDimension::People, "小满", 99)]), Some(vec![label(PhotoDimension::Place, "海边", 101)]), Some(vec![label(PhotoDimension::Place, "海边", 80); 2]), Some(vec![label(PhotoDimension::Place, "海边", 80); 13])] {
            let mut value = generated(); value.photo_labels = labels;
            assert!(vault.content_annotation_save("user", input.clone(), "test".into(), value).is_err());
            assert_eq!(query(&vault).counts.annotated, 0);
        }
        let mut legacy = serde_json::to_value(generated()).unwrap(); legacy.as_object_mut().unwrap().remove("photo_labels");
        let restored: ContentResult = serde_json::from_value(legacy).unwrap(); assert!(restored.photo_labels.is_none());
        let mut empty = generated(); empty.photo_labels = Some(vec![]); vault.content_annotation_save("user", input, "test".into(), empty).unwrap(); assert_eq!(query(&vault).counts.review, 1);
    }
    #[test]
    fn group_and_photo_paging_is_bounded_and_counts_do_not_depend_on_the_page() {
        let (dir, vault, input) = fixture();
        for i in 0..30 { fs::write(dir.path().join(format!("group-{i:02}.png")), b"\x89PNG\r\n\x1a\nfixture").unwrap(); }
        vault.file_index_refresh("user").unwrap();
        for item in vault.photo_library_query("user", PhotoLibraryFilter { limit: Some(100), ..Default::default() }).unwrap().items {
            vault.photo_tags_set("user", &item.file.path, &item.file.sha256, vec![PhotoTag { kind: PhotoTagKind::Event, value: item.file.name.clone() }]).unwrap();
        }
        let first = query(&vault); assert_eq!(first.group_total, 32); assert_eq!(first.groups.len(), 24); assert_eq!(first.items.len(), 12);
        let next = vault.photo_classification_query("user", PhotoClassificationInput { library_id: Some(input.library_id), group_offset: Some(24), offset: Some(12), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(next.groups.len(), 8); assert_eq!(next.items.len(), 20); assert_eq!(next.counts.photos, 32);
        assert!(first.groups.iter().all(|g| g.covers.len() <= 3));
    }
    #[test]
    fn cross_home_agent_invalid_filters_and_symlink_writes_are_rejected_and_audited() {
        use std::os::unix::fs::symlink;
        let (dir, vault, input) = fixture(); let saved = save(&vault, &input);
        assert!(vault.photo_classification_query("agent-x", PhotoClassificationInput::default()).is_err());
        for value in [PhotoClassificationInput { library_id: Some("other".into()), ..Default::default() }, PhotoClassificationInput { label: Some("海边".into()), ..Default::default() }, PhotoClassificationInput { status: Some("delete".into()), ..Default::default() }, PhotoClassificationInput { limit: Some(101), ..Default::default() }] {
            assert!(vault.photo_classification_query("user", value).is_err());
        }
        fs::remove_file(dir.path().join("a.png")).unwrap(); symlink(dir.path().join("copy.png"), dir.path().join("a.png")).unwrap();
        assert!(vault.content_annotation_update("user", ContentUpdateInput { library_id: input.library_id.clone(), reference: input.reference.clone(), expected_revision: saved.revision, title: "test".into(), description: "test".into(), tags: vec![], photo_labels: Some(vec![]) }).is_err());
        let (audit, _) = vault.audit().read(0, 200); assert!(audit.iter().filter(|entry| !entry.ok).count() >= 6);
        let other = tempfile::tempdir().unwrap(); vault.set_root(other.path()).unwrap();
        assert!(vault.photo_classification_query("user", PhotoClassificationInput { library_id: Some(input.library_id), ..Default::default() }).is_err());
    }
}
