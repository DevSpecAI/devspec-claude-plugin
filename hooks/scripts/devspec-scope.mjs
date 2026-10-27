#!/usr/bin/env node
/**
 * Where a folder stands in relation to DevSpec.
 *
 * Two questions live here, and both are answered from the filesystem alone — no
 * network, no server round trip — because the callers are a PreToolUse hook that
 * runs before every mutation and a connect script that must work offline:
 *
 *  - WHICH project does this folder belong to?      → `findProjectPin`
 *  - Where is the repository, and its main working tree? → `gitRoot`, `mainWorkTreeFrom`
 *
 * Whether a repository is the connected project's at all is the implementation
 * contract's `commit_provenance_contract.project_association`: a project pin, or a
 * remote that is one of the connected project's repositories. The pin half is
 * answered here; the remote half needs the connection (commit-stamp.mjs
 * `projectScope`). A DevSpec server declared in a folder's MCP configuration says
 * DevSpec is used there, not that the repository is the project's, so it gives no
 * jurisdiction (item f7f12de1). Absence of both is not "unknown, therefore deny": it
 * is "not ours" (devspec:7be7469f).
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/** A stat signature for one path: absent, a directory, or a file's mtime and size. */
function statKey(candidate) {
  try {
    const stat = fs.statSync(candidate)
    // A directory's mtime moves whenever git writes a lock file inside `.git`, which is
    // most commands. Only its presence can change what the folder is linked to.
    return stat.isDirectory() ? 'd' : `f:${stat.mtimeMs}:${stat.size}`
  } catch {
    return '-'
  }
}

/**
 * The files behind a `.git` entry that decide `origin` and the main worktree's pin.
 * A plain repository keeps its remotes in `.git/config`. A linked worktree's `.git` is
 * a file naming its private gitdir, whose `commondir` leads to the shared config — and
 * `findProjectPin` also reads the main working tree's pin, which sits beside it.
 */
function gitIdentityPaths(gitEntry) {
  try {
    if (fs.statSync(gitEntry).isDirectory()) return [path.join(gitEntry, 'config')]
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitEntry, 'utf8'))
    if (!pointer) return []
    const gitdir = path.resolve(path.dirname(gitEntry), pointer[1].trim())
    let common = gitdir
    try {
      common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
    } catch {
      /* no commondir: the gitdir is the repository itself */
    }
    const paths = [path.join(common, 'config')]
    if (path.basename(common) === '.git') {
      paths.push(path.join(path.dirname(common), '.devspec', 'project.json'))
    }
    return paths
  } catch {
    return []
  }
}

/**
 * A cheap signature of everything that could make `cwd` name a DevSpec project: the
 * pin files `findProjectPin` reads and the git config that holds `origin`. Stat calls
 * only, never a git process, because the startup listener recomputes it every few
 * seconds while it waits in a folder that is not linked yet (item fa9b809b). When the
 * signature changes, the caller runs the real lookups; when it doesn't, nothing that
 * decides the folder's project can have changed.
 *
 * Walks the same chain as `findProjectPin`: from `cwd` up to the nearest `.git`
 * (the repository root), never at or above the home directory.
 */
export function folderLinkFingerprint(cwd, { home = os.homedir() } = {}) {
  const homeResolved = path.resolve(home)
  const parts = []
  let dir = path.resolve(cwd)
  for (;;) {
    if (atOrAboveHome(dir, homeResolved)) break
    parts.push(statKey(path.join(dir, '.devspec', 'project.json')))
    const gitEntry = path.join(dir, '.git')
    const gitKey = statKey(gitEntry)
    parts.push(gitKey)
    if (gitKey !== '-') {
      for (const identity of gitIdentityPaths(gitEntry)) parts.push(statKey(identity))
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return parts.join('|')
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
 * of the directory (`commit_provenance_contract.project_association`).
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
