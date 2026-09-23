---
name: devspec-pin
description: 'Pin this folder to a DevSpec project: write .devspec/project.json containing exactly {"project_id": "<uuid>"} (that key, nothing else). Load it when the person asks you to pin or link the folder to a DevSpec project, or after they tell you which project a folder with no repository belongs to.'
allowed-tools: Read, Write, Bash, mcp__devspec__list_projects
---

# Pin a folder to a DevSpec project

A folder with no repository, or one whose repository DevSpec does not track, says which
project it belongs to with one small file. Agents and DevSpec read it; nothing else does.

## The file

`.devspec/project.json`, containing exactly:

```json
{"project_id": "<the project's uuid>"}
```

- The key is `project_id`, spelled exactly so. Anything else (`projectId`, `id`,
  `project`) is not a pin and nothing will read it.
- Nothing else in it: no path, hostname, user, token or timestamp. That is what makes it
  safe to commit, so a teammate who clones the folder is pointed at the same project.

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

Tell them it's done. When Claude Code is set to connect to DevSpec at startup, this
session connects to the project by itself within a few seconds, with no restart and no
command to run.
