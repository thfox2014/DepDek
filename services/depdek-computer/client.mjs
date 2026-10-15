import { createConnection } from "node:net";
const chunks = [];
let size = 0;
for await (const c of process.stdin) {
  size += c.length;
  if (size > 20000) throw Error("INPUT_LIMIT");
  chunks.push(c);
}
const s = createConnection("/tmp/depdek-computer.sock");
s.setTimeout(25000, () => s.destroy());
s.on("connect", () => s.end(Buffer.concat(chunks)));
s.on("data", (b) => process.stdout.write(b));
s.on("error", () => {
  process.exitCode = 2;
});
