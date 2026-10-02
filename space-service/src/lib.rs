//! DepDek Space: a small, local-first logical storage service.
//!
//! Phase 1 deliberately keeps physical storage behind three resource classes:
//! hot, durable-local, and cloud-registered. Objects are addressed by a
//! logical space/key pair; callers never need to know the physical path.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "state.json";
const INTERNAL_DIR: &str = ".depdek-space";

pub type SpaceResult<T> = Result<T, SpaceError>;

#[derive(Debug, Error)]
pub enum SpaceError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("state error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceClass {
    Hot,
    Durable,
    Cloud,
}

impl ResourceClass {
    pub fn is_local(&self) -> bool {
        !matches!(self, Self::Cloud)
    }
}

impl std::fmt::Display for ResourceClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Hot => "hot",
            Self::Durable => "durable",
            Self::Cloud => "cloud",
        };
        f.write_str(value)
    }
}

impl FromStr for ResourceClass {
    type Err = SpaceError;

    fn from_str(value: &str) -> SpaceResult<Self> {
        match value.to_ascii_lowercase().as_str() {
            "hot" | "高速" => Ok(Self::Hot),
            "durable" | "cold" | "low" | "低速" | "local" => Ok(Self::Durable),
            "cloud" | "云" => Ok(Self::Cloud),
            _ => Err(SpaceError::InvalidArgument(format!(
                "unknown resource class '{value}', expected hot, durable, or cloud"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub name: String,
    pub class: ResourceClass,
    pub enabled: bool,
    pub root: Option<String>,
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpacePolicy {
    pub primary_class: ResourceClass,
    pub cloud_backup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicalSpace {
    pub id: String,
    pub name: String,
    pub policy: SpacePolicy,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectRecord {
    pub id: String,
    pub space_id: String,
    pub key: String,
    pub version: u64,
    pub size: u64,
    pub sha256: String,
    pub resource_id: String,
    pub relative_path: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoreState {
    pub version: u32,
    pub resources: Vec<Resource>,
    pub spaces: Vec<LogicalSpace>,
    pub objects: Vec<ObjectRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceAddArgs {
    pub name: String,
    pub class: ResourceClass,
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceCreateArgs {
    pub name: String,
    pub primary_class: ResourceClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutArgs {
    pub space_id: String,
    pub key: String,
    pub file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetArgs {
    pub space_id: String,
    pub key: String,
    pub output: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectListArgs {
    pub space_id: String,
}

#[derive(Debug, Clone)]
pub enum Command {
    Init,
    ResourceAdd(ResourceAddArgs),
    ResourceList,
    SpaceCreate(SpaceCreateArgs),
    SpaceList,
    Put(PutArgs),
    Get(GetArgs),
    ObjectList(ObjectListArgs),
    Summary,
    Health,
}

pub struct Store {
    root: PathBuf,
    state: StoreState,
}

impl Store {
    pub fn open(root: impl AsRef<Path>) -> SpaceResult<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let state_path = root.join(STATE_FILE);
        let state = if state_path.exists() {
            let bytes = fs::read(&state_path)?;
            let mut state: StoreState = serde_json::from_slice(&bytes)?;
            if state.version == 0 {
                state.version = STATE_VERSION;
            }
            state
        } else {
            let state = StoreState {
                version: STATE_VERSION,
                ..StoreState::default()
            };
            write_json_atomic(&state_path, &state)?;
            state
        };

        Ok(Self { root, state })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn persist(&self) -> SpaceResult<()> {
        write_json_atomic(&self.root.join(STATE_FILE), &self.state)
    }

    fn resource(&self, id: &str) -> SpaceResult<&Resource> {
        self.state
            .resources
            .iter()
            .find(|resource| resource.id == id)
            .ok_or_else(|| SpaceError::NotFound(format!("resource '{id}'")))
    }

    fn space(&self, id: &str) -> SpaceResult<&LogicalSpace> {
        self.state
            .spaces
            .iter()
            .find(|space| space.id == id)
            .ok_or_else(|| SpaceError::NotFound(format!("space '{id}'")))
    }

    pub fn add_resource(&mut self, args: ResourceAddArgs) -> SpaceResult<Resource> {
        let name = args.name.trim();
        if name.is_empty() {
            return Err(SpaceError::InvalidArgument(
                "resource name cannot be empty".to_string(),
            ));
        }

        let root = if args.class.is_local() {
            let path = args.path.ok_or_else(|| {
                SpaceError::InvalidArgument(format!("{} resource requires --path", args.class))
            })?;
            fs::create_dir_all(&path)?;
            Some(fs::canonicalize(path)?.to_string_lossy().into_owned())
        } else {
            if args.endpoint.is_none() {
                return Err(SpaceError::InvalidArgument(
                    "cloud resource requires --endpoint".to_string(),
                ));
            }
            None
        };

        let id = unique_id(
            name,
            self.state.resources.iter().map(|item| item.id.as_str()),
        );
        let resource = Resource {
            id,
            name: name.to_string(),
            class: args.class,
            enabled: true,
            root,
            provider: args.provider,
            endpoint: args.endpoint,
            bucket: args.bucket,
            created_at_ms: now_ms(),
        };
        self.state.resources.push(resource.clone());
        self.persist()?;
        Ok(resource)
    }

    pub fn create_space(&mut self, args: SpaceCreateArgs) -> SpaceResult<LogicalSpace> {
        let name = args.name.trim();
        if name.is_empty() {
            return Err(SpaceError::InvalidArgument(
                "space name cannot be empty".to_string(),
            ));
        }
        let id = unique_id(name, self.state.spaces.iter().map(|item| item.id.as_str()));
        let space = LogicalSpace {
            id,
            name: name.to_string(),
            policy: SpacePolicy {
                primary_class: args.primary_class,
                cloud_backup: false,
            },
            created_at_ms: now_ms(),
        };
        self.state.spaces.push(space.clone());
        self.persist()?;
        Ok(space)
    }

    pub fn put_file(&mut self, args: PutArgs) -> SpaceResult<ObjectRecord> {
        let key = normalize_key(&args.key)?;
        let space = self.space(&args.space_id)?.clone();
        let metadata = fs::metadata(&args.file)?;
        if !metadata.is_file() {
            return Err(SpaceError::InvalidArgument(format!(
                "source is not a file: {}",
                args.file.display()
            )));
        }
        let sha256 = sha256_file(&args.file)?;
        let resource = self.select_resource(&space.policy.primary_class)?.clone();
        let resource_root = resource.root.as_ref().ok_or_else(|| {
            SpaceError::Unsupported("cloud object writes are not enabled in phase 1".to_string())
        })?;

        let relative_path = PathBuf::from(INTERNAL_DIR)
            .join("objects")
            .join(&space.id)
            .join(&sha256);
        let destination = Path::new(resource_root).join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if !destination.exists() {
            let temporary = destination.with_extension(format!("part-{}", std::process::id()));
            fs::copy(&args.file, &temporary)?;
            fs::rename(temporary, &destination)?;
        }

        let version = self
            .state
            .objects
            .iter()
            .filter(|object| object.space_id == space.id && object.key == key)
            .map(|object| object.version)
            .max()
            .unwrap_or(0)
            + 1;
        let object = ObjectRecord {
            id: format!("obj-{}-{}-{}", space.id, version, &sha256[..12]),
            space_id: space.id,
            key,
            version,
            size: metadata.len(),
            sha256,
            resource_id: resource.id,
            relative_path: relative_path.to_string_lossy().replace('\\', "/"),
            created_at_ms: now_ms(),
        };
        self.state.objects.push(object.clone());
        self.persist()?;
        Ok(object)
    }

    pub fn get_file(&self, args: GetArgs) -> SpaceResult<ObjectRecord> {
        let key = normalize_key(&args.key)?;
        let object = self.latest_object(&args.space_id, &key)?.clone();
        let resource = self.resource(&object.resource_id)?;
        let root = resource.root.as_ref().ok_or_else(|| {
            SpaceError::Unsupported("cloud object reads are not enabled in phase 1".to_string())
        })?;
        let source = Path::new(root).join(&object.relative_path);
        if !source.is_file() {
            return Err(SpaceError::NotFound(format!(
                "object data for '{}' is missing",
                object.key
            )));
        }
        if let Some(parent) = args.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, &args.output)?;
        Ok(object)
    }

    pub fn list_objects(&self, args: ObjectListArgs) -> SpaceResult<Vec<ObjectRecord>> {
        self.space(&args.space_id)?;
        let mut latest = BTreeMap::<String, ObjectRecord>::new();
        for object in self
            .state
            .objects
            .iter()
            .filter(|object| object.space_id == args.space_id)
        {
            let replace = latest
                .get(&object.key)
                .map(|existing| existing.version < object.version)
                .unwrap_or(true);
            if replace {
                latest.insert(object.key.clone(), object.clone());
            }
        }
        Ok(latest.into_values().collect())
    }

    fn latest_object(&self, space_id: &str, key: &str) -> SpaceResult<&ObjectRecord> {
        self.space(space_id)?;
        self.state
            .objects
            .iter()
            .filter(|object| object.space_id == space_id && object.key == key)
            .max_by_key(|object| object.version)
            .ok_or_else(|| SpaceError::NotFound(format!("object '{space_id}/{key}'")))
    }

    fn select_resource(&self, preferred: &ResourceClass) -> SpaceResult<&Resource> {
        let order = match preferred {
            ResourceClass::Hot => [ResourceClass::Hot, ResourceClass::Durable],
            ResourceClass::Durable => [ResourceClass::Durable, ResourceClass::Hot],
            ResourceClass::Cloud => [ResourceClass::Durable, ResourceClass::Hot],
        };
        for class in order {
            if let Some(resource) = self.state.resources.iter().find(|resource| {
                resource.enabled && resource.class == class && resource.root.is_some()
            }) {
                return Ok(resource);
            }
        }
        Err(SpaceError::NotFound(
            "no enabled local resource is available; add hot or durable resource first".to_string(),
        ))
    }

    pub fn summary(&self) -> Value {
        let bytes = self
            .state
            .spaces
            .iter()
            .flat_map(|space| {
                self.list_objects(ObjectListArgs {
                    space_id: space.id.clone(),
                })
                .unwrap_or_default()
            })
            .map(|object| object.size)
            .sum::<u64>();
        json!({
            "state_version": self.state.version,
            "root": self.root,
            "resources": self.state.resources.len(),
            "spaces": self.state.spaces.len(),
            "latest_objects": self.latest_object_count(),
            "object_bytes": bytes,
            "cloud_resources_registered": self.state.resources.iter().filter(|r| r.class == ResourceClass::Cloud).count(),
            "phase_1": {
                "local_object_read_write": true,
                "cloud_registration": true,
                "cloud_object_transfer": false
            }
        })
    }

    pub fn health(&self) -> Value {
        let mut checks = Vec::new();
        for resource in &self.state.resources {
            let (ok, detail) = match resource.class {
                ResourceClass::Cloud => (
                    resource.endpoint.is_some(),
                    if resource.endpoint.is_some() {
                        "registered"
                    } else {
                        "missing endpoint"
                    },
                ),
                _ => {
                    let ok = resource
                        .root
                        .as_deref()
                        .map(Path::new)
                        .map(|path| path.is_dir())
                        .unwrap_or(false);
                    (
                        ok,
                        if ok {
                            "directory ready"
                        } else {
                            "directory missing"
                        },
                    )
                }
            };
            checks.push(json!({
                "resource_id": resource.id,
                "class": resource.class,
                "ok": ok,
                "detail": detail
            }));
        }
        let ok = checks
            .iter()
            .all(|item| item["ok"].as_bool().unwrap_or(false));
        json!({ "ok": ok, "checks": checks })
    }

    fn latest_object_count(&self) -> usize {
        self.state
            .spaces
            .iter()
            .map(|space| {
                self.list_objects(ObjectListArgs {
                    space_id: space.id.clone(),
                })
                .map(|items| items.len())
                .unwrap_or(0)
            })
            .sum()
    }
}

pub fn execute(store: &mut Store, command: Command) -> SpaceResult<Value> {
    match command {
        Command::Init => Ok(json!({
            "initialized": true,
            "root": store.root(),
            "state_version": store.state.version
        })),
        Command::ResourceAdd(args) => Ok(serde_json::to_value(store.add_resource(args)?)?),
        Command::ResourceList => Ok(serde_json::to_value(&store.state.resources)?),
        Command::SpaceCreate(args) => Ok(serde_json::to_value(store.create_space(args)?)?),
        Command::SpaceList => Ok(serde_json::to_value(&store.state.spaces)?),
        Command::Put(args) => Ok(serde_json::to_value(store.put_file(args)?)?),
        Command::Get(args) => Ok(serde_json::to_value(store.get_file(args)?)?),
        Command::ObjectList(args) => Ok(serde_json::to_value(store.list_objects(args)?)?),
        Command::Summary => Ok(store.summary()),
        Command::Health => Ok(store.health()),
    }
}

fn normalize_key(value: &str) -> SpaceResult<String> {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') || value.contains('\\') {
        return Err(SpaceError::InvalidArgument(
            "object key must be non-empty and use POSIX '/' separators".to_string(),
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(SpaceError::InvalidArgument(format!(
                    "object key escapes logical space: {value}"
                )))
            }
        }
    }
    if parts.is_empty() {
        return Err(SpaceError::InvalidArgument(
            "object key cannot be empty".to_string(),
        ));
    }
    Ok(parts.join("/"))
}

fn sha256_file(path: &Path) -> SpaceResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn unique_id<'a>(name: &str, existing: impl Iterator<Item = &'a str>) -> String {
    let base = slugify(name);
    let existing = existing.collect::<std::collections::HashSet<_>>();
    if !existing.contains(base.as_str()) {
        return base;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base}-{index}");
        if !existing.contains(candidate.as_str()) {
            return candidate;
        }
        index += 1;
    }
}

fn slugify(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            result.push(ch.to_ascii_lowercase());
        } else if !result.ends_with('-') {
            result.push('-');
        }
    }
    let result = result.trim_matches('-').to_string();
    if result.is_empty() {
        "space".to_string()
    } else {
        result
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> SpaceResult<()> {
    let data = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&data)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn stores_logical_objects_without_exposing_source_paths() {
        let root = tempdir().expect("root");
        let hot = tempdir().expect("hot");
        let durable = tempdir().expect("durable");
        let source = root.path().join("source.txt");
        fs::write(&source, "hello depdek").expect("source");

        let mut store = Store::open(root.path().join("service")).expect("open");
        store
            .add_resource(ResourceAddArgs {
                name: "hot-cache".to_string(),
                class: ResourceClass::Hot,
                path: Some(hot.path().to_path_buf()),
                endpoint: None,
                bucket: None,
                provider: None,
            })
            .expect("hot");
        store
            .add_resource(ResourceAddArgs {
                name: "local-data".to_string(),
                class: ResourceClass::Durable,
                path: Some(durable.path().to_path_buf()),
                endpoint: None,
                bucket: None,
                provider: None,
            })
            .expect("durable");
        let space = store
            .create_space(SpaceCreateArgs {
                name: "project-docs".to_string(),
                primary_class: ResourceClass::Durable,
            })
            .expect("space");
        let object = store
            .put_file(PutArgs {
                space_id: space.id.clone(),
                key: "docs/readme.txt".to_string(),
                file: source,
            })
            .expect("put");

        assert_eq!(object.key, "docs/readme.txt");
        assert_eq!(object.resource_id, "local-data");
        assert!(!object.relative_path.contains("source.txt"));
        assert_eq!(
            store
                .list_objects(ObjectListArgs { space_id: space.id })
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn rejects_traversal_keys() {
        let error = normalize_key("../outside.txt").expect_err("must reject");
        assert!(error.to_string().contains("escapes"));
    }

    #[test]
    fn cloud_resource_is_registered_but_not_used_for_phase_one_writes() {
        let root = tempdir().expect("root");
        let mut store = Store::open(root.path().join("service")).expect("open");
        let resource = store
            .add_resource(ResourceAddArgs {
                name: "object-store".to_string(),
                class: ResourceClass::Cloud,
                path: None,
                endpoint: Some("https://oss.example.test".to_string()),
                bucket: Some("depdek".to_string()),
                provider: Some("s3".to_string()),
            })
            .expect("cloud");
        assert_eq!(resource.class, ResourceClass::Cloud);
        assert_eq!(store.health()["ok"], true);
    }
}
