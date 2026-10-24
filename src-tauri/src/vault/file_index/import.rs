//! User-selected bytes become a separate local copy and an incremental index entry.
//! No caller path is opened and no other Home content is scanned.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileLibraryImportInput {
    pub library_id: String,
    pub operation_id: String,
    pub name: String,
    pub data_base64: String,
}
#[derive(Debug, Serialize)]
pub struct FileLibraryImportResult {
    pub file: FileIndexRecord,
    pub summary: FileIndexSummary,
    pub status: &'static str,
}

fn validate(input: &FileLibraryImportInput) -> Result<Vec<u8>, VaultError> {
    if input.operation_id.len() != 32
        || !input
            .operation_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(VaultError::InvalidParams(
            "invalid import operation ID".into(),
        ));
    }
    if input.name.is_empty()
        || input.name.len() > 240
        || input.name.trim() != input.name
        || input
            .name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || excluded(&input.name)
    {
        return Err(VaultError::InvalidParams(
            "unsupported import filename".into(),
        ));
    }
    let max_encoded = MAX_BINARY_FILE_SIZE.div_ceil(3) * 4;
    if input.data_base64.len() as u64 > max_encoded {
        return Err(VaultError::TooLarge);
    }
    let bytes = BASE64
        .decode(&input.data_base64)
        .map_err(|_| VaultError::InvalidParams("invalid import payload".into()))?;
    if bytes.len() as u64 > MAX_BINARY_FILE_SIZE {
        return Err(VaultError::TooLarge);
    }
    Ok(bytes)
}

impl Vault {
    pub fn file_library_import(
        &self,
        session: &str,
        input: FileLibraryImportInput,
    ) -> Result<FileLibraryImportResult, VaultError> {
        self.file_index_audited(session, Op::Write, "file-library/import", || {
            let bytes = validate(&input)?;
            #[cfg(unix)]
            {
                self.import_selected_bytes(input, &bytes)
            }
            #[cfg(not(unix))]
            {
                let _ = bytes;
                Err(io::Error::other("file imports currently require Linux or macOS").into())
            }
        })
    }

    #[cfg(unix)]
    fn import_selected_bytes(
        &self,
        input: FileLibraryImportInput,
        bytes: &[u8],
    ) -> Result<FileLibraryImportResult, VaultError> {
        let pair = self.root_pair()?;
        if input.library_id != library_identity(&pair) {
            return Err(VaultError::InvalidParams(
                "Home changed; import belongs to another library".into(),
            ));
        }
        let digest = sha256_hex(bytes);
        let path = format!("我的资料/{}/{}", input.operation_id, input.name);
        // Fail on unsafe/locked DB before publishing a new copy.
        let db = open_index(&pair, true)?.ok_or_else(|| db_error("no index"))?;
        let previous: Option<FileIndexRecord> = {
            let read = db.begin_read().map_err(db_error)?;
            let table = read.open_table(IMPORTS).map_err(db_error)?;
            let value = table.get(input.operation_id.as_str()).map_err(db_error)?;
            value
                .map(|v| serde_json::from_str(v.value()).map_err(json_error))
                .transpose()?
        };
        if previous
            .as_ref()
            .is_some_and(|r| r.name != input.name || r.sha256 != digest || r.path != path)
        {
            return Err(VaultError::InvalidParams(
                "import operation ID already used for different input".into(),
            ));
        }
        self.inner.audit.record_durable(AuditEntry::new(
            "user",
            Op::Write,
            "file-library/import.intent",
        ))?;
        let directory = import_directory(&pair, &input.operation_id, previous.is_none())?;
        let metadata = match existing_copy(&directory, &input.name, bytes.len() as u64, &digest)? {
            Some(meta) => meta,
            None if previous.is_some() => {
                return Err(VaultError::NotFound(
                    "previously imported copy no longer exists".into(),
                ))
            }
            None => publish_copy(self, &directory, &input.name, bytes, &digest)?,
        };
        self.require_ai_os_login()?;
        let (category, detected) = classify(&input.name, &bytes[..bytes.len().min(64 * 1024)]);
        let record = previous.unwrap_or(FileIndexRecord {
            file_id: Some(input.operation_id.clone()),
            path,
            original_path: input.name.clone(),
            name: input.name,
            sha256: digest,
            category,
            detected_by: detected.into(),
            size: bytes.len() as u64,
            modified_ms: metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            indexed_at_ms: now_ms(),
        });
        let category = record.category;
        let write = db.begin_write().map_err(db_error)?;
        let mut summary: FileIndexSummary = {
            let table = write.open_table(META).map_err(db_error)?;
            let value = table.get("summary").map_err(db_error)?;
            value
                .map(|v| serde_json::from_str(v.value()).map_err(json_error))
                .transpose()?
                .unwrap_or_default()
        };
        summary.library_id = library_identity(&pair);
        {
            let mut files = write.open_table(FILES).map_err(db_error)?;
            let old = files
                .get(record.path.as_str())
                .map_err(db_error)?
                .map(|v| serde_json::from_str::<FileIndexRecord>(v.value()).map_err(json_error))
                .transpose()?;
            if let Some(old) = &old {
                if old.sha256 != record.sha256 {
                    return Err(VaultError::InvalidParams("imported content changed".into()));
                }
            } else {
                summary.total += 1;
                summary.total_bytes += record.size;
                *summary.categories.entry(category.key().into()).or_default() += 1;
            }
            let value = serde_json::to_string(&record).map_err(json_error)?;
            files
                .insert(record.path.as_str(), value.as_str())
                .map_err(db_error)?;
            write
                .open_table(IMPORTS)
                .map_err(db_error)?
                .insert(input.operation_id.as_str(), value.as_str())
                .map_err(db_error)?;
            write
                .open_multimap_table(SHA)
                .map_err(db_error)?
                .insert(record.sha256.as_str(), record.path.as_str())
                .map_err(db_error)?;
            write
                .open_multimap_table(CATEGORY)
                .map_err(db_error)?
                .insert(category.key(), record.path.as_str())
                .map_err(db_error)?;
            summary.indexed_at_ms = now_ms();
            let value = serde_json::to_string(&summary).map_err(json_error)?;
            write
                .open_table(META)
                .map_err(db_error)?
                .insert("summary", value.as_str())
                .map_err(db_error)?;
        }
        self.require_ai_os_login()?;
        write.commit().map_err(db_error)?;
        Ok(FileLibraryImportResult {
            file: record,
            summary,
            status: "indexed",
        })
    }
}

#[cfg(unix)]
fn import_directory(
    pair: &RootPair,
    operation: &str,
    create: bool,
) -> Result<fs::File, VaultError> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let mut directory = root_fd(pair)?;
    for (i, name) in ["我的资料", operation].into_iter().enumerate() {
        let c = std::ffi::CString::new(name).unwrap();
        if create
            && unsafe { libc::mkdirat(directory.as_raw_fd(), c.as_ptr(), 0o700) } < 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(io::Error::last_os_error().into());
        }
        if create {
            directory.sync_all()?;
        }
        directory = managed_open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
            .map_err(|_| VaultError::Escape("unsafe import directory".into()))?;
        let meta = directory.metadata()?;
        if meta.uid() != unsafe { libc::geteuid() }
            || !meta.is_dir()
            || meta.mode() & (if i == 0 { 0o022 } else { 0o077 }) != 0
        {
            return Err(VaultError::Escape(
                "unsafe import directory permissions".into(),
            ));
        }
    }
    Ok(directory)
}

#[cfg(unix)]
fn existing_copy(
    directory: &fs::File,
    name: &str,
    size: u64,
    digest: &str,
) -> Result<Option<fs::Metadata>, VaultError> {
    use std::os::unix::fs::MetadataExt;
    for entry in names(directory)? {
        if entry != name
            && !(entry.starts_with(".part-")
                && entry.len() == 38
                && entry[6..].bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(VaultError::InvalidParams(
                "import operation directory already contains different input".into(),
            ));
        }
    }
    let mut file = match managed_open_at(directory, name, libc::O_RDONLY, 0) {
        Ok(file) => file,
        Err(ManagedReadError::NotFound) => return Ok(None),
        Err(_) => return Err(VaultError::Escape("unsafe imported file".into())),
    };
    let before = secure_metadata(&file, false)?;
    if before.len() != size {
        return Err(VaultError::InvalidParams(
            "imported copy differs from this request".into(),
        ));
    }
    let mut hash = Sha256::new();
    let mut read = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        read += length as u64;
        if read > MAX_BINARY_FILE_SIZE {
            return Err(VaultError::TooLarge);
        }
        hash.update(&buffer[..length]);
    }
    let after = secure_metadata(&file, false)?;
    if read != size
        || format!("{:x}", hash.finalize()) != digest
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(VaultError::InvalidParams(
            "imported copy changed; refusing to overwrite".into(),
        ));
    }
    Ok(Some(after))
}

#[cfg(unix)]
fn publish_copy(
    vault: &Vault,
    directory: &fs::File,
    name: &str,
    bytes: &[u8],
    digest: &str,
) -> Result<fs::Metadata, VaultError> {
    use std::{io::Write, os::fd::AsRawFd};
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(db_error)?;
    let temp = format!(
        ".part-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let source = std::ffi::CString::new(temp.as_str()).unwrap();
    let target = std::ffi::CString::new(name).unwrap();
    let result: Result<(), VaultError> = (|| {
        let mut file = managed_open_at(
            directory,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .map_err(db_error)?;
        for chunk in bytes.chunks(64 * 1024) {
            vault.require_ai_os_login()?;
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        vault.require_ai_os_login()?;
        if unsafe {
            libc::linkat(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                target.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    })();
    // Only this request's random staging file is removed, never a published copy.
    let cleanup = unsafe { libc::unlinkat(directory.as_raw_fd(), source.as_ptr(), 0) };
    result?;
    if cleanup != 0 {
        return Err(io::Error::last_os_error().into());
    }
    directory.sync_all()?;
    existing_copy(directory, name, bytes.len() as u64, digest)?
        .ok_or_else(|| VaultError::NotFound("published import missing".into()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn setup() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(dir.path()).unwrap();
        (dir, vault)
    }
    fn input(vault: &Vault, id: char, name: &str, bytes: &[u8]) -> FileLibraryImportInput {
        let pair = vault.inner.root.read().unwrap();
        FileLibraryImportInput {
            library_id: library_identity(pair.as_ref().unwrap()),
            operation_id: id.to_string().repeat(32),
            name: name.into(),
            data_base64: BASE64.encode(bytes),
        }
    }
    #[test]
    fn import_is_indexed_without_scanning_other_home_files_and_replay_is_idempotent() {
        let (dir, vault) = setup();
        fs::write(dir.path().join("unselected.txt"), "not indexed").unwrap();
        let saved = vault
            .file_library_import("user", input(&vault, 'a', "receipt.pdf", b"%PDF-test"))
            .unwrap();
        assert_eq!(saved.summary.total, 1);
        assert_eq!(saved.summary.coverage, FileIndexCoverage::Imports);
        assert_eq!(saved.file.category, FileCategory::Documents);
        assert_eq!(saved.file.file_id, Some("a".repeat(32)));
        assert_eq!(saved.file.original_path, "receipt.pdf");
        assert_eq!(
            fs::read(dir.path().join(&saved.file.path)).unwrap(),
            b"%PDF-test"
        );
        let again = vault
            .file_library_import("user", input(&vault, 'a', "receipt.pdf", b"%PDF-test"))
            .unwrap();
        assert_eq!(again.summary.total, 1);
        assert_eq!(again.file.path, saved.file.path);
        assert_eq!(
            vault
                .file_index_query("user", FileIndexFilter::default())
                .unwrap()
                .items
                .len(),
            1
        );
        let audit = fs::read_to_string(dir.path().join(AUDIT_FILE_NAME)).unwrap();
        assert!(!audit.contains("receipt.pdf") && !audit.contains("%PDF-test"));
    }
    #[test]
    fn separate_imports_keep_sources_and_full_refresh_preserves_identity_and_tags() {
        let (dir, vault) = setup();
        let first = vault
            .file_library_import(
                "user",
                input(&vault, 'a', "a.png", b"\x89PNG\r\n\x1a\nexample"),
            )
            .unwrap();
        vault
            .photo_tags_set(
                "user",
                &first.file.path,
                &first.file.sha256,
                vec![PhotoTag {
                    kind: PhotoTagKind::Event,
                    value: "birthday".into(),
                }],
            )
            .unwrap();
        vault
            .file_library_import(
                "user",
                input(&vault, 'b', "b.png", b"\x89PNG\r\n\x1a\nexample"),
            )
            .unwrap();
        vault.file_index_refresh("user").unwrap();
        drop(vault);
        let reopened = Vault::new();
        reopened.set_root(dir.path()).unwrap();
        let photos = reopened
            .photo_library_query("user", PhotoLibraryFilter::default())
            .unwrap();
        assert_eq!(photos.total, 2);
        assert_eq!(
            photos.items.iter().filter(|i| !i.tags.is_empty()).count(),
            1
        );
        let saved = photos
            .items
            .iter()
            .find(|i| i.file.path == first.file.path)
            .unwrap();
        assert_eq!(saved.file.file_id, first.file.file_id);
        assert_eq!(saved.file.original_path, "a.png");
    }
    #[test]
    fn conflicting_replay_and_user_changes_are_never_overwritten_or_restored() {
        let (dir, vault) = setup();
        let saved = vault
            .file_library_import("user", input(&vault, 'a', "note.txt", b"hello"))
            .unwrap();
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "note.txt", b"different"))
            .is_err());
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "other.txt", b"hello"))
            .is_err());
        fs::write(dir.path().join(&saved.file.path), b"changed").unwrap();
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "note.txt", b"hello"))
            .is_err());
        assert_eq!(
            fs::read(dir.path().join(&saved.file.path)).unwrap(),
            b"changed"
        );
        fs::remove_file(dir.path().join(&saved.file.path)).unwrap();
        vault.file_index_refresh("user").unwrap();
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "note.txt", b"hello"))
            .is_err());
        assert!(!dir.path().join(&saved.file.path).exists());
    }
    #[test]
    fn import_rejects_escapes_private_names_bad_ids_and_non_user_sessions_before_publication() {
        let (dir, vault) = setup();
        for name in [
            "../escape.txt",
            "a/b.txt",
            "a\\b.txt",
            ".env",
            "accounts.json",
            "data.sqlite",
            "bad\nname",
            " ",
        ] {
            assert!(
                vault
                    .file_library_import("user", input(&vault, 'a', name, b"test"))
                    .is_err(),
                "{name}"
            );
        }
        assert!(vault
            .file_library_import("user", input(&vault, 'z', "a.txt", b"test"))
            .is_err());
        assert!(vault
            .file_library_import("agent", input(&vault, 'a', "a.txt", b"test"))
            .is_err());
        assert!(!dir.path().join("我的资料").exists());
        let mut invalid = input(&vault, 'a', "a.txt", b"test");
        invalid.data_base64 = "%%%".into();
        assert!(vault.file_library_import("user", invalid).is_err());
    }
    #[test]
    fn import_rejects_directory_symlinks_and_hardlinked_existing_copies() {
        let (dir, vault) = setup();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join("我的资料")).unwrap();
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "a.txt", b"test"))
            .is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(dir.path().join("我的资料")).unwrap();
        let saved = vault
            .file_library_import("user", input(&vault, 'a', "a.txt", b"test"))
            .unwrap();
        fs::hard_link(
            dir.path().join(saved.file.path),
            outside.path().join("alias"),
        )
        .unwrap();
        assert!(vault
            .file_library_import("user", input(&vault, 'a', "a.txt", b"test"))
            .is_err());
    }
    #[test]
    fn retry_recovers_published_copy_without_a_receipt() {
        let (dir, vault) = setup();
        let parent = dir.path().join("我的资料").join("a".repeat(32));
        fs::create_dir_all(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let path = parent.join("note.txt");
        fs::write(&path, b"hello").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let saved = vault
            .file_library_import("user", input(&vault, 'a', "note.txt", b"hello"))
            .unwrap();
        assert_eq!(saved.summary.total, 1);
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    }
    #[test]
    fn locked_home_rejects_import_without_creating_the_library() {
        let (dir, vault) = setup();
        let state = tempfile::tempdir().unwrap();
        vault
            .enable_ai_os_login(
                &fs::canonicalize(state.path())
                    .unwrap()
                    .join(".jiaho-onboarding"),
            )
            .unwrap();
        assert!(matches!(
            vault.file_library_import("user", input(&vault, 'a', "a.txt", b"test")),
            Err(VaultError::AuthRequired)
        ));
        assert!(!dir.path().join("我的资料").exists());
    }
    #[test]
    fn switching_home_rejects_a_previous_batch_before_any_publication() {
        let (first, vault) = setup();
        let request = input(&vault, 'a', "note.txt", b"hello");
        let first_id = request.library_id.clone();
        assert_eq!(
            vault
                .file_index_query("user", FileIndexFilter::default())
                .unwrap()
                .summary
                .library_id,
            first_id
        );
        let second = tempfile::tempdir().unwrap();
        vault.set_root(second.path()).unwrap();
        let second_id = vault
            .file_index_query("user", FileIndexFilter::default())
            .unwrap()
            .summary
            .library_id;
        assert_ne!(first_id, second_id);
        assert!(matches!(
            vault.file_library_import("user", request),
            Err(VaultError::InvalidParams(_))
        ));
        assert!(!first.path().join("我的资料").exists());
        assert!(!second.path().join("我的资料").exists());
        assert!(!second.path().join(".depdek-file-index").exists());
    }
}
