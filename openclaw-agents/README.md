# OpenClaw Multi-Agent Orchestration

This package implements a compact multi-agent architecture where a `MAIN ORCHESTRATOR` delegates heavy work to specialized sub-agents, including a minimal-token `SearchAgent`.

## Architecture

```text
User Task
   |
   v
OrchestratorAgent
   |- TaskRouter (intent + complexity + rules)
   |- ContextManager (budget, summarize, refs)
   |- ToolProxy (permissions + approval guardrails)
   |- MessageBus (sync dispatch)
   |- WorkspaceStore (summaries/facts/cache/TTL)
   |
   +--> PlannerAgent
   +--> SearchAgent -- WebSearchService -- Providers(openclaw|serpapi|bing|brave)
   +--> CodeAgent
   +--> TestAgent
   +--> DocsAgent
   +--> DebugAgent
```

## Folder Layout

```text
/openclaw-agents/
  /src/
    /agents/
    /core/
    /search/
  /config/
    agents.yaml
    routing.yaml
    websearch.yaml
  /tests/
  README.md
```

## Run Locally

1. Install dependencies:
```bash
npm install
```

2. Run in compat mode (default behavior):
```bash
npm start -- --task "write docs for router"
```

3. Enable full delegation mode:
```bash
npm start -- --task "build a multi-agent orchestrator with latest docs" --multi
```

4. JSON output:
```bash
npm start -- --task "latest OpenClaw tool usage" --multi --json
```

## Compatibility Mode

- `compat_mode` is `true` by default in `config/agents.yaml`.
- When enabled and multi-agent mode is not explicitly requested, orchestrator delegates only first route target (legacy-safe behavior).
- Full multi-agent pipeline runs when `--multi` is used (or `mode: "multi-agent"` in API input).

## Adding a New Specialized Agent

1. Create `src/agents/<new-agent>.js` implementing:
```js
run(task, context) => {
  status, summary, citations, artifacts, memory_suggestions, followups
}
```
2. Register it in `src/index.js` (`registry.register(...)`).
3. Add tool policy in `config/agents.yaml -> agent_policies`.
4. Add token budget in `config/agents.yaml -> agent_budgets`.
5. Add routing rule/keywords in `config/routing.yaml`.
6. Add/extend tests.

## Context Budgeting

- Orchestrator budget defaults to `2500` tokens (`agents.yaml`).
- Sub-agent budgets are per-agent (`agent_budgets`).
- If context is too large:
  - `ContextManager` summarizes old history.
  - Stores full payload in `WorkspaceStore` with references (`history_ref`, `blob` refs).
  - Keeps pinned constraints + plan fragments in-context.

## Workspace Store

`WorkspaceStore` persists:
- summaries
- extracted facts/memory suggestions
- artifact references
- search cache

Storage behavior:
- TTL: `short` (6h), `long` (30d), or custom ms.
- Eviction: oldest-first when entry cap is exceeded.
- Retrieval: namespace + task id + tags.

## Web Search and Citations

`SearchAgent` (minimal-token):
- `max_context_tokens: 600`
- `max_output_tokens: 350`
- query-first workflow
- 3-7 citation outputs when available

`WebSearchService` supports:
- provider abstraction (`search(query, recency_days, max_results)`)
- provider fallback order
- query optimization (synonyms, operator templates, fallback suffixes)
- dedupe by canonical URL + title similarity
- scoring (authority, relevance, recency, duplicate-domain penalty)
- cache + rate-limit + retries

Citation object shape:
```json
{
  "title": "...",
  "url": "...",
  "snippet": "...",
  "published": "YYYY-MM-DD|unknown"
}
```

## Safety Guardrails

- Tool access is restricted by `ToolProxy` policies per agent.
- `SearchAgent` can only use `web_search` + `read_workspace`.
- Destructive requests (`delete/remove/overwrite/...`) require explicit `destructiveApproved=true` before orchestration proceeds.

## Example Delegation Flows

### Example 1: Latest usage request
Prompt:
```text
latest OpenClaw tool usage
```
Flow:
```text
user -> orchestrator -> SearchAgent -> merged final answer with citations
```

### Example 2: Build request
Prompt:
```text
build a multi-agent orchestrator
```
Flow:
```text
user -> orchestrator -> PlannerAgent -> CodeAgent -> TestAgent -> DocsAgent -> merge
```

### Example 3: Module fan-out build
Prompt:
```text
build payment platform modules: auth, billing, notifications
```
Flow:
```text
user -> orchestrator -> planner/search -> (code+test per module in parallel) -> docs -> merge
```

Module isolation behavior:
- each module gets a separate scoped context (`module_scope: isolated`)
- each module runs its own `CodeAgent` then `TestAgent`
- orchestrator retries module cycles until success (bounded by retry limits)

## Tests

Run all tests:
```bash
npm test
```

Coverage includes:
- routing behavior
- context budgeting/compaction
- web search dedupe + caching
- compat-mode regression path
- module fan-out and per-module verification retries
