import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(projectRoot, "src-tauri/resources/node");

await mkdir(dirname(destination), { recursive: true });
await copyFile(process.execPath, destination);
await chmod(destination, 0o755);

console.log(`Bundled Node runtime: ${process.execPath} -> ${destination}`);
