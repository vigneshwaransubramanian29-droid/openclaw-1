import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, registerAcpRuntimeBackend } from "../acp/runtime/registry.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteAcpHealth } from "./doctor-acp.js";

describe("noteAcpHealth", () => {
  beforeEach(() => {
    note.mockClear();
    __testing.resetAcpRuntimeBackendsForTests();
  });

  afterEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("reports ACP disabled by policy", async () => {
    await noteAcpHealth({
      acp: {
        enabled: false,
      },
    });

    expect(note).toHaveBeenCalledWith(expect.stringContaining("ACP is disabled by policy"), "ACP");
  });

  it("reports ACP dispatch disabled by policy", async () => {
    await noteAcpHealth({
      acp: {
        dispatch: {
          enabled: false,
        },
      },
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("ACP dispatch is disabled by policy"),
      "ACP",
    );
  });

  it("reports a missing ACP runtime backend", async () => {
    await noteAcpHealth({
      acp: {
        enabled: true,
      },
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("ACP runtime backend is not configured"),
      "ACP",
    );
  });

  it("reports a missing ACP default agent when ACP is otherwise enabled", async () => {
    registerAcpRuntimeBackend({
      id: "test",
      runtime: {} as never,
    });

    await noteAcpHealth({
      acp: {
        enabled: true,
      },
    });

    expect(note).toHaveBeenCalledWith(expect.stringContaining("acp.defaultAgent"), "ACP");
  });

  it("stays quiet when ACP policy, runtime, and default agent are all configured", async () => {
    registerAcpRuntimeBackend({
      id: "test",
      runtime: {} as never,
    });

    await noteAcpHealth({
      acp: {
        enabled: true,
        defaultAgent: "codex",
      },
    });

    expect(note).not.toHaveBeenCalled();
  });
});
