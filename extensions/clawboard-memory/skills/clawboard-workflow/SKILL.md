# Clawboard Workflow

Use this skill when the Clawboard + Memory API plugin is enabled.

Workflow rules:

- `Ideas` is intake only. Do not execute directly from Ideas.
- Generate structured prompts from Ideas, then save them into `Prompt Ideas`.
- Only `Planning` is the approved execution queue.
- When executing, pull a small number of relevant memories first.
- Do not dump whole memory history or whole board history into context.
- Move `Planning -> Started Task -> Finished` as work progresses.
- Save distilled durable memory after execution. Avoid transcript dumps.

Preferred tool flow:

1. `clawboard_get_ideas`
2. `clawboard_generate_prompt_from_idea`
3. `clawboard_save_prompt_idea`
4. `clawboard_move_to_planning`
5. `clawboard_get_next_planning_task`
6. `memory_search`
7. `clawboard_start_task`
8. execute the task
9. `memory_save`
10. `clawboard_finish_task`
