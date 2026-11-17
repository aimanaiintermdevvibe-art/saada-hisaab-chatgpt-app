import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCallerByUsername, type Caller } from "../src/auth/caller.js";
import { buildServer } from "../src/server.js";

/** Dev users in the restored sh_db: two different tenants. */
export const USER_A = "admin"; // Demo Account
export const USER_B = "abc123"; // ABC Traders

export interface Session {
  caller: Caller;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; data: any }>;
  close: () => Promise<void>;
}

/** Connects an MCP client to a server acting as `username`, over an in-memory transport. */
export async function connectAs(username: string): Promise<Session> {
  const caller = await resolveCallerByUsername(username);
  const server = buildServer(caller);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    caller,
    client,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const first = (res.content as { type: string; text?: string }[])[0];
      return { isError: Boolean(res.isError), text: first?.text ?? "", data: res.structuredContent };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
