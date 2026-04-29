import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import type {
  ExecutionHistoryRecord,
  ExecutionStatus,
} from '../types.js';
import { ExecutionHistoryRecordSchema } from '../types.js';
import { getGlobalConfigDir } from '../config.js';

/**
 * Get the execution history file path
 */
export function getHistoryPath(): string {
  return path.join(getGlobalConfigDir(), 'execution-history.jsonl');
}

// =============================================================================
// History Storage
// =============================================================================

/**
 * Record an execution to the history file (append-only JSONL)
 */
export async function recordExecution(
  record: ExecutionHistoryRecord
): Promise<void> {
  const historyPath = getHistoryPath();
  await fs.ensureDir(path.dirname(historyPath));

  // Validate the record
  ExecutionHistoryRecordSchema.parse(record);

  // Append as JSONL (one JSON object per line)
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(historyPath, line, 'utf-8');
}

/**
 * Create a new execution history record
 */
export function createHistoryRecord(
  project: string,
  triggeredBy: string,
  options: {
    actionItemId?: string;
    actionItemTitle?: string;
    agentActivity?: string;
    worktreePath?: string;
    worktreeBranch?: string;
  } = {}
): ExecutionHistoryRecord {
  return {
    id: crypto.randomUUID(),
    actionItemId: options.actionItemId,
    actionItemTitle: options.actionItemTitle,
    agentActivity: options.agentActivity,
    project,
    startedAt: new Date().toISOString(),
    status: 'running',
    triggeredBy,
    worktreePath: options.worktreePath,
    worktreeBranch: options.worktreeBranch,
  };
}

/**
 * Complete an execution record with results
 */
export function completeHistoryRecord(
  record: ExecutionHistoryRecord,
  result: {
    status: ExecutionStatus;
    output?: string;
    error?: string;
    worktreePushed?: boolean;
  }
): ExecutionHistoryRecord {
  const completedAt = new Date().toISOString();
  const startTime = new Date(record.startedAt).getTime();
  const endTime = new Date(completedAt).getTime();

  return {
    ...record,
    completedAt,
    status: result.status,
    duration: endTime - startTime,
    output: result.output,
    error: result.error,
    worktreePushed: result.worktreePushed,
  };
}

// =============================================================================
// History Queries
// =============================================================================

export interface HistoryQueryOptions {
  limit?: number;
  status?: ExecutionStatus | ExecutionStatus[];
  actionItemTitle?: string;
  project?: string;
  since?: Date;
}

/**
 * Get recent executions from history with optional filters
 */
export async function getRecentExecutions(
  options: HistoryQueryOptions = {}
): Promise<ExecutionHistoryRecord[]> {
  const historyPath = getHistoryPath();

  if (!(await fs.pathExists(historyPath))) {
    return [];
  }

  const content = await fs.readFile(historyPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  let records: ExecutionHistoryRecord[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const record = ExecutionHistoryRecordSchema.parse(parsed);
      records.push(record);
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Apply filters
  if (options.status) {
    const statuses = Array.isArray(options.status)
      ? options.status
      : [options.status];
    records = records.filter((r) => statuses.includes(r.status));
  }

  if (options.actionItemTitle) {
    const searchTerm = options.actionItemTitle.toLowerCase();
    records = records.filter((r) =>
      (r.actionItemTitle ?? '').toLowerCase().includes(searchTerm)
    );
  }

  if (options.project) {
    const searchTerm = options.project.toLowerCase();
    records = records.filter((r) =>
      r.project.toLowerCase().includes(searchTerm)
    );
  }

  if (options.since) {
    const sinceTime = options.since.getTime();
    records = records.filter((r) => new Date(r.startedAt).getTime() >= sinceTime);
  }

  // Sort by startedAt descending (most recent first)
  records.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  // Apply limit
  const limit = options.limit ?? 10;
  return records.slice(0, limit);
}

/**
 * Get a single execution record by ID
 */
export async function getExecutionById(
  executionId: string
): Promise<ExecutionHistoryRecord | undefined> {
  const historyPath = getHistoryPath();

  if (!(await fs.pathExists(historyPath))) {
    return undefined;
  }

  const content = await fs.readFile(historyPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const record = ExecutionHistoryRecordSchema.parse(parsed);
      if (record.id === executionId) {
        return record;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Get execution statistics
 */
export async function getExecutionStats(
  options: { since?: Date } = {}
): Promise<{
  total: number;
  success: number;
  failure: number;
  timeout: number;
  skipped: number;
  running: number;
}> {
  const records = await getRecentExecutions({
    limit: 10000, // Get all for stats
    since: options.since,
  });

  return {
    total: records.length,
    success: records.filter((r) => r.status === 'success').length,
    failure: records.filter((r) => r.status === 'failure').length,
    timeout: records.filter((r) => r.status === 'timeout').length,
    skipped: records.filter((r) => r.status === 'skipped').length,
    running: records.filter((r) => r.status === 'running').length,
  };
}

// =============================================================================
// History Maintenance
// =============================================================================

/**
 * Clean up old history entries
 */
export async function cleanupOldHistory(
  retentionDays: number = 30
): Promise<number> {
  const historyPath = getHistoryPath();

  if (!(await fs.pathExists(historyPath))) {
    return 0;
  }

  const content = await fs.readFile(historyPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const keptLines: string[] = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const record = ExecutionHistoryRecordSchema.parse(parsed);
      if (new Date(record.startedAt).getTime() >= cutoffTime) {
        keptLines.push(line);
      } else {
        removed++;
      }
    } catch {
      // Keep malformed lines? Or remove them? Let's remove them.
      removed++;
    }
  }

  if (removed > 0) {
    await fs.writeFile(historyPath, keptLines.join('\n') + '\n', 'utf-8');
  }

  return removed;
}

// =============================================================================
// Log Content Reading
// =============================================================================

/**
 * Read the content of a log file
 */
export async function readLogContent(
  logPath: string,
  options: { tail?: number } = {}
): Promise<string> {
  try {
    if (!(await fs.pathExists(logPath))) {
      return '';
    }

    const content = await fs.readFile(logPath, 'utf-8');

    if (options.tail && options.tail > 0) {
      const lines = content.split('\n');
      return lines.slice(-options.tail).join('\n');
    }

    return content;
  } catch {
    return '';
  }
}

// =============================================================================
// Display Formatting
// =============================================================================

/**
 * Format a project path for display (truncate home directory)
 */
export function formatProjectPath(projectPath: string): string {
  const home = os.homedir();
  if (projectPath.startsWith(home)) {
    return '~' + projectPath.slice(home.length);
  }
  return projectPath;
}

/**
 * Get status icon for display
 */
export function getStatusIcon(status: ExecutionStatus): string {
  switch (status) {
    case 'success':
      return '\u2713 OK'; // ✓ OK
    case 'failure':
      return '\u2717 FAIL'; // ✗ FAIL
    case 'timeout':
      return '\u23F1 TIMEOUT'; // ⏱ TIMEOUT
    case 'skipped':
      return '\u2298 SKIP'; // ⊘ SKIP
    case 'running':
      return '\u25B6 RUN'; // ▶ RUN
  }
}

/**
 * Format time ago for display
 */
export function formatTimeAgo(date: Date | string): string {
  const now = new Date();
  const then = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (days === 1) {
    // Yesterday at HH:MM AM/PM
    return `Yesterday ${then.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })}`;
  }
  if (days < 7) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // Older than a week - show date
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '-';
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
