---
name: devspec.search
description: Search DevSpec code index and project knowledge base
allowed-tools: mcp__devspec__search_index, mcp__devspec__search_memories
---

# DevSpec Search

Search across both the code index and the project knowledge base (decisions, conventions, memories).

## Steps

1. Extract the search query from the user's input. If no query provided, ask for one.

2. Call both endpoints **in parallel**:
   - `search_index` with `query` and `limit: 20`
   - `search_memories` with `query` and `limit: 20`

3. If both return no results:
   ```
   No results found for "{query}".
   ```

4. Format results in two sections:

   **Code Results** (from search_index):
   ```
   Code Results ({N} matches)

   {file_path}:{line_number}
     {context snippet}

   {file_path}:{line_number}
     {context snippet}
   ```

   **Knowledge Results** (from search_memories):
   ```
   Knowledge Results ({N} matches)

   [{type}] {title or summary}
     {content preview, truncated to 100 chars}

   [{type}] {title or summary}
     {content preview, truncated to 100 chars}
   ```

5. If only one source has results, show only that section.

## Rules

- Do NOT output filler text before or after the results
- Keep context snippets to 1-2 lines
- Truncate long content with `…`
- Show the type badge for knowledge results (e.g., `[decision]`, `[convention]`, `[risk]`)
