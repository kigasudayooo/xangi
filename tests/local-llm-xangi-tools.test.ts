import { describe, expect, it } from 'vitest';
import { getXangiTools } from '../src/local-llm/xangi-tools.js';

function names(platform?: Parameters<typeof getXangiTools>[0]): string[] {
  return getXangiTools(platform).map((tool) => tool.name);
}

describe('Local LLM xangi tools by platform', () => {
  it('web sessions expose web_history but not Discord tools', () => {
    const toolNames = names('web');

    expect(toolNames).toContain('web_history');
    expect(toolNames).toContain('media_send');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('discord_send');
    expect(toolNames).not.toContain('slack_history');
  });

  it('Discord sessions expose Discord tools but not web_history', () => {
    const toolNames = names('discord');

    expect(toolNames).toContain('discord_history');
    expect(toolNames).toContain('discord_send');
    expect(toolNames).not.toContain('web_history');
    expect(toolNames).not.toContain('slack_history');
  });

  it('keeps the legacy all-platform set when platform is unknown', () => {
    const toolNames = names();

    expect(toolNames).toContain('discord_history');
    expect(toolNames).toContain('web_history');
    expect(toolNames).toContain('slack_history');
  });
});
