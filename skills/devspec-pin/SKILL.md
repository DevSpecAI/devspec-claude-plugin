---
name: devspec-pin
description: 'Pin this folder to a DevSpec project: write .devspec/project.json containing exactly {"project_id": "<uuid>"} (that key, nothing else). Load it when the person asks you to pin or link the folder to a DevSpec project, or after they tell you which project a folder with no repository belongs to.'
allowed-tools: Read, Write, Bash, mcp__plugin_devspec_devspec__list_projects, mcp__devspec__list_projects
---

# Pin a folder to a DevSpec project

A folder with no repository, an untracked repository, or a repository shared by several accessible projects can keep a default in one small file. This is separate from a choice for one local conversation. Selecting a project alone is not consent to write the pin.

## The file

`.devspec/project.json`, containing exactly:

```json
{"project_id": "<the project's uuid>"}
```

- The key is `project_id`, spelled exactly so. Anything else (`projectId`, `id`,
  `project`) is not a pin and nothing will read it.
- Nothing else in it: no path, hostname, user, token or timestamp. That is what makes it
  safe to commit. Teammates still need access; a unique remote match beats a stale pin, while a valid candidate pin can disambiguate a shared repository.

## Where it goes

The git repository root when the folder is inside a repository
(`git rev-parse --show-toplevel`), otherwise the current working directory. The root is
the only place every subdirectory resolves it from.

## Before you write

- Only when asked, or after offering and hearing yes. Never write it on your own
  initiative: it is a file in their working tree.
- You need the project's id. If you were given a name, find the id with `list_projects`
  and ask when more than one project could be meant.
- If a pin already names a different project, say which one you are replacing first.

## After

Report the exact file and default written. The startup listener can notice a new pin for an unconnected conversation, but an already-selected conversation keeps its project. A unique remote match still wins. Use `/devspec:devspec.project` to inspect the effective default or preview forgetting it; use its prepared fresh-conversation flow when the person wants to work in another project rather than merely change a folder default.
