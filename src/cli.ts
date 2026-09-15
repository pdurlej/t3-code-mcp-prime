#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { PrimeService } from "./prime.js";
import { WorkflowService, schemas, type ToolName } from "./workflow.js";
import { ThreadStore } from "./store.js";

const [name, payload] = process.argv.slice(2);
if (!name || name === "--help") {
  console.log(`T3 Code MCP Prime — JSON CLI\nUsage: t3-mcp-prime TOOL '{"argument":"value"}'\n       t3-mcp-prime TOOL --stdin\nTools: ${Object.keys(schemas).join(", ")}\nRead operations need no token. send_message uses the local token file.\nExample: t3-mcp-prime search_messages '{"query":"Prime", "limit":3}'`);
} else {
  let store: ThreadStore | undefined;
  let service: WorkflowService | undefined;
  try {
    if (!Object.hasOwn(schemas, name)) throw new Error("Unknown tool. Use --help.");
    const args = JSON.parse(payload === "--stdin" ? readFileSync(0, "utf8") : payload ?? "{}");
    store = new ThreadStore();
    service = new WorkflowService(new PrimeService(store));
    const data = await service.call(name as ToolName, args);
    console.log(JSON.stringify({ ok: true, data }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Operation failed." }));
    process.exitCode = 1;
  } finally { service?.close(); store?.close(); }
}
