import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { connect, identity } from "../src/upstream.js";
import { Contract, APPROVED, body } from "../src/contract.js";
import { redact, SafeError } from "../src/security.js";
const keyFile = process.env.BUFFER_API_KEY_FILE;
const key = keyFile
  ? (await readFile(keyFile, "utf8")).trim()
  : process.env.BUFFER_API_KEY;
delete process.env.BUFFER_API_KEY;
if (!key) {
  console.error(
    "Run powershell -File scripts/probe.ps1, or configure BUFFER_API_KEY_FILE. Never pass a key as a command argument.",
  );
  process.exit(1);
}
let remote;
try {
  remote = await connect(key);
  const tools = await remote.catalog();
  const get = tools.find((t) => t.name === "get_account"),
    channels = tools.find((t) => t.name === "list_channels");
  if (!get || !channels) throw new SafeError("REQUIRED_PROBE_TOOL_MISSING");
  // Validate exactly the live schemas, never a guessed publishing schema.
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const ajv = new Ajv2020({ strict: false });
  if (!ajv.compile(get.inputSchema)({}))
    throw new SafeError("GET_ACCOUNT_SCHEMA_CHANGED");
  const account = await remote.call("get_account", {});
  body(account);
  console.log(
    "Authenticated Streamable HTTP initialize and complete catalog succeeded. Tool names:",
    tools.map((t) => t.name).join(", "),
  );
  console.log(
    "Verified account response (private terminal only):\n" +
      JSON.stringify(redact(account, [key]), null, 2),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const organizationId = await rl.question(
    "Enter an organization ID from that response to verify read access: ",
  );
  rl.close();
  if (!ajv.compile(channels.inputSchema)({ organizationId }))
    throw new SafeError("LIST_CHANNELS_SCHEMA_CHANGED");
  const channelResult = await remote.call("list_channels", { organizationId });
  body(channelResult);
  await mkdir("secrets", { recursive: true });
  const report = {
    endpoint: "https://mcp.buffer.com/mcp",
    transport: "Streamable HTTP",
    verifiedAt: new Date().toISOString(),
    tools,
    account,
    channels: channelResult,
    organizationId,
  };
  await writeFile(
    "secrets/probe-private.json",
    JSON.stringify(redact(report, [key]), null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    "config/catalog.json",
    JSON.stringify({ verifiedAt: report.verifiedAt, tools }, null, 2),
  );
  const shapeFile = process.env.BUFFER_SHAPE_FILE;
  if (shapeFile) {
    const shape = JSON.parse(await readFile(shapeFile, "utf8"));
    const contract = new Contract({
      verifiedAt: report.verifiedAt,
      tools: tools.filter((t) =>
        (APPROVED as readonly string[]).includes(t.name),
      ),
      shape,
    });
    const verified = await identity(remote, contract);
    console.log(
      "Identity mapping verified; organizations:",
      verified.organizations.length,
      "channels:",
      verified.channels.length,
    );
    await writeFile(
      "config/buffer-contract.json",
      JSON.stringify(
        { verifiedAt: report.verifiedAt, tools: contract.tools, shape },
        null,
        2,
      ),
    );
    console.log(
      "Contract written. Inspect read/write schemas before deployment; no write was called.",
    );
  } else
    console.log(
      "Probe passed. Before starting the server, review secrets/probe-private.json privately and prepare response JSON pointers using config/shape.example.json. Rerun with BUFFER_SHAPE_FILE. No live writes were called.",
    );
} catch (e) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: e instanceof SafeError ? e.code : "UPSTREAM_PROBE_FAILED",
      http_status: (e as any).status ?? (e as any).code ?? null,
      message:
        "No fallback attempted. Check Buffer key, permissions, and network. Response body omitted to protect secrets.",
    }),
  );
  process.exitCode = 1;
} finally {
  await remote?.close().catch(() => {});
}
