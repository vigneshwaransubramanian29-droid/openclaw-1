import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

export function noteDoctorProfileContext(configPath: string): void {
  const profile = process.env.OPENCLAW_PROFILE?.trim() || "default";
  const stateDir = resolveStateDir();
  note(
    [
      `Profile: ${profile}`,
      `Config: ${shortenHomePath(configPath)}`,
      `State: ${shortenHomePath(stateDir)}`,
      `Verify profile overrides: ${formatCliCommand("openclaw doctor --deep")}`,
    ].join("\n"),
    "Context",
  );
}
