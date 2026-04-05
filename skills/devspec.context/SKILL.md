---
name: devspec.context
description: Load all project knowledge from DevSpec into the conversation
allowed-tools: mcp__devspec__get_decisions, mcp__devspec__get_conventions, mcp__devspec__get_resources, mcp__devspec__get_unresolved_questions
---

# DevSpec Context

Load all project decisions, conventions, resources, and unresolved questions from DevSpec into the current conversation. After loading, Claude has full awareness of the project's institutional knowledge.

## Steps

1. Call all four endpoints **in parallel**:
   - `get_decisions` with `limit: 50`
   - `get_conventions` with `limit: 50`
   - `get_resources` with `limit: 50`
   - `get_unresolved_questions` with `limit: 20`

2. If all four return empty results:
   ```
   No project knowledge captured yet. Knowledge is recorded during DevSpec sessions.
   ```
   Stop here.

3. Assemble results into structured sections. Only include sections that have data:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ◆  PROJECT CONTEXT LOADED
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

   **Decisions** (if any):
   ```
   ## Decisions ({N})

   1. {title}
      {reasoning}

   2. {title}
      {reasoning}
   ```

   **Conventions** (if any):
   ```
   ## Conventions ({N})

   1. {description}

   2. {description}
   ```

   **Resources** (if any):
   ```
   ## Resources ({N})

   - [{type}] {title}: {summary}
   - [{type}] {title}: {summary}
   ```

   **Unresolved Questions** (if any):
   ```
   ## Unresolved Questions ({N})

   1. {question content}
   2. {question content}
   ```

4. After all sections, output:
   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Context loaded: {N} decisions · {N} conventions · {N} resources · {N} questions
   I will reference this knowledge in subsequent responses.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

## Rules

- Do NOT truncate decisions or conventions — show full content so Claude retains it
- DO truncate resource summaries to 100 chars (full content available via `/devspec:resources`)
- Show full unresolved questions — these are important context
- Omit empty sections entirely (don't show "Decisions (0)")
- This is a **skill** not a command — the loaded context persists for the entire conversation
