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

export * from './types.js';

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
    // Stage all changes
    await execa('git', ['add', '-A'], { cwd: worktreePath });

    // Check if there are staged changes
    const { stdout: status } = await execa('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    });

    if (!status.trim()) {
      return { success: true, pushed: false, hadChanges: false };
    }

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
 * Remove a git worktree with retry logic.
 * Retries once after a short delay to handle race conditions
 * (e.g., file locks from recently completed processes).
 */
export async function removeWorktree(ctx: WorktreeContext): Promise<void> {
  const { mainRepoPath, worktreePath } = ctx;

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
    await execa('git', ['merge', branchName, '--no-ff', '-m', `Merge ${branchName} into ${targetBranch}`], {
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
