import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot, note } from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";
import {
  checkGatewayHealth,
  probeGatewayMemoryStatus,
  probeGatewayWebSearchStatus,
} from "./doctor-gateway-health.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor preflight", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_PROFILE;
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
        },
      },
    });
    note.mockClear();
    vi.mocked(checkGatewayHealth).mockResolvedValue({ healthOk: true });
    vi.mocked(probeGatewayMemoryStatus).mockResolvedValue({ checked: false, ready: false });
    vi.mocked(probeGatewayWebSearchStatus).mockResolvedValue({ checked: true, ready: true });
  });

  it("prints active profile and config context early", async () => {
    process.env.OPENCLAW_PROFILE = "work";

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const contextNote = note.mock.calls.find((call) => call[1] === "Context");
    expect(contextNote).toBeTruthy();
    expect(String(contextNote?.[0])).toContain("Profile: work");
    expect(String(contextNote?.[0])).toContain("Config: /tmp/openclaw.json");
  });

  it("does not run the web probe outside --deep", async () => {
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(probeGatewayWebSearchStatus).not.toHaveBeenCalled();
  });

  it("runs the web probe in --deep mode", async () => {
    await doctorCommand(createDoctorRuntime(), {
      deep: true,
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(probeGatewayWebSearchStatus).toHaveBeenCalledTimes(1);
  });
});
