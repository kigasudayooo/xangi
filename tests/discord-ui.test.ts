import { describe, expect, it } from 'vitest';
import { createCompletedButtons, createReplySuggestionButtons } from '../src/discord/ui.js';

function customIds(options?: {
  showTools?: boolean;
  showLeave?: boolean;
  showReplySuggestions?: boolean;
}): string[] {
  return createCompletedButtons(options).components.map((button) => button.data.custom_id ?? '');
}

describe('createCompletedButtons', () => {
  it('shows Leave only for thread responses', () => {
    expect(customIds()).toEqual(['xangi_new']);
    expect(customIds({ showTools: true })).toEqual(['xangi_new', 'xangi_tools']);
    expect(customIds({ showLeave: true })).toEqual(['xangi_new', 'xangi_thread_leave']);
  });

  it('keeps New, Tools, and Leave in one row', () => {
    expect(customIds({ showTools: true, showLeave: true, showReplySuggestions: true })).toEqual([
      'xangi_new',
      'xangi_tools',
      'xangi_thread_leave',
      'xangi_reply_suggestions',
    ]);
  });
});

describe('createReplySuggestionButtons', () => {
  it('uses numbered labels in a separate row', () => {
    const buttons = createReplySuggestionButtons('123', 3).components;
    expect(buttons.map((button) => button.data.label)).toEqual(['1', '2', '3']);
    expect(buttons.map((button) => button.data.custom_id)).toEqual([
      'xangi_reply_suggestion_123_0',
      'xangi_reply_suggestion_123_1',
      'xangi_reply_suggestion_123_2',
    ]);
  });
});
