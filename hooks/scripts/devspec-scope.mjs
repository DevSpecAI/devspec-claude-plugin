#!/usr/bin/env node
/**
 * Where a folder stands in relation to DevSpec.
 *
 * Two questions live here, and both are answered from the filesystem alone — no
 * network, no server round trip — because the callers are a PreToolUse hook that
 * runs before every mutation and a connect script that must work offline:
 *
 *  - WHICH project does this folder belong to?      → `findProjectPin`
 *  - Is this folder part of a DevSpec project AT ALL? → `devspecFolderMarker`
 *
 * The second question is why this module exists. The claim guard used to answer it
 * "yes, everywhere": it derived a session/repository scope from any cwd and gated
 * every Write, Edit and Bash on a DevSpec claim. Installed at user scope — which is
 * how the plugin is normally installed — that gates every unrelated project on the
 * machine on a claim that can never arrive there, because nothing in that folder
 * has anything to do with DevSpec (devspec:7be7469f).
 *
 * So jurisdiction is POSITIVE and local: the folder must carry a DevSpec marker.
 * Absence of a marker is not "unknown, therefore deny" — it is "not ours".
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Names that identify DevSpec in an MCP server / plugin registration. */
const DEVSPEC_NAME = /devspec/i

/**
 * Per-directory config files that can declare a project-scoped DevSpec
 * registration. `.mcp.json` is the neutral, shared form every host reads;
 * the `.claude/` pair is Claude Code's own, and `settings.local.json` matters
 * because that is where an untracked, machine-local registration lands.
 */
const MCP_CONFIG_FILES = [
  ['.mcp.json'],
  ['.claude', 'settings.json'],
  ['.claude', 'settings.local.json'],
  ['.claude', 'mcp.json'],
]

/** `git remote get-url origin`, or null when there is no repo / no origin. */
export function gitRemoteOrigin(cwd) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** The git working-tree root for `cwd`, or null when this is not a repo. */
export function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim() ? path.resolve(out.trim()) : null
  } catch {
    return null
  }
}

/**
 * The same answer as `gitRoot` from stat calls alone: the nearest ancestor holding
 * a `.git` entry. A linked worktree's `.git` is a FILE rather than a directory, so
 * presence — not type — is the test.
 *
 * This exists because the claim guard asks for it before every single mutation, and
 * spawning `git rev-parse` on that path would add a process to every Bash call in
 * the editor. `gitRoot` stays for the connect script, where one exec is free.
 */
export function workTreeRootFrom(cwd, { home = os.homedir() } = {}) {
  const homeResolved = path.resolve(home)
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) return null
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** True when `dir` IS the home directory or an ancestor of it (`~`, `/home`, `/`). */
function atOrAboveHome(dir, homeResolved) {
  const relative = path.relative(dir, homeResolved)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Walk from `cwd` upward, calling `visit` on each directory, and stop at (and
 * including) `root`. Never looks at or above the home directory: a marker in `~`
 * would silently claim every folder the user owns.
 */
function walkUp(cwd, { home, root }, visit) {
  const homeResolved = path.resolve(home)
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) return null
    const found = visit(dir)
    if (found) return found
    if (root && dir === path.resolve(root)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** `<dir>/.devspec/project.json` → `{ project_id }`, or null when absent/unusable. */
function readPin(dir) {
  const candidate = path.join(dir, '.devspec', 'project.json')
  try {
    if (!fs.existsSync(candidate)) return null
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
    const id = typeof parsed?.project_id === 'string' ? parsed.project_id.trim() : ''
    if (id) return { kind: 'pin', project_id: id, path: candidate }
  } catch {
    /* an unreadable or malformed pin is simply not a pin */
  }
  return null
}

/** Object keys, but only for a real plain object — `Object.keys('ab')` is `['0','1']`. */
function keysOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
}

function namesDevSpec(values) {
  return values.some((value) => typeof value === 'string' && DEVSPEC_NAME.test(value))
}

/**
 * Does this parsed config register DevSpec for the folder it sits in?
 *
 * Deliberately keyed on the specific registration fields rather than searching the
 * document for the word: a settings file that merely mentions a devspec path is not
 * a declaration that this folder is a DevSpec project.
 */
function declaresDevSpec(parsed) {
  if (namesDevSpec(keysOf(parsed?.mcpServers))) return true
  if (Array.isArray(parsed?.enabledMcpjsonServers) && namesDevSpec(parsed.enabledMcpjsonServers)) return true
  if (namesDevSpec(keysOf(parsed?.enabledPlugins))) return true
  return false
}

/** The first config file in `dir` that registers DevSpec, or null. */
function readMcpDeclaration(dir) {
  for (const relative of MCP_CONFIG_FILES) {
    const candidate = path.join(dir, ...relative)
    try {
      if (!fs.existsSync(candidate)) continue
      if (declaresDevSpec(JSON.parse(fs.readFileSync(candidate, 'utf8')))) {
        return { kind: 'mcp-config', path: candidate }
      }
    } catch {
      /* an unreadable or malformed config declares nothing */
    }
  }
  return null
}

/**
 * The repository's MAIN working tree for `cwd`, or null when there is no repository.
 *
 * `--git-common-dir` is one identity for a repository and all of its worktrees; the
 * main working tree is that path's parent when it ends in `.git`. A bare repository
 * has no working tree, so it answers null.
 */
export function mainWorkTreeFrom(cwd) {
  try {
    const common = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim()
    if (!common) return null
    const resolved = path.resolve(common)
    return path.basename(resolved) === '.git' ? path.dirname(resolved) : null
  } catch {
    return null
  }
}

/**
 * The repository's `.devspec/project.json` pin: `{ "project_id": "<uuid>" }`.
 *
 * Searched from `cwd` upward, stopping at (and including) the git repository root,
 * and never at or above the home directory — a pin in `~` would silently claim every
 * folder the user owns. The nearest pin wins.
 *
 * Then, if the cwd chain has nothing, the repository's MAIN working tree. The pin is
 * normally untracked, so a linked worktree carries none — and the implementation
 * contract requires work to happen in one, which would leave every isolated session
 * unable to name its own project. Jurisdiction is a property of the repository, not
 * of the directory (contract 4.1.0, `commit_provenance_contract.project_association`);
 * `devspecFolderMarker` has always answered it that way and this now matches.
 */
export function findProjectPin(cwd, { home = os.homedir(), root = undefined, mainWorktree = undefined } = {}) {
  const stopAt = root === undefined ? gitRoot(cwd) : root
  const found = walkUp(cwd, { home, root: stopAt }, readPin)
  if (found) return { project_id: found.project_id, path: found.path }

  const main = mainWorktree === undefined ? mainWorkTreeFrom(cwd) : mainWorktree
  if (!main) return null
  const resolvedMain = path.resolve(main)
  if (atOrAboveHome(resolvedMain, path.resolve(home))) return null
  const fromMain = readPin(resolvedMain)
  return fromMain ? { project_id: fromMain.project_id, path: fromMain.path } : null
}

/**
 * The marker that gives the claim guard jurisdiction over this folder, or null.
 *
 * Either marker is enough, because either one means a person deliberately pointed
 * this folder at DevSpec:
 *  - a `.devspec/project.json` pin — the folder naming its project outright;
 *  - a project-scoped config registering a DevSpec MCP server or this plugin.
 *
 * `mainWorktree` is checked in addition to the cwd chain, and it is the reason this
 * function is not just a pin lookup. The implementation contract asks agents to work
 * in a linked worktree, worktrees are routinely created OUTSIDE the repository root,
 * and `.mcp.json` / `.claude/settings.local.json` are typically untracked — so the
 * worktree's own checkout carries no marker even though its repository plainly is a
 * DevSpec project. Keying jurisdiction on the cwd chain alone would quietly switch
 * the guard off for exactly the isolation it tells agents to use.
 */
export function devspecFolderMarker(cwd, {
  home = os.homedir(),
  root = undefined,
  mainWorktree = undefined,
} = {}) {
  const stopAt = root === undefined ? workTreeRootFrom(cwd, { home }) : root
  const inChain = walkUp(cwd, { home, root: stopAt }, (dir) => readPin(dir) ?? readMcpDeclaration(dir))
  if (inChain) return inChain

  if (!mainWorktree) return null
  const main = path.resolve(mainWorktree)
  if (atOrAboveHome(main, path.resolve(home))) return null
  return readPin(main) ?? readMcpDeclaration(main)
}
