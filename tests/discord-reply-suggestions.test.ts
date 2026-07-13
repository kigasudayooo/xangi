import { describe, expect, it } from 'vitest';
import {
  appendReplySuggestionInstruction,
  extractReplySuggestions,
  fallbackReplySuggestions,
  formatNumberedSuggestions,
  resolveReplySuggestionSkipPermissions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from '../src/reply-suggestions.js';

describe('Discord reply suggestions', () => {
  it('adds a machine-readable generation instruction', () => {
    const prompt = appendReplySuggestionInstruction('質問', 3);
    expect(prompt).toContain('<xangi_reply_suggestions>');
    expect(prompt).toContain('3件');
  });

  it('extracts suggestions and removes the private block', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["詳しく教えて","進めて","別案は？"]</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({
      text: '回答です。',
      suggestions: ['詳しく教えて', '進めて', '別案は？'],
    });
  });

  it('hides malformed blocks and provides a deterministic fallback', () => {
    const output = '回答\n<xangi_reply_suggestions>broken</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({ text: '回答', suggestions: [] });
    expect(fallbackReplySuggestions()).toHaveLength(3);
  });

  it('removes stale suggestion markup even when suggestions are disabled', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["古い候補1","古い候補2"]</xangi_reply_suggestions>';
    expect(sanitizeReplySuggestionOutput(output, false)).toEqual({
      text: '回答です。',
      suggestions: [],
    });
  });

  it('hides a stale partial tag before it reaches streaming output', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_suggestions>["途中')).toBe(
      '回答です。'
    );
  });

  it('appends numbered suggestions to the visible response', () => {
    expect(formatNumberedSuggestions(['はい', 'いいえ'])).toBe('1. はい\n2. いいえ');
  });

  it('inherits the configured permission mode for suggestion turns', () => {
    expect(resolveReplySuggestionSkipPermissions(true)).toBe(true);
    expect(resolveReplySuggestionSkipPermissions(false)).toBe(false);
    expect(resolveReplySuggestionSkipPermissions(undefined)).toBe(false);
  });
});
