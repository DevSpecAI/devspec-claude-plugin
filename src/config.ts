import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import { execSync } from 'child_process';
import type { AutopilotSettings, AutopilotState, CycleResult } from './types.js';
import { DEFAULT_AUTOPILOT_SETTINGS, AutopilotSettingsSchema } from './types.js';

// =============================================================================
// Path Utilities
// =============================================================================

export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function getLogsDir(): string {
  return path.join(getGlobalConfigDir(), 'logs');
}

export function getTaskLogPath(taskId: string): string {
  return path.join(getLogsDir(), `${taskId}.log`);
}

// =============================================================================
// Autopilot State Management
// =============================================================================

let autopilotState: AutopilotState | null = null;

export function getAutopilotState(): AutopilotState | null {
  return autopilotState;
}

export function initAutopilotState(projectId: string, settings: AutopilotSettings): AutopilotState {
  // Read git user.email once at startup for runner identity attribution
  let gitUserEmail: string | null = null;
  try {
    const email = execSync('git config user.email', { encoding: 'utf8', timeout: 5000 }).trim();
    if (email) gitUserEmail = email;
  } catch {
    // Silently ignore — server handles null gracefully
  }

  autopilotState = {
    running: true,
    projectId,
    settings,
    cycleCount: 0,
    lastCycleResult: null,
    sessionId: crypto.randomUUID(),
    machineHostname: os.hostname(),
    tasksCompleted: 0,
    gitUserEmail,
  };
  return autopilotState;
}

export function updateCycleResult(result: CycleResult): void {
  if (autopilotState) {
    autopilotState.cycleCount++;
    autopilotState.lastCycleResult = result;
    if (result.action === 'completed') {
      autopilotState.tasksCompleted++;
    }
  }
}

export function stopAutopilot(): void {
  if (autopilotState) {
    autopilotState.running = false;
  }
}

export function isAutopilotRunning(): boolean {
  return autopilotState?.running ?? false;
}

// =============================================================================
// Settings Parsing
// =============================================================================

export function parseAutopilotSettings(raw: unknown): AutopilotSettings {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_AUTOPILOT_SETTINGS;
  }
  try {
    return AutopilotSettingsSchema.parse(raw);
  } catch {
    return DEFAULT_AUTOPILOT_SETTINGS;
  }
}

// =============================================================================
// Directory Initialization
// =============================================================================

export async function ensureGlobalConfigDir(): Promise<void> {
  const configDir = getGlobalConfigDir();
  const logsDir = getLogsDir();
  await fs.ensureDir(configDir);
  await fs.ensureDir(logsDir);
}
