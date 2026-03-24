/**
 * Git worktree operations
 */
import type { WorktreeContext, CreateWorktreeParams, WorktreeResult, MergeToTargetParams, ProtectedPathCheckParams } from './types.js';
export * from './types.js';
/**
 * Check if path is a git repository
 */
export declare function isGitRepo(repoPath: string): Promise<boolean>;
/**
 * Generate a unique worktree name from task ID and timestamp
 */
export declare function generateWorktreeName(taskId: string): string;
/**
 * Get the worktree base directory path
 */
export declare function getWorktreeBasePath(mainRepoPath: string, basePath?: string): string;
/**
 * Create a git worktree
 */
export declare function createWorktree(params: CreateWorktreeParams): Promise<WorktreeContext>;
/**
 * Commit and push changes in a git worktree
 */
export declare function commitAndPush(ctx: WorktreeContext, message: string, remote?: string): Promise<WorktreeResult>;
/**
 * Remove a git worktree with retry logic.
 * Retries once after a short delay to handle race conditions
 * (e.g., file locks from recently completed processes).
 */
export declare function removeWorktree(ctx: WorktreeContext): Promise<void>;
/**
 * Check if a worktree exists
 */
export declare function worktreeExists(ctx: WorktreeContext): Promise<boolean>;
/**
 * Merge a worktree branch into a target branch.
 * Fetches latest target, checks out target, merges feature branch, pushes.
 * On conflict, returns error instead of force-pushing.
 */
export declare function mergeToTarget(params: MergeToTargetParams): Promise<WorktreeResult>;
/**
 * Check if any staged/changed files match protected path patterns.
 * Returns list of violations.
 */
export declare function validateProtectedPaths(params: ProtectedPathCheckParams): Promise<string[]>;
//# sourceMappingURL=index.d.ts.map