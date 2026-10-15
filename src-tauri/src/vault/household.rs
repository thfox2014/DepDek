//! Private family domain store. IO/identity/authorization stays inside Vault.
use super::*;
use crate::secrets::SecretText;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HouseholdRequest {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    command: String,
    input: Value,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    format: u32,
    workspace_id:String,
    sources: Vec<Source>,
    items: Vec<Item>,
    packages: Vec<Package>,
    tasks: Vec<Task>,
    operations: BTreeMap<String, (String, Value)>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    owner: String,
    filename: String,
    sha256: String,
    content_base64: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assertion {
    id: String,
    field: String,
    value: String,
    source_id: String,
    evidence: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    id: String,
    owner: String,
    name: String,
    revision: u64,
    sources: Vec<String>,
    assertions: Vec<Assertion>,
    selected: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    id: String,
    owner: String,
    item_id: String,
    item_revision: u64,
    markdown: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    id: String,
    owner: String,
    package_id: String,
    title: String,
    completed: bool,
}
pub(super) struct HouseholdStore {
    directory: fs::File,
    _lock: fs::File,
    state: State,
}
fn error<T>(_: T) -> AccessError {
    AccessError::Unavailable
}
fn text(v: &str, max: usize) -> bool {
    !v.trim().is_empty()
        && v.len() <= max
        && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn id(prefix: &str) -> Result<String, AccessError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(error)?;
    Ok(format!(
        "{prefix}_{}",
        b.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, AccessError> {
    serde_json::from_value(v).map_err(|_| AccessError::Invalid)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    #[serde(rename = "operation_id")]
    _operation_id: String,
    filename: String,
    content_base64: String,
    name: String,
    #[serde(default)]
    item_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assert {
    #[serde(rename = "operation_id")]
    _operation_id: String,
    item_id: String,
    expected_revision: u64,
    source_id: String,
    field: String,
    value: String,
    evidence: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirm {
    #[serde(rename = "operation_id")]
    _operation_id: String,
    item_id: String,
    expected_revision: u64,
    assertion_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepare {
    #[serde(rename = "operation_id")]
    _operation_id: String,
    item_id: String,
    expected_revision: u64,
    apply: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Get {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Complete {
    #[serde(rename = "operation_id")]
    _operation_id: String,
    id: String,
    completed: bool,
}

impl ManagedReadVault {
    pub fn configure_household(&self) -> Result<(), AccessError> {
        let mut slot = self.household.lock().map_err(error)?;
        if slot.is_some() {
            return Err(AccessError::Conflict);
        }
        self.profile_audit(
            "household-startup",
            "household.open.intent",
            &Ok::<_, ManagedReadError>(()),
        )
        .map_err(AccessError::from)?;
        let name = std::ffi::CString::new(".household").unwrap();
        if unsafe { libc::mkdirat(self.root.as_raw_fd(), name.as_ptr(), 0o700) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(AccessError::Unavailable);
        }
        let directory = managed_open_at(
            &self.root,
            ".household",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
        .map_err(AccessError::from)?;
        private_directory_meta(&directory.metadata().map_err(error)?).map_err(error)?;
        let lock =
            private_open(&directory, "writer.lock", libc::O_RDWR | libc::O_CREAT).map_err(error)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(AccessError::Conflict);
        }
        let state = match managed_open_at(&directory, "state.json", libc::O_RDONLY, 0) {
            Err(ManagedReadError::NotFound) => State {
                format: 1,
                workspace_id:self.workspace_id.clone(),
                ..State::default()
            },
            Err(e) => return Err(e.into()),
            Ok(file) => {
                private_file_meta(&file.metadata().map_err(error)?).map_err(error)?;
                let mut bytes = Vec::new();
                file.take((LIMIT + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(error)?;
                if bytes.len() > LIMIT {
                    return Err(AccessError::Limited);
                }
                let state: State = serde_json::from_slice(&bytes).map_err(error)?;
                validate_state(&state)?;
                if state.workspace_id!=self.workspace_id {return Err(AccessError::Forbidden);}
                state
            }
        };
        directory.sync_all().map_err(error)?;
        self.root.sync_all().map_err(error)?;
        *slot = Some(HouseholdStore {
            directory,
            _lock: lock,
            state,
        });
        Ok(())
    }
    pub fn household_command(
        &self,
        request: &str,
        input: HouseholdRequest,
    ) -> Result<Value, AccessError> {
        let mut access = self.access.lock().map_err(error)?;
        let result = (|| {
            let parent = access::token_id(&input.session_token)?;
            let actor = access::checked_session(&access, &parent, Some(&input.csrf_token))?
                .principal
                .clone();
            if input.workspace_id != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            let mut slot = self.household.lock().map_err(error)?;
            let store = slot.as_mut().ok_or(AccessError::Unavailable)?;
            private_directory_meta(&store.directory.metadata().map_err(error)?).map_err(error)?;
            let command = input.command.as_str();
            let mut next = store.state.clone();
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&json!([command, input.input])).map_err(error)?)
            );
            let operation = input.input.get("operation_id").and_then(Value::as_str);
            let key = operation
                .map(|op| serde_json::to_string(&(&actor, op)))
                .transpose()
                .map_err(error)?;
            if let (Some(op), Some(key)) = (operation, key.as_ref()) {
                if !managed_id(op) {
                    return Err(AccessError::Invalid);
                }
                if let Some((old, receipt)) = next.operations.get(key) {
                    if old != &fingerprint {
                        return Err(AccessError::Conflict);
                    }
                    return Ok(receipt.clone());
                }
            }
            self.profile_audit(
                request,
                "household.command.intent",
                &Ok::<_, ManagedReadError>(()),
            )
            .map_err(AccessError::from)?;
            let mut writes = true;
            let output = match command {
                "list" if input.input == json!({}) => {
                    writes = false;
                    json!({"items":next.items.iter().filter(|i|i.owner==actor).collect::<Vec<_>>(),"packages":next.packages.iter().filter(|p|p.owner==actor).map(|p|package_public(&next,p)).collect::<Vec<_>>(),"tasks":next.tasks.iter().filter(|t|t.owner==actor).collect::<Vec<_>>(),"recognition":"manual-evidence"})
                }
                "import" => {
                    let i: Import = parse(input.input)?;
                    if !text(&i.name, 256)
                        || !text(&i.filename, 256)
                        || i.filename.contains(['/', '\\'])
                        || i.content_base64.len() > 32768
                    {
                        return Err(AccessError::Invalid);
                    }
                    let bytes = BASE64
                        .decode(&i.content_base64)
                        .map_err(|_| AccessError::Invalid)?;
                    if bytes.is_empty() || bytes.len() > 24576 {
                        return Err(AccessError::Limited);
                    }
                    if std::str::from_utf8(&bytes).is_err()
                        && !bytes.starts_with(b"%PDF-")
                        && !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                        && !bytes.starts_with(b"\xff\xd8\xff")
                    {
                        return Err(AccessError::Invalid);
                    }
                    let hash = format!("{:x}", Sha256::digest(&bytes));
                    let existing = next
                        .sources
                        .iter()
                        .find(|s| s.owner == actor && s.sha256 == hash)
                        .map(|s| s.id.clone());
                    let source_id = if let Some(old) = existing {
                        old
                    } else {
                        if next.sources.len() >= 64 {
                            return Err(AccessError::Limited);
                        }
                        let source = Source {
                            id: id("src")?,
                            owner: actor.clone(),
                            filename: i.filename,
                            sha256: hash,
                            content_base64: i.content_base64,
                        };
                        let result = source.id.clone();
                        next.sources.push(source);
                        result
                    };
                    let item = if let Some(item) = i.item_id {
                        next.items
                            .iter_mut()
                            .find(|o| o.id == item && o.owner == actor)
                            .ok_or(AccessError::NotFound)?
                    } else if let Some(index) = next.items.iter().position(|o| {
                        o.owner == actor && o.name == i.name && o.sources.contains(&source_id)
                    }) {
                        &mut next.items[index]
                    } else {
                        if next.items.len() >= 128 {
                            return Err(AccessError::Limited);
                        }
                        next.items.push(Item {
                            id: id("item")?,
                            owner: actor.clone(),
                            name: i.name,
                            revision: 1,
                            sources: vec![],
                            assertions: vec![],
                            selected: BTreeMap::new(),
                        });
                        next.items.last_mut().unwrap()
                    };
                    if !item.sources.contains(&source_id) {
                        item.sources.push(source_id.clone());
                        item.revision += 1;
                    }
                    json!({"source_id":source_id,"item":item,"recognition":"awaiting_manual_extraction"})
                }
                "assert" => {
                    let i: Assert = parse(input.input)?;
                    if !matches!(
                        i.field.as_str(),
                        "model" | "purchase_date" | "serial" | "location" | "warranty_until"
                    ) || !text(&i.value, 512)
                        || !text(&i.evidence, 512)
                    {
                        return Err(AccessError::Invalid);
                    }
                    if matches!(i.field.as_str(),"purchase_date"|"warranty_until") && !valid_date(&i.value) {return Err(AccessError::Invalid);}
                    let item = next
                        .items
                        .iter_mut()
                        .find(|o| o.id == i.item_id && o.owner == actor)
                        .ok_or(AccessError::NotFound)?;
                    if item.revision != i.expected_revision {
                        return Err(AccessError::Conflict);
                    }
                    if !item.sources.contains(&i.source_id) {
                        return Err(AccessError::NotFound);
                    }
                    if item.assertions.len() >= 128 {
                        return Err(AccessError::Limited);
                    }
                    item.selected.remove(&i.field);
                    item.assertions.push(Assertion {
                        id: id("as")?,
                        field: i.field,
                        value: i.value,
                        source_id: i.source_id,
                        evidence: i.evidence,
                    });
                    item.revision += 1;
                    json!({"item":item})
                }
                "confirm" => {
                    let i: Confirm = parse(input.input)?;
                    let item = next
                        .items
                        .iter_mut()
                        .find(|o| o.id == i.item_id && o.owner == actor)
                        .ok_or(AccessError::NotFound)?;
                    if item.revision != i.expected_revision {
                        return Err(AccessError::Conflict);
                    }
                    let a = item
                        .assertions
                        .iter()
                        .find(|a| a.id == i.assertion_id)
                        .ok_or(AccessError::NotFound)?;
                    item.selected.insert(a.field.clone(), a.id.clone());
                    item.revision += 1;
                    json!({"item":item})
                }
                "prepare" => {
                    let i: Prepare = parse(input.input)?;
                    let item = next
                        .items
                        .iter()
                        .find(|o| o.id == i.item_id && o.owner == actor)
                        .ok_or(AccessError::NotFound)?;
                    if item.revision != i.expected_revision {
                        return Err(AccessError::Conflict);
                    }
                    let markdown = render_package(&next, item);
                    let plan = json!({"item_id":item.id,"revision":item.revision,"markdown":markdown,"effects":["创建本地维修资料包","创建本领域维修待办"],"external_send":false});
                    if !i.apply {
                        writes = false;
                        json!({"status":"preview","plan":plan})
                    } else {
                        if next.packages.len() >= 256 {
                            return Err(AccessError::Limited);
                        }
                        let p = Package {
                            id: id("pack")?,
                            owner: actor.clone(),
                            item_id: item.id.clone(),
                            item_revision: item.revision,
                            markdown,
                        };
                        let task = Task {
                            id: id("todo")?,
                            owner: actor.clone(),
                            package_id: p.id.clone(),
                            title: format!("核对并准备 {} 维修", item.name),
                            completed: false,
                        };
                        let result = json!({"status":"completed","package_id":p.id,"task_id":task.id,"plan":plan});
                        next.packages.push(p);
                        next.tasks.push(task);
                        result
                    }
                }
                "get" => {
                    writes = false;
                    let i: Get = parse(input.input)?;
                    if let Some(s) = next
                        .sources
                        .iter()
                        .find(|s| s.id == i.id && s.owner == actor)
                    {
                        json!({"source":s})
                    } else if let Some(p) = next
                        .packages
                        .iter()
                        .find(|p| p.id == i.id && p.owner == actor)
                    {
                        package_public(&next, p)
                    } else {
                        return Err(AccessError::NotFound);
                    }
                }
                "complete" => {
                    let i: Complete = parse(input.input)?;
                    let task = next
                        .tasks
                        .iter_mut()
                        .find(|t| t.id == i.id && t.owner == actor)
                        .ok_or(AccessError::NotFound)?;
                    task.completed = i.completed;
                    json!({"task":task})
                }
                _ => return Err(AccessError::Invalid),
            };
            if writes {
                let key = key.ok_or(AccessError::Invalid)?;
                if next.operations.len() >= 512 {
                    return Err(AccessError::Limited);
                }
                next.operations.insert(key, (fingerprint, output.clone()));
                validate_state(&next)?;
                if let Err(error) = store.save(&next) {
                    *slot = None;
                    return Err(error);
                }
                store.state = next;
            }
            access::checked_session(&access, &parent, Some(&input.csrf_token))?;
            access.sessions.get_mut(&parent).unwrap().last_seen = std::time::Instant::now();
            Ok(output)
        })();
        self.profile_audit(
            request,
            "household.command.result",
            &result
                .as_ref()
                .map(|_| ())
                .map_err(|_| ManagedReadError::Forbidden),
        )
        .map_err(AccessError::from)?;
        result
    }
}
impl HouseholdStore {
    fn save(&self, state: &State) -> Result<(), AccessError> {
        let bytes = serde_json::to_vec(state).map_err(error)?;
        if bytes.len() > LIMIT {
            return Err(AccessError::Limited);
        }
        match managed_open_at(&self.directory, "state.json", libc::O_RDONLY, 0) {
            Ok(f) => private_file_meta(&f.metadata().map_err(error)?).map_err(error)?,
            Err(ManagedReadError::NotFound) => (),
            Err(e) => return Err(e.into()),
        }
        let stage = format!(".stage-{}", id("state")?);
        let mut file = private_open(
            &self.directory,
            &stage,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .map_err(error)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(error)?;
        let src = std::ffi::CString::new(stage).unwrap();
        let dst = std::ffi::CString::new("state.json").unwrap();
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                src.as_ptr(),
                self.directory.as_raw_fd(),
                dst.as_ptr(),
            )
        } != 0
        {
            return Err(AccessError::Unavailable);
        }
        self.directory
            .sync_all()
            .map_err(|_| AccessError::Credential(crate::secrets::SecretError::CommitUnknown))
    }
}
fn validate_state(s: &State) -> Result<(), AccessError> {
    if s.format != 1 || !managed_id(&s.workspace_id)
        || s.sources.len() > 64
        || s.items.len() > 128
        || s.packages.len() > 256
        || s.operations.len() > 512
    {
        return Err(AccessError::Unavailable);
    }
    for src in &s.sources {
        let bytes = BASE64.decode(&src.content_base64).map_err(error)?;
        if bytes.len() > 24576 || format!("{:x}", Sha256::digest(bytes)) != src.sha256 {
            return Err(AccessError::Unavailable);
        }
    }
    for i in &s.items {
        if i.revision == 0
            || i.assertions.len() > 128
            || i.sources.iter().any(|id| {
                !s.sources
                    .iter()
                    .any(|src| &src.id == id && src.owner == i.owner)
            })
            || i.assertions
                .iter()
                .any(|a| !i.sources.contains(&a.source_id))
            || i.selected
                .iter()
                .any(|(f, id)| !i.assertions.iter().any(|a| &a.id == id && &a.field == f))
        {
            return Err(AccessError::Unavailable);
        }
    }
    Ok(())
}

fn valid_date(date:&str)->bool {
    if date.len()!=10 {return false;}
    let parts=date.split('-').collect::<Vec<_>>();
    if parts.len()!=3 || parts[0].len()!=4 || parts[1].len()!=2 || parts[2].len()!=2 {return false;}
    let Ok(y)=parts[0].parse::<u32>() else{return false};let Ok(m)=parts[1].parse::<u32>() else{return false};let Ok(d)=parts[2].parse::<u32>() else{return false};
    let leap=y%4==0 && (y%100!=0 || y%400==0);
    let days=match m{1|3|5|7|8|10|12=>31,4|6|9|11=>30,2=>if leap{29}else{28},_=>0};y>=1 && d>=1 && d<=days
}
fn package_public(s: &State, p: &Package) -> Value {
    json!({"id":p.id,"item_id":p.item_id,"item_revision":p.item_revision,"markdown":p.markdown,"stale":!s.items.iter().any(|i|i.id==p.item_id && i.revision==p.item_revision)})
}
fn render_package(s: &State, i: &Item) -> String {
    let mut out = format!(
        "# {} · 维修资料包\n\n仅准备资料，不自动联系售后。\n\n## 已确认事实\n",
        i.name
    );
    for (field, label) in [
        ("model", "型号"),
        ("purchase_date", "购买日期"),
        ("serial", "序列号"),
        ("location", "位置"),
        ("warranty_until", "保修截止"),
    ] {
        if let Some(a) = i
            .selected
            .get(field)
            .and_then(|id| i.assertions.iter().find(|a| &a.id == id))
        {
            out.push_str(&format!(
                "- {label}：{}（证据 {}，{}）\n",
                a.value, a.source_id, a.evidence
            ));
        } else {
            out.push_str(&format!("- {label}：**未知 / 待确认**\n"));
        }
    }
    out.push_str("\n## 所有断言（冲突不覆盖）\n");
    for a in &i.assertions {
        out.push_str(&format!(
            "- {}：{} · 来源 {} · {}{}\n",
            a.field,
            a.value,
            a.source_id,
            a.evidence,
            if i.selected.get(&a.field) == Some(&a.id) {
                " · 已确认"
            } else {
                " · 未采纳"
            }
        ));
    }
    out.push_str("\n## 原件清单\n");
    for src in s.sources.iter().filter(|src| i.sources.contains(&src.id)) {
        out.push_str(&format!(
            "- {} · `{}` · SHA256 `{}`\n",
            src.filename, src.id, src.sha256
        ));
    }
    out.push_str("\n## 用途与下一步\n- 用途：保修/维修前核对凭证；保修资格尚需条款确认。\n- 补齐未知项，核对未采纳断言，再联系售后。\n- 联系草稿：您好，我想咨询上述设备的维修流程，资料已准备，烦请告知需要补充的材料。\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{hash_business_password, AccessUser, LoginInput, Vault};
    use std::os::unix::fs::{symlink, PermissionsExt};
    const PASS: &str = "SYNTHETIC_FAMILY_PASSWORD";
    fn open(root: &Path) -> ManagedReadVault {
        let v = ManagedReadVault::open(root, "w1", "local:test", &["documents".into()]).unwrap();
        static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let hash =
            HASH.get_or_init(|| hash_business_password(SecretText::new(PASS.into())).unwrap());
        v.configure_access(
            ["alice", "bob"]
                .iter()
                .map(|id| AccessUser {
                    principal_id: (*id).into(),
                    password_hash: hash.clone(),
                    read_paths: vec!["documents".into()],
                })
                .collect(),
        )
        .unwrap();
        v
    }
    fn login(v: &ManagedReadVault, who: &str) -> Value {
        v.login_business(
            "login",
            LoginInput {
                username: who.into(),
                password: SecretText::new(PASS.into()),
            },
        )
        .unwrap()
    }
    fn call(
        v: &ManagedReadVault,
        s: &Value,
        command: &str,
        input: Value,
    ) -> Result<Value, AccessError> {
        v.household_command("test",serde_json::from_value(json!({"session_token":s["session_token"],"csrf_token":s["csrf_token"],"workspace_id":"w1","command":command,"input":input})).unwrap())
    }
    fn imported() -> Value {
        json!({"operation_id":"import-1","name":"合成客厅空调","filename":"发票.txt","content_base64":BASE64.encode("合成凭证：购买日 2026-01-01；型号 TEST-AC")})
    }
    #[test]
    fn receipt_to_conflict_confirmation_package_todo_export_dedupe_privacy_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("documents")).unwrap();
        let v = open(temp.path());
        v.configure_household().unwrap();
        let alice = login(&v, "alice");
        let bob = login(&v, "bob");
        let first = call(&v, &alice, "import", imported()).unwrap();
        assert_eq!(first, call(&v, &alice, "import", imported()).unwrap());
        let mut duplicate = imported();
        duplicate["operation_id"] = json!("import-again");
        assert_eq!(
            first["item"]["id"],
            call(&v, &alice, "import", duplicate).unwrap()["item"]["id"]
        );
        let item = first["item"]["id"].clone();
        let source = first["source_id"].clone();
        let mut revision = first["item"]["revision"].as_u64().unwrap();
        let mut candidates = Vec::new();
        for (operation, date) in [("a1", "2026-01-01"), ("a2", "2026-01-02")] {
            let r=call(&v,&alice,"assert",json!({"operation_id":operation,"item_id":item,"expected_revision":revision,"source_id":source,"field":"purchase_date","value":date,"evidence":"第1行人工核对"})).unwrap();
            revision = r["item"]["revision"].as_u64().unwrap();
            candidates = r["item"]["assertions"].as_array().unwrap().clone();
        }
        assert_eq!(candidates.len(), 2);
        let r=call(&v,&alice,"confirm",json!({"operation_id":"confirm","item_id":item,"expected_revision":revision,"assertion_id":candidates[0]["id"]})).unwrap();
        revision = r["item"]["revision"].as_u64().unwrap();
        let mut prepare = json!({"operation_id":"prepare","item_id":item,"expected_revision":revision,"apply":false});
        let preview = call(&v, &alice, "prepare", prepare.clone()).unwrap();
        assert_eq!(preview["status"], "preview");
        assert!(call(&v, &alice, "list", json!({})).unwrap()["tasks"]
            .as_array()
            .unwrap()
            .is_empty());
        prepare["apply"] = json!(true);
        let receipt = call(&v, &alice, "prepare", prepare.clone()).unwrap();
        assert_eq!(
            receipt,
            call(&v, &alice, "prepare", prepare.clone()).unwrap()
        );
        let state = call(&v, &alice, "list", json!({})).unwrap();
        assert_eq!(state["sources"].as_array().map(Vec::len), None);
        assert_eq!(state["items"].as_array().unwrap().len(), 1);
        assert_eq!(state["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(
            call(&v, &alice, "get", json!({"id":source})).unwrap()["source"]["content_base64"],
            imported()["content_base64"]
        );
        let pack = call(&v, &alice, "get", json!({"id":receipt["package_id"]})).unwrap();
        let markdown = pack["markdown"].as_str().unwrap();
        assert!(
            markdown.contains("2026-01-01")
                && markdown.contains("2026-01-02")
                && markdown.contains("未知")
                && markdown.contains("SHA256")
        );
        assert_eq!(pack["stale"], false);
        assert!(matches!(
            call(&v, &bob, "get", json!({"id":source})),
            Err(AccessError::NotFound)
        ));
        assert!(call(&v, &bob, "list", json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        call(&v,&alice,"assert",json!({"operation_id":"correction","item_id":item,"expected_revision":revision,"source_id":source,"field":"model","value":"CORRECTED","evidence":"原件第2行"})).unwrap();
        assert_eq!(
            call(&v, &alice, "get", json!({"id":receipt["package_id"]})).unwrap()["stale"],
            true
        );
        call(
            &v,
            &alice,
            "complete",
            json!({"operation_id":"done","id":receipt["task_id"],"completed":true}),
        )
        .unwrap();
        drop(v);
        let v = open(temp.path());
        v.configure_household().unwrap();
        let alice = login(&v, "alice");
        assert_eq!(call(&v, &alice, "prepare", prepare).unwrap(), receipt);
        assert_eq!(
            call(&v, &alice, "list", json!({})).unwrap()["tasks"][0]["completed"],
            true
        );
        let audit = fs::read_to_string(temp.path().join(AUDIT_FILE_NAME)).unwrap();
        for secret in [
            "合成客厅空调",
            "2026-01-01",
            "CORRECTED",
            PASS,
            alice["session_token"].as_str().unwrap(),
        ] {
            assert!(!audit.contains(secret));
        }
    }
    #[test]
    fn internal_state_rejects_symlink_hardlink_public_modes_second_writer_and_legacy_alias() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("documents")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join(".household")).unwrap();
        let v = open(temp.path());
        assert!(v.configure_household().is_err());
        fs::remove_file(temp.path().join(".household")).unwrap();
        v.configure_household().unwrap();
        let second = open(temp.path());
        assert!(second.configure_household().is_err());
        let alice = login(&v, "alice");
        call(&v, &alice, "import", imported()).unwrap();
        symlink(temp.path().join(".household"), temp.path().join("alias")).unwrap();
        let legacy = Vault::new();
        legacy.set_root(temp.path()).unwrap();
        assert!(legacy.read_file("user", "alias/state.json").is_err());
        assert!(legacy
            .write_file("user", "alias/new.json", "unsafe")
            .is_err());
        assert!(!legacy
            .list_dir("user", ".")
            .unwrap()
            .entries
            .iter()
            .any(|e| e.name == ".household"));
        fs::rename(
            temp.path().join(".household/state.json"),
            temp.path().join(".household/original.json"),
        )
        .unwrap();
        symlink(
            outside.path().join("missing"),
            temp.path().join(".household/state.json"),
        )
        .unwrap();
        let mut input = imported();
        input["operation_id"] = json!("next");
        assert!(call(&v, &alice, "import", input).is_err());
        assert!(call(&v, &alice, "list", json!({})).is_err());
        assert!(!outside.path().join("missing").exists());
        fs::remove_file(temp.path().join(".household/state.json")).unwrap();
        fs::rename(
            temp.path().join(".household/original.json"),
            temp.path().join(".household/state.json"),
        )
        .unwrap();
        drop(v);
        drop(second);
        fs::set_permissions(
            temp.path().join(".household/state.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let v = open(temp.path());
        assert!(v.configure_household().is_err());
    }
    #[test]
    fn malformed_actor_csrf_replay_change_and_failed_audit_never_write() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("documents")).unwrap();
        let v = open(temp.path());
        v.configure_household().unwrap();
        let alice = login(&v, "alice");
        let mut forged = json!({"session_token":alice["session_token"],"csrf_token":alice["csrf_token"],"workspace_id":"w1","command":"list","input":{},"actor":"bob"});
        assert!(serde_json::from_value::<HouseholdRequest>(forged.take()).is_err());
        let mut bad = alice.clone();
        bad["csrf_token"] = json!("forged");
        assert!(matches!(
            call(&v, &bad, "import", imported()),
            Err(AccessError::Forbidden)
        ));
        call(&v, &alice, "import", imported()).unwrap();
        let mut changed = imported();
        changed["name"] = json!("changed");
        assert!(matches!(
            call(&v, &alice, "import", changed),
            Err(AccessError::Conflict)
        ));
        let log = fs::File::open(temp.path().join(AUDIT_FILE_NAME)).unwrap();
        v.audit.set_file(temp.path().join(AUDIT_FILE_NAME), log);
        let mut next = imported();
        next["operation_id"] = json!("audit-failure");
        assert!(matches!(
            call(&v, &alice, "import", next),
            Err(AccessError::Audit)
        ));
    }
}
