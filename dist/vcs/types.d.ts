/**
 * VCS type definitions for git worktree management
 */
/**
 * Context for an active git worktree
 */
export interface WorktreeContext {
    /** Path to the main repository */
    mainRepoPath: string;
    /** Path to the worktree */
    worktreePath: string;
    /** Branch name */
    branchName: string;
    /** When the worktree was created */
    createdAt: Date;
}
/**
 * Parameters for creating a worktree
 */
export interface CreateWorktreeParams {
    /** Path to the main repository */
    mainRepoPath: string;
    /** Task ID (used for naming) */
    taskId: string;
    /** Base path for worktrees (optional, defaults to sibling .worktrees dir) */
    basePath?: string;
    /** Branch name prefix */
    branchPrefix: string;
}
/**
 * Result of commit and push operation
 */
export interface WorktreeResult {
    /** Whether the operation succeeded */
    success: boolean;
    /** Commit SHA */
    commitSha?: string;
    /** Whether changes were pushed */
    pushed: boolean;
    /** Whether changes were merged to target branch */
    merged?: boolean;
    /** Error message if failed */
    error?: string;
    /** Whether there were any changes to commit */
    hadChanges: boolean;
}
/**
 * Parameters for merging to target branch
 */
export interface MergeToTargetParams {
    /** Worktree context with branch info */
    ctx: WorktreeContext;
    /** Target branch to merge into */
    targetBranch: string;
    /** Remote name (default: origin) */
    remote?: string;
}
/**
 * Check if any changed files match protected path patterns
 */
export interface ProtectedPathCheckParams {
    /** Working directory to check */
    workingDir: string;
    /** Glob patterns for protected paths */
    protectedPaths: string[];
}
//# sourceMappingURL=types.d.ts.map