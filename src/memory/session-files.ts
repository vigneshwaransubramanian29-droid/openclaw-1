import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { loadSessionStore, normalizeStoreSessionKey } from "../config/sessions/store.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
};

export type ParsedSessionMessage = {
  role: "user" | "assistant";
  text: string;
  sourceLine: number;
  provider?: string;
  model?: string;
  timestamp?: number;
};

export type ParsedSessionTranscript = {
  sessionId?: string;
  messages: ParsedSessionMessage[];
  content: string;
  lineMap: number[];
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

function readMessageEnvelope(record: unknown): {
  role?: unknown;
  content?: unknown;
  provider?: unknown;
  model?: unknown;
  timestamp?: unknown;
} | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const root = record as { type?: unknown; message?: unknown };
  if (root.type !== "message" || !root.message || typeof root.message !== "object") {
    return null;
  }
  return root.message as {
    role?: unknown;
    content?: unknown;
    provider?: unknown;
    model?: unknown;
    timestamp?: unknown;
  };
}

export function parseSessionTranscript(raw: string): ParsedSessionTranscript {
  const lines = raw.split("\n");
  const messages: ParsedSessionMessage[] = [];
  const collected: string[] = [];
  const lineMap: number[] = [];
  let sessionId: string | undefined;

  for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx += 1) {
    const line = lines[jsonlIdx];
    if (!line?.trim()) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !sessionId &&
      record &&
      typeof record === "object" &&
      (record as { type?: unknown }).type === "session" &&
      typeof (record as { id?: unknown }).id === "string"
    ) {
      sessionId = (record as { id: string }).id;
      continue;
    }
    const message = readMessageEnvelope(record);
    if (!message || typeof message.role !== "string") {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = extractSessionText(message.content);
    if (!text) {
      continue;
    }
    const safe = redactSensitiveText(text, { mode: "tools" });
    const parsed: ParsedSessionMessage = {
      role: message.role,
      text: safe,
      sourceLine: jsonlIdx + 1,
      provider: typeof message.provider === "string" ? message.provider : undefined,
      model: typeof message.model === "string" ? message.model : undefined,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
    };
    messages.push(parsed);
    collected.push(`${message.role === "user" ? "User" : "Assistant"}: ${safe}`);
    lineMap.push(parsed.sourceLine);
  }

  return {
    sessionId,
    messages,
    content: collected.join("\n"),
    lineMap,
  };
}

export async function loadSessionKeyMapForAgent(agentId: string): Promise<Map<string, string>> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = resolveDefaultSessionStorePath(agentId);
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const sessionKeys = new Map<string, string>();
    for (const [sessionKey, entry] of Object.entries(store)) {
      const sessionFile = entry?.sessionFile?.trim();
      if (!sessionFile) {
        continue;
      }
      const absPath = path.isAbsolute(sessionFile)
        ? path.resolve(sessionFile)
        : path.resolve(sessionsDir, sessionFile);
      sessionKeys.set(absPath, normalizeStoreSessionKey(sessionKey));
    }
    return sessionKeys;
  } catch {
    return new Map();
  }
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const parsed = parseSessionTranscript(raw);
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(parsed.content + "\n" + parsed.lineMap.join(",")),
      content: parsed.content,
      lineMap: parsed.lineMap,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
