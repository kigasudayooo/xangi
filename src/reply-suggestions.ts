const START = '<xangi_reply_suggestions>';
const END = '</xangi_reply_suggestions>';

export function appendReplySuggestionInstruction(prompt: string, count = 3): string {
  const example = Array.from({ length: count }, (_, index) => `候補${index + 1}`);
  return `${prompt}\n\n[system-context]\n通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を${count}件生成してください。出力の末尾に次の形式を厳密に付け、通常の回答本文では候補に言及しないでください。候補はユーザー視点の自然な日本語にしてください。\n${START}${JSON.stringify(example)}${END}`;
}

export function extractReplySuggestions(
  output: string,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const pattern = new RegExp(`${START}([\\s\\S]*?)${END}`, 'g');
  let suggestions: string[] = [];
  const text = output
    .replace(pattern, (_match, raw: string) => {
      try {
        const parsed = JSON.parse(raw.trim());
        if (Array.isArray(parsed)) {
          suggestions = parsed
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .slice(0, count);
        }
      } catch {
        // 壊れた候補ブロックはユーザーへ見せず、候補なしとして扱う。
      }
      return '';
    })
    .trimEnd();
  return { text: stripReplySuggestionMarkup(text), suggestions };
}

/** 候補機能がOFFでも内部タグを除去し、候補自体は公開しない。 */
export function sanitizeReplySuggestionOutput(
  output: string,
  enabled: boolean,
  count = 3
): {
  text: string;
  suggestions: string[];
} {
  const extracted = extractReplySuggestions(output, count);
  if (!enabled) extracted.suggestions = [];
  return extracted;
}

/** ストリーミング途中を含め、内部候補ブロック以降を表示テキストから隠す。 */
export function stripReplySuggestionMarkup(output: string): string {
  const startIndex = output.indexOf('<xangi_reply');
  return (startIndex >= 0 ? output.slice(0, startIndex) : output).trimEnd();
}

export function formatNumberedSuggestions(suggestions: string[]): string {
  return suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join('\n');
}

export function resolveReplySuggestionSkipPermissions(
  skipPermissions: boolean | undefined
): boolean {
  return skipPermissions ?? false;
}

export function fallbackReplySuggestions(count = 3): string[] {
  return [
    'もう少し詳しく教えて',
    'その方針で進めて',
    '別の案も見せて',
    '具体例を見せて',
    '注意点を教えて',
  ].slice(0, count);
}
