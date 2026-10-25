//! User-authored household notes. No device observations or model context.
use super::*;

const FAMILY_INFO: TableDefinition<&str, &str> = TableDefinition::new("family_scene_notes_v1");

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FamilyScene {
    Security,
    Health,
    Home,
}
impl FamilyScene {
    fn key(self) -> &'static str {
        match self {
            Self::Security => "security",
            Self::Health => "health",
            Self::Home => "home",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilySceneNote {
    pub scene: FamilyScene,
    pub note: String,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Serialize)]
pub struct FamilyInfoState {
    pub library_id: String,
    pub notes: Vec<FamilySceneNote>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FamilyInfoInput {
    pub library_id: String,
    pub scene: FamilyScene,
    pub note: String,
    pub expected_revision: u64,
}
fn valid_note(note: &str) -> bool {
    note.chars().count() <= 4000
        && !note
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}
impl Vault {
    pub fn family_info_state(&self, session: &str) -> Result<FamilyInfoState, VaultError> {
        self.file_index_audited(session, Op::Read, "family-info/state", || {
            let pair = self.root_pair()?;
            let mut notes = Vec::new();
            if let Some(db) = open_index(&pair, false)? {
                let txn = db.begin_read().map_err(db_error)?;
                match txn.open_table(FAMILY_INFO) {
                    Ok(table) => {
                        for row in table.iter().map_err(db_error)? {
                            let (key, value) = row.map_err(db_error)?;
                            let note: FamilySceneNote = serde_json::from_str(value.value())
                                .map_err(|_| db_error("invalid family note"))?;
                            if notes.len() >= 3
                                || note.scene.key() != key.value()
                                || note.revision == 0
                                || !valid_note(&note.note)
                            {
                                return Err(db_error("invalid family note"));
                            }
                            notes.push(note);
                        }
                    }
                    Err(redb::TableError::TableDoesNotExist(_)) => (),
                    Err(error) => return Err(db_error(error)),
                };
            }
            Ok(FamilyInfoState {
                library_id: library_identity(&pair),
                notes,
            })
        })
    }
    pub fn family_info_put(
        &self,
        session: &str,
        input: FamilyInfoInput,
    ) -> Result<FamilySceneNote, VaultError> {
        self.file_index_audited(session, Op::Write, "family-info/put", || {
            if !valid_note(&input.note) {
                return Err(VaultError::InvalidParams("invalid family note".into()));
            }
            let pair = self.root_pair()?;
            if input.library_id != library_identity(&pair) {
                return Err(VaultError::InvalidParams(
                    "Home changed; reopen family information".into(),
                ));
            }
            let db = open_index(&pair, true)?.ok_or_else(|| db_error("missing index"))?;
            let txn = db.begin_write().map_err(db_error)?;
            let record;
            {
                let mut table = txn.open_table(FAMILY_INFO).map_err(db_error)?;
                let previous = table
                    .get(input.scene.key())
                    .map_err(db_error)?
                    .map(|value| serde_json::from_str::<FamilySceneNote>(value.value()))
                    .transpose()
                    .map_err(|_| db_error("invalid family note"))?;
                if previous.as_ref().is_some_and(|note| {
                    note.scene != input.scene || note.revision == 0 || !valid_note(&note.note)
                }) {
                    return Err(db_error("invalid family note"));
                }
                let revision = previous.as_ref().map_or(0, |value| value.revision);
                if input.expected_revision != revision {
                    return Err(VaultError::InvalidParams(
                        "family note revision conflict".into(),
                    ));
                }
                record = FamilySceneNote {
                    scene: input.scene,
                    note: input.note.trim().to_owned(),
                    revision: revision.checked_add(1).ok_or(VaultError::TooLarge)?,
                    updated_at_ms: now_ms(),
                };
                let value = serde_json::to_string(&record).map_err(json_error)?;
                table
                    .insert(input.scene.key(), value.as_str())
                    .map_err(db_error)?;
            }
            txn.commit().map_err(db_error)?;
            Ok(record)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn put(
        vault: &Vault,
        library: &str,
        revision: u64,
        text: &str,
    ) -> Result<FamilySceneNote, VaultError> {
        vault.family_info_put(
            "user",
            FamilyInfoInput {
                library_id: library.into(),
                scene: FamilyScene::Home,
                note: text.into(),
                expected_revision: revision,
            },
        )
    }
    #[test]
    fn notes_survive_restart_and_reindex_with_atomic_revision_and_clear() {
        let root = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(root.path()).unwrap();
        let library = vault.family_info_state("user").unwrap().library_id;
        assert!(vault.family_info_state("user").unwrap().notes.is_empty());
        assert_eq!(
            put(&vault, &library, 0, "滤网更换记录\n下次由用户安排")
                .unwrap()
                .revision,
            1
        );
        assert!(put(&vault, &library, 0, "stale").is_err());
        vault.file_index_refresh("user").unwrap();
        drop(vault);
        let vault = Vault::new();
        vault.set_root(root.path()).unwrap();
        let state = vault.family_info_state("user").unwrap();
        assert_eq!(state.notes[0].note, "滤网更换记录\n下次由用户安排");
        assert_eq!(put(&vault, &library, 1, "").unwrap().revision, 2);
        assert_eq!(vault.family_info_state("user").unwrap().notes[0].note, "");
    }
    #[test]
    fn home_user_bounds_and_audit_do_not_expose_notes() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(a.path()).unwrap();
        let library = vault.family_info_state("user").unwrap().library_id;
        assert!(vault.family_info_state("agent-1").is_err());
        assert!(put(&vault, &library, 0, &"x".repeat(4001)).is_err());
        assert!(put(&vault, &library, 0, "bad\0record").is_err());
        put(&vault, &library, 0, "PRIVATE_FAMILY_NOTE").unwrap();
        vault.set_root(b.path()).unwrap();
        assert!(put(&vault, &library, 1, "wrong space").is_err());
        assert!(vault.family_info_state("user").unwrap().notes.is_empty());
        let audit = fs::read_to_string(a.path().join(".vault-audit.jsonl")).unwrap();
        assert!(audit.contains("family-info/put") && audit.contains("\"ok\":false"));
        assert!(!audit.contains("PRIVATE_FAMILY_NOTE") && !audit.contains("bad\\u0000"));
    }
    #[cfg(unix)]
    #[test]
    fn private_database_symlink_escape_is_denied() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(root.path()).unwrap();
        let library = vault.family_info_state("user").unwrap().library_id;
        std::os::unix::fs::symlink(outside.path(), root.path().join(PRIVATE)).unwrap();
        assert!(put(&vault, &library, 0, "blocked").is_err());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
