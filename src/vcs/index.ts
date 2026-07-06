/**
 * Git worktree operations
 */

import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as path from 'path';
import type {
  WorktreeContext,
  CreateWorktreeParams,
  WorktreeResult,
  MergeToTargetParams,
  ProtectedPathCheckParams,
} from './types.js';
import type { RepositoryInfo } from '../types.js';

export * from './types.js';

// ---------------------------------------------------------------------------
// URL Normalization (009-runner-repo-guard)
// ---------------------------------------------------------------------------

/**
 * Normalize a git remote URL to canonical `host/owner/repo` format.
 */
export function normalizeRepoUrl(url: string): string {
  let result = url.trim();

  // SSH shorthand: git@host:owner/repo.git → host/owner/repo
  const sshMatch = result.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (sshMatch) {
    result = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    result = result.replace(/^(?:https?|ssh|git):\/\//, '');
    result = result.replace(/^[^@]+@/, '');
    result = result.replace(/:\d+(?=\/)/, '');
  }

  result = result.replace(/\.git$/, '');
  result = result.replace(/\/+$/, '');

  const slashIdx = result.indexOf('/');
  if (slashIdx > 0) {
    result = result.slice(0, slashIdx).toLowerCase() + result.slice(slashIdx);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Workspace Repository Collection (009-runner-repo-guard)
// ---------------------------------------------------------------------------

/**
 * Collect repository info for the root repo and immediate child directories.
 * Excludes worktree directories (where .git is a file, not a directory).
 */
export async function collectWorkspaceRepos(
  rootPath: string,
  worktreeBasePath?: string,
): Promise<RepositoryInfo[]> {
  const repos: RepositoryInfo[] = [];

  // Collect root repo
  const rootInfo = await getRepoInfo(rootPath, path.basename(rootPath));
  if (rootInfo) {
    repos.push(rootInfo);
  }

  // Scan immediate children for .git directories
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const childPath = path.join(rootPath, entry.name);

    // Exclude worktree base directory
    if (worktreeBasePath && childPath.startsWith(worktreeBasePath)) continue;

    const gitPath = path.join(childPath, '.git');
    if (!(await fs.pathExists(gitPath))) continue;

    // Exclude worktree checkouts (where .git is a file pointing to main repo)
    const gitStat = await fs.stat(gitPath);
    if (gitStat.isFile()) continue;

    const info = await getRepoInfo(childPath, entry.name);
    if (info) {
      repos.push(info);
    }
  }

  return repos;
}

async function getRepoInfo(repoPath: string, name: string): Promise<RepositoryInfo | null> {
  try {
    // Get remote URL (skip repos with no remote)
    const { stdout: remoteUrl } = await execa('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
    });
    if (!remoteUrl.trim()) return null;

    // Get current branch (empty if detached)
    let branch: string | null = null;
    let detached = false;
    try {
      const { stdout: branchOut } = await execa('git', ['branch', '--show-current'], {
        cwd: repoPath,
      });
      branch = branchOut.trim() || null;
      detached = !branch;
    } catch {
      detached = true;
    }

    // Get short SHA
    const { stdout: sha } = await execa('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoPath,
    });

    return {
      name,
      remote_url: remoteUrl.trim(),
      normalized_url: normalizeRepoUrl(remoteUrl.trim()),
      branch,
      detached,
      short_sha: sha.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Re-read branch and SHA for previously discovered repos.
 * The directory scan + remote URL lookup is expensive and rarely changes,
 * but branch/SHA can change at any time (user switches branch in another terminal).
 * This function is fast — just two git commands per repo.
 */
export async function refreshRepoBranches(
  rootPath: string,
  repos: RepositoryInfo[],
): Promise<RepositoryInfo[]> {
  const refreshed: RepositoryInfo[] = [];
  for (const repo of repos) {
    const repoPath = repo.name === path.basename(rootPath)
      ? rootPath
      : path.join(rootPath, repo.name);
    try {
      let branch: string | null = null;
      let detached = false;
      try {
        const { stdout: branchOut } = await execa('git', ['branch', '--show-current'], {
          cwd: repoPath,
        });
        branch = branchOut.trim() || null;
        detached = !branch;
      } catch {
        detached = true;
      }
      const { stdout: sha } = await execa('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoPath,
      });
      refreshed.push({
        ...repo,
        branch,
        detached,
        short_sha: sha.trim(),
      });
    } catch {
      refreshed.push(repo); // keep stale data if git fails
    }
  }
  return refreshed;
}

/**
 * Check if path is a git repository
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  const gitPath = path.join(repoPath, '.git');
  return fs.pathExists(gitPath);
}

/**
 * Generate a unique worktree name from task ID and timestamp
 */
export function generateWorktreeName(taskId: string): string {
  const timestamp = Date.now();
  const shortId = taskId.slice(0, 8);
  return `task-${shortId}-${timestamp}`;
}

/**
 * Get the worktree base directory path
 */
export function getWorktreeBasePath(mainRepoPath: string, basePath?: string): string {
  if (basePath) {
    return basePath;
  }
  // Default: sibling .worktrees directory
  const parentDir = path.dirname(mainRepoPath);
  const repoName = path.basename(mainRepoPath);
  return path.join(parentDir, `.${repoName}-worktrees`);
}

/**
 * Symlink/junction node_modules from the main repo into a worktree.
 * Uses 'junction' type on Windows (works without admin privileges)
 * and a regular directory symlink on other platforms.
 * Silently skips if the main repo has no node_modules.
 */
async function linkNodeModules(mainRepoPath: string, worktreePath: string): Promise<void> {
  const source = path.join(mainRepoPath, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');

  if (!(await fs.pathExists(source))) {
    return; // Nothing to link
  }

  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(source, target, type);
  } catch (err) {
    // Non-fatal — the skill prompt will skip tests if node_modules is unavailable
    console.warn(`[vcs] Failed to link node_modules: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create a git worktree
 */
export async function createWorktree(params: CreateWorktreeParams): Promise<WorktreeContext> {
  const { mainRepoPath, taskId, basePath, branchPrefix } = params;

  // Verify it's a git repo
  if (!(await isGitRepo(mainRepoPath))) {
    throw new Error(`Not a git repository: ${mainRepoPath}`);
  }

  const name = generateWorktreeName(taskId);
  const branchName = `${branchPrefix}${name}`;
  const worktreeBase = getWorktreeBasePath(mainRepoPath, basePath);
  const worktreePath = path.join(worktreeBase, name);

  // Ensure base directory exists
  await fs.ensureDir(worktreeBase);

  // Create worktree with new branch
  await execa('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: mainRepoPath,
  });

  // Link node_modules from main repo into worktree (junction on Windows, symlink on Unix).
  // This avoids a full npm install and ensures the worktree can run typecheck/tests.
  await linkNodeModules(mainRepoPath, worktreePath);

  return {
    mainRepoPath,
    worktreePath,
    branchName,
    createdAt: new Date(),
  };
}

/**
 * Commit and push changes in a git worktree
 */
export async function commitAndPush(
  ctx: WorktreeContext,
  message: string,
  remote: string = 'origin'
): Promise<WorktreeResult> {
  const { worktreePath, branchName } = ctx;

  // Track whether we detected changes (for accurate error reporting)
  let hadChanges = false;

  try {
    // Discover changed files explicitly (avoid staging unintended files with -A)
    const { stdout: diffFiles } = await execa('git', ['diff', '--name-only'], { cwd: worktreePath });
    const { stdout: untrackedFiles } = await execa(
      'git', ['ls-files', '--others', '--exclude-standard'],
      { cwd: worktreePath },
    );

    const changedFiles = [
      ...diffFiles.split('\n').filter(Boolean),
      ...untrackedFiles.split('\n').filter(Boolean),
    ];

    if (changedFiles.length === 0) {
      return { success: true, pushed: false, hadChanges: false };
    }

    // Stage only the specific changed files
    await execa('git', ['add', ...changedFiles], { cwd: worktreePath });

    // Now we know there are changes
    hadChanges = true;

    // Commit changes
    await execa('git', ['commit', '-m', message], { cwd: worktreePath });

    // Get commit SHA
    const { stdout: sha } = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });

    // Push to remote
    await execa('git', ['push', '-u', remote, branchName], { cwd: worktreePath });

    return {
      success: true,
      commitSha: sha.trim(),
      pushed: true,
      hadChanges: true,
    };
  } catch (error) {
    return {
      success: false,
      pushed: false,
      hadChanges, // Use the tracked value, not assumed true
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove the node_modules link that linkNodeModules() created in a worktree.
 *
 * This MUST happen before `git worktree remove --force`. On Windows, node_modules
 * is a `junction` (a directory reparse point) pointing at the MAIN checkout's
 * node_modules. `git worktree remove --force` recursively deletes the worktree
 * directory, and that recursion follows the junction into the main checkout and
 * wipes its real node_modules contents — leaving an empty directory behind and
 * breaking the main checkout's tooling. Dropping the link first makes the delete
 * stop at the worktree boundary.
 *
 * The isSymbolicLink() guard means we only ever remove a link/junction, never a
 * real node_modules directory. Junctions and dir-symlinks differ in how they're
 * unlinked (unlink on Unix, rmdir for some Windows setups), so we try both.
 */
async function unlinkNodeModules(worktreePath: string): Promise<void> {
  const link = path.join(worktreePath, 'node_modules');
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) return; // Real directory (or nothing) — never touch it.
    try {
      await fs.unlink(link);
    } catch {
      // Some Windows directory junctions reject unlink — rmdir removes the
      // reparse point itself without recursing into (or deleting) the target.
      await fs.rmdir(link);
    }
  } catch {
    // No link present (already gone, or never created) — nothing to do.
  }
}

/**
 * Remove a git worktree with retry logic.
 * Retries once after a short delay to handle race conditions
 * (e.g., file locks from recently completed processes).
 */
export async function removeWorktree(ctx: WorktreeContext): Promise<void> {
  const { mainRepoPath, worktreePath } = ctx;

  // Drop the node_modules junction BEFORE removing the worktree, or the force
  // delete follows it and wipes the main checkout's node_modules (see above).
  await unlinkNodeModules(worktreePath);

  const tryRemove = async () => {
    await execa('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: mainRepoPath,
    });
  };

  try {
    await tryRemove();
  } catch {
    // Retry once after a short delay (handles file lock race conditions)
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tryRemove();
  }
}

/**
 * Check if a worktree exists
 */
export async function worktreeExists(ctx: WorktreeContext): Promise<boolean> {
  return fs.pathExists(ctx.worktreePath);
}

/**
 * Merge a worktree branch into a target branch.
 * Fetches latest target, checks out target, merges feature branch, pushes.
 * On conflict, returns error instead of force-pushing.
 */
export async function mergeToTarget(params: MergeToTargetParams): Promise<WorktreeResult> {
  const { ctx, targetBranch, remote = 'origin' } = params;
  const { mainRepoPath, branchName } = ctx;

  try {
    // Fetch latest target branch
    await execa('git', ['fetch', remote, targetBranch], { cwd: mainRepoPath });

    // Merge feature branch into target (using main repo, not worktree)
    await execa('git', ['checkout', targetBranch], { cwd: mainRepoPath });
    await execa('git', ['merge', branchName, '--no-ff', '--no-edit', '-m', `Merge ${branchName} into ${targetBranch}`], {
      cwd: mainRepoPath,
    });
    await execa('git', ['push', remote, targetBranch], { cwd: mainRepoPath });

    return { success: true, pushed: true, merged: true, hadChanges: true };
  } catch (error) {
    // Abort merge if in progress
    try {
      await execa('git', ['merge', '--abort'], { cwd: mainRepoPath });
    } catch {
      // Ignore — merge abort may fail if no merge in progress
    }
    // Restore original branch
    try {
      await execa('git', ['checkout', '-'], { cwd: mainRepoPath });
    } catch {
      // Best effort
    }
    return {
      success: false,
      pushed: false,
      merged: false,
      hadChanges: true,
      error: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check if any staged/changed files match protected path patterns.
 * Returns list of violations.
 */
export async function validateProtectedPaths(params: ProtectedPathCheckParams): Promise<string[]> {
  const { workingDir, protectedPaths } = params;

  if (!protectedPaths.length) return [];

  const { stdout } = await execa('git', ['diff', '--name-only', '--cached'], { cwd: workingDir });
  const { stdout: unstaged } = await execa('git', ['diff', '--name-only'], { cwd: workingDir });

  const allChanged = [...new Set([...stdout.split('\n'), ...unstaged.split('\n')].filter(Boolean))];

  const violations: string[] = [];
  for (const file of allChanged) {
    for (const pattern of protectedPaths) {
      // Simple glob matching: support * and ** patterns
      const regex = new RegExp(
        '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '___GLOBSTAR___')
          .replace(/\*/g, '[^/]*')
          .replace(/___GLOBSTAR___/g, '.*') +
        '$'
      );
      if (regex.test(file)) {
        violations.push(`Protected path violation: ${file} matches pattern ${pattern}`);
        break;
      }
    }
  }

  return violations;
}
