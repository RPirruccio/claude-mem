/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 *
 * Gracefully degrades if worker is unavailable - observations are lost but
 * the session continues without blocking.
 * Only triggers on meaningful tools (Write|Edit|NotebookEdit|Bash) via matcher.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerUrl, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }

    const workerUrl = getWorkerUrl();
    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
      workerUrl
    });

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Send to worker with timeout - gracefully degrade if worker is unavailable
    try {
      const response = await fetchWithTimeout(`${workerUrl}/api/sessions/observations`, 3000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd
        })
      });

      if (!response) {
        logger.warn('HOOK', 'PostToolUse: Worker unavailable, observation not stored', { toolName });
        return { continue: true, suppressOutput: true };
      }

      if (!response.ok) {
        logger.warn('HOOK', `PostToolUse: Observation storage failed (${response.status})`, { toolName });
        return { continue: true, suppressOutput: true };
      }

      logger.debug('HOOK', 'Observation sent successfully', { toolName });
    } catch (error) {
      // Network error - worker not reachable, gracefully degrade
      logger.warn('HOOK', 'PostToolUse: Worker not reachable, observation not stored', {
        toolName,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return { continue: true, suppressOutput: true };
  }
};
