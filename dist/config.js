import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { DEFAULT_AUTOPILOT_SETTINGS, AutopilotSettingsSchema } from './types.js';
// =============================================================================
// Path Utilities
// =============================================================================
export function getGlobalConfigDir() {
    return path.join(os.homedir(), '.claude');
}
export function getLogsDir() {
    return path.join(getGlobalConfigDir(), 'logs');
}
export function getTaskLogPath(taskId) {
    return path.join(getLogsDir(), `${taskId}.log`);
}
// =============================================================================
// Autopilot State Management
// =============================================================================
let autopilotState = null;
export function getAutopilotState() {
    return autopilotState;
}
export function initAutopilotState(projectId, settings) {
    autopilotState = {
        running: true,
        projectId,
        settings,
        cycleCount: 0,
        lastCycleResult: null,
    };
    return autopilotState;
}
export function updateCycleResult(result) {
    if (autopilotState) {
        autopilotState.cycleCount++;
        autopilotState.lastCycleResult = result;
    }
}
export function stopAutopilot() {
    if (autopilotState) {
        autopilotState.running = false;
    }
}
export function isAutopilotRunning() {
    return autopilotState?.running ?? false;
}
// =============================================================================
// Settings Parsing
// =============================================================================
export function parseAutopilotSettings(raw) {
    if (!raw || typeof raw !== 'object') {
        return DEFAULT_AUTOPILOT_SETTINGS;
    }
    try {
        return AutopilotSettingsSchema.parse(raw);
    }
    catch {
        return DEFAULT_AUTOPILOT_SETTINGS;
    }
}
// =============================================================================
// Directory Initialization
// =============================================================================
export async function ensureGlobalConfigDir() {
    const configDir = getGlobalConfigDir();
    const logsDir = getLogsDir();
    await fs.ensureDir(configDir);
    await fs.ensureDir(logsDir);
}
//# sourceMappingURL=config.js.map