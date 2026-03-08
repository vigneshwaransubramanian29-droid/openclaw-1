# Local Runtime Learnings - 2026-03-09

## Models

- Keep `qwen3:8b` as the primary local tool-capable model.
- Keep `qwen2.5-coder:7b` as a secondary local coding/tool model.
- Treat local DeepSeek variants without `tools` capability as unsuitable for tool-calling agent roles.
- Treat `llama3.2:3b` as a lightweight fallback, not the primary local tool model.

## Windows Gateway Ops

- A manual `openclaw gateway run --bind loopback --port 18789 --force` is a workable recovery path when the scheduled task is stale or missing.
- Reinstalling the Windows scheduled task still requires an Administrator shell.
- A restricted shell that cannot open the device auth file can report a false gateway failure. Re-run gateway health from a shell with normal user-profile access before assuming the gateway is down.

## Build And Install Hygiene

- Missing generated chunk errors can come from a stale or mixed `dist` tree rather than a broken channel config.
- When a plugin or tool import fails with a missing generated chunk, verify whether the running launcher is using the intended install and whether the build artifacts are consistent.

## Telegram

- A Telegram outage symptom is not always a token or config problem.
- The concrete runtime issue observed today was a temporary polling stall: no `getUpdates` activity for about 103 seconds, followed by an automatic forced restart.
- A later live probe succeeded in polling mode, so the observed issue was transient rather than a persistent Telegram configuration failure.
- Before changing Telegram config, first separate gateway reachability problems from stale build/plugin-load problems and actual Telegram runtime stalls or network interruptions.
- Confirm the live state with `openclaw gateway health`.
- Confirm the live state with `openclaw channels status --probe`.

## Follow-Up Checks

- If Telegram stalls repeat, capture the log lines immediately before and after the restart and check network reachability to Telegram from the gateway host.
- If reboot persistence matters, repair the scheduled task from an Administrator shell instead of relying on the manual gateway run.
