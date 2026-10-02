use depdek_space::{
    execute, Command, GetArgs, ObjectListArgs, PutArgs, ResourceAddArgs, ResourceClass,
    SpaceCreateArgs, SpaceError, SpaceResult, Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug)]
struct Cli {
    root: PathBuf,
    socket: Option<PathBuf>,
    command: CliCommand,
}

#[derive(Debug)]
enum CliCommand {
    Service(Command),
    Serve,
}

#[derive(Debug, Serialize, Deserialize)]
struct RpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("depdek-space: {error}");
        std::process::exit(1);
    }
}

fn run() -> SpaceResult<()> {
    let cli = parse_cli(env::args().skip(1).collect())?;
    match cli.command {
        CliCommand::Serve => serve(&cli.root, cli.socket),
        CliCommand::Service(command) => {
            if let Some(socket) = cli.socket {
                let result = rpc_call(&socket, command)?;
                print_json(&result)
            } else {
                let mut store = Store::open(&cli.root)?;
                let result = execute(&mut store, command)?;
                print_json(&result)
            }
        }
    }
}

fn parse_cli(args: Vec<String>) -> SpaceResult<Cli> {
    let mut root = default_root();
    let mut socket = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" => {
                root = PathBuf::from(next_value(&args, &mut index, "--root")?);
            }
            "--socket" => {
                socket = Some(PathBuf::from(next_value(&args, &mut index, "--socket")?));
            }
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            _ => break,
        }
        index += 1;
    }
    let command_name = args
        .get(index)
        .ok_or_else(|| SpaceError::InvalidArgument("missing command".to_string()))?;
    let rest = &args[index + 1..];

    let command = match command_name.as_str() {
        "init" => CliCommand::Service(Command::Init),
        "summary" => CliCommand::Service(Command::Summary),
        "health" => CliCommand::Service(Command::Health),
        "serve" => {
            if socket.is_none() {
                socket = optional_option(rest, "--socket").map(PathBuf::from);
            }
            CliCommand::Serve
        }
        "resource" => parse_resource(rest)?,
        "space" => parse_space(rest)?,
        "object" => parse_object(rest)?,
        "put" => CliCommand::Service(Command::Put(parse_put(rest)?)),
        "get" => CliCommand::Service(Command::Get(parse_get(rest)?)),
        "help" => {
            print_help();
            std::process::exit(0);
        }
        other => {
            return Err(SpaceError::InvalidArgument(format!(
                "unknown command '{other}', use --help"
            )))
        }
    };
    Ok(Cli {
        root,
        socket,
        command,
    })
}

fn parse_resource(args: &[String]) -> SpaceResult<CliCommand> {
    let subcommand = args
        .first()
        .ok_or_else(|| SpaceError::InvalidArgument("resource requires add or list".to_string()))?;
    match subcommand.as_str() {
        "list" => Ok(CliCommand::Service(Command::ResourceList)),
        "add" => {
            let name = required_option(args, "--name")?;
            let class = ResourceClass::from_str(&required_option(args, "--class")?)?;
            Ok(CliCommand::Service(Command::ResourceAdd(ResourceAddArgs {
                name,
                class,
                path: optional_option(args, "--path").map(PathBuf::from),
                endpoint: optional_option(args, "--endpoint"),
                bucket: optional_option(args, "--bucket"),
                provider: optional_option(args, "--provider"),
            })))
        }
        other => Err(SpaceError::InvalidArgument(format!(
            "unknown resource command '{other}'"
        ))),
    }
}

fn parse_space(args: &[String]) -> SpaceResult<CliCommand> {
    let subcommand = args
        .first()
        .ok_or_else(|| SpaceError::InvalidArgument("space requires create or list".to_string()))?;
    match subcommand.as_str() {
        "list" => Ok(CliCommand::Service(Command::SpaceList)),
        "create" => Ok(CliCommand::Service(Command::SpaceCreate(SpaceCreateArgs {
            name: required_option(args, "--name")?,
            primary_class: ResourceClass::from_str(
                &optional_option(args, "--primary-class").unwrap_or_else(|| "durable".to_string()),
            )?,
        }))),
        other => Err(SpaceError::InvalidArgument(format!(
            "unknown space command '{other}'"
        ))),
    }
}

fn parse_object(args: &[String]) -> SpaceResult<CliCommand> {
    match args.first().map(String::as_str) {
        Some("list") => Ok(CliCommand::Service(Command::ObjectList(ObjectListArgs {
            space_id: required_option(args, "--space")?,
        }))),
        Some(other) => Err(SpaceError::InvalidArgument(format!(
            "unknown object command '{other}'"
        ))),
        None => Err(SpaceError::InvalidArgument(
            "object requires list".to_string(),
        )),
    }
}

fn parse_put(args: &[String]) -> SpaceResult<PutArgs> {
    Ok(PutArgs {
        space_id: required_option(args, "--space")?,
        key: required_option(args, "--key")?,
        file: PathBuf::from(required_option(args, "--file")?),
    })
}

fn parse_get(args: &[String]) -> SpaceResult<GetArgs> {
    Ok(GetArgs {
        space_id: required_option(args, "--space")?,
        key: required_option(args, "--key")?,
        output: PathBuf::from(required_option(args, "--output")?),
    })
}

fn serve(root: &PathBuf, socket: Option<PathBuf>) -> SpaceResult<()> {
    let mut store = Store::open(root)?;
    let socket = socket.unwrap_or_else(|| root.join("depdek-space.sock"));
    if socket.exists() {
        fs::remove_file(&socket)?;
    }
    if let Some(parent) = socket.parent() {
        fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    eprintln!(
        "depdek-space ready root={} socket={}",
        root.display(),
        socket.display()
    );
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_client(stream, &mut store) {
                    eprintln!("depdek-space client error: {error}");
                }
            }
            Err(error) => eprintln!("depdek-space accept error: {error}"),
        }
    }
    Ok(())
}

fn handle_client(stream: UnixStream, store: &mut Store) -> SpaceResult<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if line.trim().is_empty() {
        return Ok(());
    }
    let request: RpcRequest = serde_json::from_str(&line)?;
    let response = match command_from_rpc(&request.method, request.params) {
        Ok(command) => match execute(store, command) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": request.id, "result": result}),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": request.id,
                "error": { "code": -32000, "message": error.to_string() }
            }),
        },
        Err(error) => json!({
            "jsonrpc": "2.0",
            "id": request.id,
            "error": { "code": -32602, "message": error.to_string() }
        }),
    };
    let mut writer = stream;
    writeln!(writer, "{}", serde_json::to_string(&response)?)?;
    writer.flush()?;
    Ok(())
}

fn rpc_call(socket: &PathBuf, command: Command) -> SpaceResult<Value> {
    let (method, params) = command_to_rpc(command)?;
    let request = RpcRequest {
        jsonrpc: "2.0".to_string(),
        id: 1,
        method,
        params,
    };
    let mut stream = UnixStream::connect(socket).map_err(|error| {
        SpaceError::Io(std::io::Error::new(
            error.kind(),
            format!("cannot connect to {}: {error}", socket.display()),
        ))
    })?;
    writeln!(stream, "{}", serde_json::to_string(&request)?)?;
    stream.flush()?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    let value: Value = serde_json::from_str(&response)?;
    if let Some(error) = value.get("error") {
        return Err(SpaceError::InvalidArgument(
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("service error")
                .to_string(),
        ));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn command_to_rpc(command: Command) -> SpaceResult<(String, Value)> {
    match command {
        Command::Init => Ok(("space/init".to_string(), json!({}))),
        Command::ResourceAdd(args) => Ok((
            "space/resource/add".to_string(),
            serde_json::to_value(args)?,
        )),
        Command::ResourceList => Ok(("space/resource/list".to_string(), json!({}))),
        Command::SpaceCreate(args) => Ok((
            "space/space/create".to_string(),
            serde_json::to_value(args)?,
        )),
        Command::SpaceList => Ok(("space/space/list".to_string(), json!({}))),
        Command::Put(args) => Ok(("space/object/put".to_string(), serde_json::to_value(args)?)),
        Command::Get(args) => Ok(("space/object/get".to_string(), serde_json::to_value(args)?)),
        Command::ObjectList(args) => {
            Ok(("space/object/list".to_string(), serde_json::to_value(args)?))
        }
        Command::Summary => Ok(("space/summary".to_string(), json!({}))),
        Command::Health => Ok(("space/health".to_string(), json!({}))),
    }
}

fn command_from_rpc(method: &str, params: Value) -> SpaceResult<Command> {
    match method {
        "space/init" => Ok(Command::Init),
        "space/resource/add" => Ok(Command::ResourceAdd(serde_json::from_value(params)?)),
        "space/resource/list" => Ok(Command::ResourceList),
        "space/space/create" => Ok(Command::SpaceCreate(serde_json::from_value(params)?)),
        "space/space/list" => Ok(Command::SpaceList),
        "space/object/put" => Ok(Command::Put(serde_json::from_value(params)?)),
        "space/object/get" => Ok(Command::Get(serde_json::from_value(params)?)),
        "space/object/list" => Ok(Command::ObjectList(serde_json::from_value(params)?)),
        "space/summary" => Ok(Command::Summary),
        "space/health" => Ok(Command::Health),
        _ => Err(SpaceError::InvalidArgument(format!(
            "unknown method '{method}'"
        ))),
    }
}

fn required_option(args: &[String], option: &str) -> SpaceResult<String> {
    optional_option(args, option)
        .ok_or_else(|| SpaceError::InvalidArgument(format!("missing required option {option}")))
}

fn optional_option(args: &[String], option: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == option)
        .map(|pair| pair[1].clone())
}

fn next_value(args: &[String], index: &mut usize, option: &str) -> SpaceResult<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| SpaceError::InvalidArgument(format!("missing value for {option}")))
}

fn default_root() -> PathBuf {
    env::var_os("DEPDEK_SPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/depdek/space"))
        })
        .unwrap_or_else(|| PathBuf::from(".depdek-space"))
}

fn print_json(value: &Value) -> SpaceResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_help() {
    println!(
        r#"depdek-space - logical storage space service

Usage:
  depdek-space [--root DIR] [--socket SOCK] <command>

Commands:
  init
  resource add --name NAME --class hot|durable|cloud [--path DIR] [--endpoint URL]
  resource list
  space create --name NAME [--primary-class hot|durable|cloud]
  space list
  put --space ID --key KEY --file FILE
  get --space ID --key KEY --output FILE
  object list --space ID
  summary
  health
  serve [--socket SOCK]

Without --socket, commands operate directly on the local state. With --socket,
the same commands use the running Linux Unix-socket service.

Phase 1: local hot/durable object read-write and cloud resource registration.
Cloud object transfer is intentionally not enabled yet."#
    );
}
