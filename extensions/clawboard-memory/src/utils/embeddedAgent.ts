import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ZodType } from "zod";
import type { OpenClawPluginApi } from "../../api.js";

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}

export function collectTextPayloads(
  payloads: Array<{ text?: string; isError?: boolean }> | undefined,
): string {
  return (payloads ?? [])
    .filter((payload) => !payload.isError && typeof payload.text === "string")
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
}

export function extractArtifactLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/[),.;]+$/, ""))));
}

export async function runJsonEmbeddedTask<T>(params: {
  api: OpenClawPluginApi;
  prompt: string;
  schema: ZodType<T>;
  workspaceDir: string;
  sessionPrefix: string;
  timeoutMs: number;
  provider?: string;
  model?: string;
  authProfileId?: string;
  extraSystemPrompt?: string;
}): Promise<T> {
  const result = await runEmbeddedTask({
    api: params.api,
    prompt: [
      "You are a JSON-only workflow helper.",
      "Return only valid JSON.",
      "Do not use markdown fences.",
      "Do not add commentary outside the JSON value.",
      "",
      params.prompt,
    ].join("\n"),
    workspaceDir: params.workspaceDir,
    sessionPrefix: params.sessionPrefix,
    timeoutMs: params.timeoutMs,
    provider: params.provider,
    model: params.model,
    authProfileId: params.authProfileId,
    disableTools: true,
    extraSystemPrompt: params.extraSystemPrompt,
  });

  const text = collectTextPayloads(
    (result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads,
  );
  if (!text) {
    throw new Error("Embedded JSON task returned empty output");
  }
  const raw = stripCodeFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Embedded JSON task returned invalid JSON");
  }
  return params.schema.parse(parsed);
}

export async function runEmbeddedTask(params: {
  api: OpenClawPluginApi;
  prompt: string;
  workspaceDir: string;
  sessionPrefix: string;
  timeoutMs: number;
  provider?: string;
  model?: string;
  authProfileId?: string;
  disableTools?: boolean;
  extraSystemPrompt?: string;
}) {
  let tempDir: string | null = null;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawboard-memory-"));
    const sessionId = `${params.sessionPrefix}-${Date.now()}`;
    const sessionFile = path.join(tempDir, "session.json");
    return await params.api.runtime.agent.runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.api.config,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      runId: `${params.sessionPrefix}-${Date.now()}`,
      provider: params.provider,
      model: params.model,
      authProfileId: params.authProfileId,
      authProfileIdSource: params.authProfileId ? "user" : "auto",
      disableTools: params.disableTools,
      extraSystemPrompt: params.extraSystemPrompt,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
