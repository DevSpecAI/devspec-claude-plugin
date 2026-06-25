import { z } from 'zod';

// =============================================================================
// Agent Status
// =============================================================================

export const AgentStatusSchema = z.enum([
  'planning',
  'queued',
  'implementing',
  'finished',
  'failed',
  'reporting',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// =============================================================================
// Action Item (from DevSpec MCP)
// =============================================================================

export const ActionItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  intent: z.string().nullable().optional(),
  acceptance_criteria: z.string().nullable().optional(),
  ai_instructions: z.string().nullable().optional(),
  source_session_id: z.string().nullable().optional(),
  lifecycle: z.string(),
  type: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  agent_ready: z.boolean(),
  agent_activity: AgentStatusSchema.nullable(),
  agent_claimed_at: z.string().nullable().optional(),
  agent_error: z.string().nullable().optional(),
  agent_branch: z.string().nullable().optional(),
  agent_commit_sha: z.string().nullable().optional(),
  project_id: z.string().uuid().optional(),
  created_at: z.string().optional(),
  lifecycle_state: z.string().nullable().optional(),
  attention_reason: z.string().nullable().optional(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

// =============================================================================
// Autopilot Configuration (from DevSpec project settings)
// =============================================================================

export const AutopilotSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  auto_push: z.boolean().default(true),
  auto_merge: z.boolean().default(true),
  branch_prefix: z.string().default('autopilot/action-item-'),
  commit_message_prefix: z.string().default('[autopilot] '),
  custom_instructions: z.string().default(''),
  test_commands: z.object({
    unit: z.string().default(''),
    e2e: z.string().default(''),
    typecheck: z.string().default(''),
  }).default({}),
  protected_paths: z.array(z.string()).default([]),
  idle_detection: z.boolean().default(false),
  poll_interval_seconds: z.number().positive().default(3600),
  stale_claim_timeout_minutes: z.number().positive().default(30),
});
export type AutopilotSettings = z.infer<typeof AutopilotSettingsSchema>;

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = AutopilotSettingsSchema.parse({});

// =============================================================================
// Autopilot Cycle Result
// =============================================================================

export const CycleResultSchema = z.object({
  action: z.enum(['idle', 'claimed', 'completed', 'failed', 'planning_done', 'review_done', 'claim_lost', 'mcp_error', 'stopped']),
  actionItemId: z.string().optional(),
  actionItemTitle: z.string().optional(),
  commitSha: z.string().optional(),
  branchName: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});
export type CycleResult = z.infer<typeof CycleResultSchema>;

// =============================================================================
// Autopilot State
// =============================================================================

export interface AutopilotState {
  running: boolean;
  projectId: string;
  settings: AutopilotSettings;
  cycleCount: number;
  lastCycleResult: CycleResult | null;
  sessionId: string;
  machineHostname: string;
  tasksCompleted: number;
  gitUserEmail: string | null;
}

// =============================================================================
// Heartbeat (sent to DevSpec via MCP send_heartbeat tool)
// =============================================================================

export type RunnerStatus = 'idle' | 'working' | 'offline';

export interface HeartbeatPayload {
  session_id: string;
  machine_hostname: string;
  status: RunnerStatus;
  current_task_id?: string;
  current_task_title?: string;
  cycle_count?: number;
  tasks_completed?: number;
  last_error?: string;
  git_user_email?: string;
  repositories?: RepositoryInfo[];
}

// ---------------------------------------------------------------------------
// Repository Info (sent in heartbeat for validation — 009-runner-repo-guard)
// ---------------------------------------------------------------------------

export interface RepositoryInfo {
  name: string;
  remote_url: string;
  normalized_url: string;
  branch: string | null;
  detached: boolean;
  short_sha: string;
}

export type ValidationState =
  | 'aligned'
  | 'branch_mismatch'
  | 'repo_not_found'
  | 'manual_override';

export interface HeartbeatResponse {
  status: string;
  runner_id: string;
  timestamp: string;
  validation_state?: ValidationState;
  validation_details?: {
    expected_repos: Array<{ url: string; branch: string }>;
    mismatched_repos: Array<{
      url: string;
      expected_branch: string;
      actual_branch: string | null;
    }>;
    missing_repos: string[];
    message: string;
  };
}

// =============================================================================
// Execution History (adapted from scheduler)
// =============================================================================

export const ExecutionStatusSchema = z.enum([
  'success',
  'failure',
  'timeout',
  'skipped',
  'running',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionHistoryRecordSchema = z.object({
  id: z.string().uuid(),
  actionItemId: z.string().optional(),
  actionItemTitle: z.string().optional(),
  agentActivity: z.string().optional(),
  project: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: ExecutionStatusSchema,
  triggeredBy: z.string(),
  duration: z.number().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  worktreePushed: z.boolean().optional(),
});
export type ExecutionHistoryRecord = z.infer<typeof ExecutionHistoryRecordSchema>;
