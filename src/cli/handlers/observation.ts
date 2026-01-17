/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 * 
 * OPTIMIZED: Removed ensureWorkerRunning() call since worker is started at SessionStart.
 * Only triggers on meaningful tools (Write|Edit|NotebookEdit|Bash) via matcher.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort, getWorkerHost } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Worker is already running from SessionStart - skip ensureWorkerRunning() for performance

    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }

    const host = getWorkerHost();
    const port = getWorkerPort();

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
      workerPort: port
    });

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://${host}:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!response.ok) {
      throw new Error(`Observation storage failed: ${response.status}`);
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName });

    return { continue: true, suppressOutput: true };
  }
};
