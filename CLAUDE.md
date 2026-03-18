AGENTS.md

---

## Personal Deployment Context (Shali's Machine — Windows 11)

This is a personal OpenClaw deployment running as an AI assistant named **Jarvis**.

### Environment
- OS: Windows 11, shell: bash (Git Bash / WSL), use Unix paths in code, Windows paths in PS1
- Node: `C:\Program Files\nodejs\node.exe`
- Repo: `C:\openclaw`
- Config: `C:\Users\Shali\.openclaw\openclaw.json`
- Logs: `C:\Users\Shali\AppData\Local\OpenClaw\logs\`
- Desktop shortcut: `C:\Users\Shali\OneDrive\Desktop\OpenClaw.lnk`
- Launch script: `C:\openclaw\scripts\launch-openclaw.ps1`

### Starting OpenClaw — TWO processes required
OpenClaw needs **two** separate node processes. Both are started by `launch-openclaw.ps1`:

| Process | Command | Log |
|---------|---------|-----|
| Main bot (channels) | `node scripts\run-node.mjs` | `openclaw.log` |
| Gateway (UI/API) | `node scripts\run-node.mjs gateway` | `gateway.log` |

Gateway config: port **18789**, mode=local, bind=loopback, auth=token.
URL: `http://127.0.0.1:18789/`

If gateway isn't running — the launch script forgot to start it, or it crashed. Check `gateway.log`.

### Running tests
Use **vitest**, NOT jest/npm test:
- Core/memory/infra: `npx vitest run --config vitest.unit.config.ts <file>`
- Telegram/Discord/channels: `npx vitest run --config vitest.channels.config.ts <file>`
- `src/telegram/**` is excluded from vitest.unit.config.ts — always use channels config for those

### Known recurring issues

**1. Telegram garbled characters (mojibake) — e.g. "Jarvis ÃðÅ¸Â¤â€" Got it." instead of "Jarvis 🤖 Got it."**
- Root cause: double UTF-8 → Latin-1/Windows-1252 encode/decode cycle on emoji bytes
- Fix: `repairUtf8MojibakeText()` in `src/telegram/send.ts` runs at the top of `sendMessageTelegram`
- Check: is the text going through `sendMessageTelegram`? Other send paths may not be repaired

**2. Telegram bot stops responding after rate limit**
- Root cause: `isSafeToRetrySendError` in `src/telegram/network-errors.ts` must include 429 and grammY "Network request for X failed after N attempts"
- Fix: check that `/\b429\b/` and `GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE` are in `isSafeToRetrySendError`

**3. Memory losing context between sessions**
- Memory files live at: `C:\Users\Shali\.claude\projects\c--openclaw\memory\`
- SQLite sidecar auto-detects existing DB file — if no DB file exists it won't activate
- Check `src/memory/search-manager.ts` → `resolveSqliteSidecarRuntimeConfig` for activation logic

**4. Multiple OpenClaw instances / stale processes**
- Kill all: `Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where { $_.CommandLine -match "openclaw|run-node" } | ForEach { Stop-Process -Id $_.ProcessId -Force }`
- The launch script does this automatically before starting

**5. Build is stale / TypeScript changes not reflecting**
- `run-node.mjs` auto-rebuilds when source is newer than `dist/.buildstamp`
- Force rebuild: delete `C:\openclaw\dist\.buildstamp` then run launch script

### Bot identity
- Name: **Jarvis** (set in `openclaw.json` → `ui.assistant.name`)
- Telegram sends go through `src/telegram/send.ts` → `sendMessageTelegram`
- Bot name used in templates/prompts — search `SenderName` and `ui.assistant.name` if name appears wrong
