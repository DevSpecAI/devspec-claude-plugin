// Types
export * from './types.js';

// Config utilities
export * from './config.js';

// Logging utilities
export {
  ensureLogsDir,
  readTaskLog,
  appendToLog,
  clearTaskLog,
  getLogSize,
  rotateLogIfNeeded,
  cleanupOldLogs,
} from './logs/index.js';

// Execution history
export {
  getHistoryPath,
  recordExecution,
  createHistoryRecord,
  completeHistoryRecord,
  getRecentExecutions,
  getExecutionById,
  getExecutionStats,
  cleanupOldHistory,
  formatProjectPath,
  getStatusIcon,
  readLogContent,
} from './history/index.js';
export type { HistoryQueryOptions } from './history/index.js';

// Git worktree utilities
export {
  isGitRepo,
  generateWorktreeName,
  getWorktreeBasePath,
  createWorktree,
  commitAndPush,
  removeWorktree,
  worktreeExists,
  mergeToTarget,
  validateProtectedPaths,
} from './vcs/index.js';
export type {
  WorktreeContext,
  CreateWorktreeParams,
  WorktreeResult,
  MergeToTargetParams,
  ProtectedPathCheckParams,
} from './vcs/types.js';

// Shell utilities
export {
  shellEscape,
  sanitizeForComment,
  isSafeIdentifier,
  GIT_REF_PATTERN,
  GIT_REMOTE_PATTERN,
  SAFE_PATH_PATTERN,
} from './utils/shell.js';

// Autopilot modules
export {
  buildPrompt,
  buildPlanningPrompt,
} from './autopilot/prompt.js';

export {
  prepareExecution,
  preparePlanningExecution,
  createSuccessResult,
  createFailureResult,
  createPlanningDoneResult,
  createIdleResult,
  createClaimLostResult,
  createMcpErrorResult,
} from './autopilot/executor.js';

export {
  createLoopContext,
  recordCycle,
  shouldContinue,
  formatCycleResult,
  formatStatus,
  resolveProjectFromRemoteMatch,
} from './autopilot/loop.js';
export type { ProjectResolution } from './autopilot/loop.js';

// MCP client helpers
export {
  generateBranchName,
  buildResolveProjectArgs,
  buildFetchNextWorkArgs,
  buildFetchByActivityArgs,
  buildGetProjectSummaryArgs,
  buildSearchMemoriesArgs,
  buildFetchPlanningArgs,
  buildFetchQueuedArgs,
  buildClaimArgs,
  buildReportSuccessArgs,
  buildReportFailureArgs,
  buildAddNoteArgs,
  buildAddCommitRefArgs,
  isStaleClaimAt,
  buildStaleFailArgs,
} from './mcp/client.js';
export type { ResolveProjectParams, RemoteMatch } from './mcp/client.js';
