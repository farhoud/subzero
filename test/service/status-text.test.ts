import { describe, expect, it } from 'vitest';
import { describeTaskReply, formatElapsed } from '../../src/service/status-text.js';

describe('status text', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(65_000)).toBe('1m05s');
  });

  it('uses the parent adapter tool names in a started reply', () => {
    const reply = { kind: 'started' as const, taskId: 'task-1', startedAt: '2026-01-01T00:00:00Z' };
    expect(describeTaskReply(reply, undefined, { collect: 'subzero_await', cancel: 'subzero_cancel' }, Date.parse(reply.startedAt)))
      .toContain('collect it with subzero_await or cancel it with subzero_cancel');
  });
});
