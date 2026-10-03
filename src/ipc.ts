import { UserError } from "./errors.ts";
import type { Command } from "./parse.ts";

export const DAEMON_MISSING =
  "Brak demona czujki. Uruchom w osobnym terminalu: czujka daemon";

export type RpcRequest =
  | { op: "add"; command: Extract<Command, { kind: "add" }> }
  | { op: "list" }
  | { op: "show"; id: string }
  | { op: "remove"; id: string }
  | { op: "status" };

export type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export function commandToRpc(
  command: Exclude<Command, { kind: "help" | "daemon" }>,
): RpcRequest {
  switch (command.kind) {
    case "add":
      return { op: "add", command };
    case "list":
      return { op: "list" };
    case "status":
      return { op: "status" };
    case "show":
      return { op: "show", id: command.id };
    case "remove":
      return { op: "remove", id: command.id };
  }
}

export async function rpc(
  socketPath: string,
  request: RpcRequest,
): Promise<unknown> {
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
  } catch {
    throw new UserError(DAEMON_MISSING);
  }
  try {
    const payload = new TextEncoder().encode(JSON.stringify(request) + "\n");
    let offset = 0;
    while (offset < payload.length) {
      const wrote = await conn.write(payload.subarray(offset));
      if (wrote <= 0) throw new UserError("Demon przerwał połączenie.");
      offset += wrote;
    }
    const line = await readLine(conn);
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      throw new UserError("Demon zwrócił nieczytelną odpowiedź.");
    }
    if (!response.ok) {
      throw new UserError(response.error || "Demon zgłosił błąd.");
    }
    return response.result;
  } finally {
    conn.close();
  }
}

export async function readLine(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const buf = new Uint8Array(4096);
  while (total < 1_000_000) {
    const n = await conn.read(buf);
    if (n === null || n === 0) break;
    const piece = buf.subarray(0, n);
    const nl = piece.indexOf(0x0a);
    if (nl >= 0) {
      chunks.push(piece.subarray(0, nl));
      total += nl;
      if (total >= 1_000_000) break;
      return new TextDecoder().decode(concat(chunks, total));
    }
    chunks.push(piece.slice());
    total += n;
  }
  throw new UserError("Odpowiedź demona jest za długa albo przerwana.");
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function writeResponse(
  conn: Deno.Conn,
  response: RpcResponse,
): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(response) + "\n");
  let offset = 0;
  while (offset < payload.length) {
    const wrote = await conn.write(payload.subarray(offset));
    if (wrote <= 0) return;
    offset += wrote;
  }
}
