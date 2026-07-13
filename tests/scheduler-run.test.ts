import { describe, expect, it } from 'vitest';
import { createSchedulerRunId, isSchedulerRunId } from '../src/scheduler-run.js';

describe('scheduler run ids', () => {
  it('creates identifiable stateless run ids', () => {
    const id = createSchedulerRunId('discord', 1783929000000);
    expect(id).toMatch(/^scheduler-run-discord-1783929000000-[a-f0-9]{8}$/);
    expect(isSchedulerRunId(id)).toBe(true);
  });

  it('recognizes legacy scheduler transcript ids without hiding normal sessions', () => {
    expect(isSchedulerRunId('0mp9jvas3_b78f9618-1783929000000')).toBe(true);
    expect(isSchedulerRunId('0mp9jvas3_b78f9618')).toBe(false);
  });
});
