# Clawboard + Memory API Plugin

This plugin integrates an existing Clawboard workflow board and an existing
durable Memory API into OpenClaw without changing core orchestration code.

It is designed around this workflow:

- `Ideas` for capture and raw task intake
- `Prompt Ideas` for structured prompt drafts
- `Planning` as the approved execution queue
- `Started Task` while work is running
- `Finished` after completion with summary and memory linkage

Memory is kept external. The plugin makes the external Memory API the active
OpenClaw memory backend by using the memory plugin slot.

## What it provides

- Native tools for Clawboard workflow operations
- Native `memory_search` and `memory_get` backed by your external Memory API
- `memory_save` and `memory_upsert_fact`
- Idea-to-prompt orchestration
- Planning-to-execution orchestration
- Optional Planning queue poller
- Tiny local breadcrumb state only

## Install and enable

From this repo checkout:

```powershell
pnpm install
pnpm build
```

Enable the plugin as the active memory slot:

```powershell
openclaw config set plugins.entries.clawboard-memory.enabled true
openclaw config set plugins.slots.memory clawboard-memory
```

## Environment variables

Set the external API credentials in your shell environment:

```powershell
$env:CLAWBOARD_API_BASE_URL='https://clawboard.example.com/api'
$env:CLAWBOARD_API_TOKEN='replace-me'
$env:MEMORY_API_BASE_URL='https://memory.example.com/api'
$env:MEMORY_API_TOKEN='replace-me'
```

The included `.env.example` shows the expected names.

## Example config

```json
{
  "plugins": {
    "entries": {
      "clawboard-memory": {
        "enabled": true,
        "config": {
          "clawboard": {
            "baseUrl": "https://clawboard.example.com/api",
            "auth": {
              "mode": "bearer",
              "valueEnv": "CLAWBOARD_API_TOKEN"
            }
          },
          "memoryApi": {
            "baseUrl": "https://memory.example.com/api",
            "defaultNamespace": "openclaw",
            "auth": {
              "mode": "bearer",
              "valueEnv": "MEMORY_API_TOKEN"
            }
          },
          "workflow": {
            "automation": {
              "planningPoll": {
                "enabled": false,
                "intervalMs": 60000,
                "agentId": "main"
              }
            }
          }
        }
      }
    },
    "slots": {
      "memory": "clawboard-memory"
    }
  }
}
```

## Main tools

- `clawboard_get_ideas`
- `clawboard_generate_prompt_from_idea`
- `clawboard_process_idea_to_prompt`
- `clawboard_get_next_planning_task`
- `clawboard_execute_planning_task`
- `memory_search`
- `memory_get`
- `memory_save`

## CLI commands

- `openclaw memory status`
- `openclaw memory search --query "..." --json`
- `openclaw memory get <memoryId> --json`
- `openclaw clawboard ideas --json`
- `openclaw clawboard generate-prompt <itemId> --json`
- `openclaw clawboard run-once --json`

## Notes

- The plugin does not rebuild Clawboard or Memory APIs.
- Telegram remains capture/input only; Clawboard remains workflow state.
- Local breadcrumb storage is operational only and intentionally tiny.
- If your API shapes differ, adjust endpoint mappings and keep the server-side
  request/response normalization thin.
