import { stripPromptMetadata } from '../session-title.js';

const MAX_TITLE_LENGTH = 80;

/**
 * スレッド名を投稿本文から生成する。
 * プロンプトのメタ情報を除去し、空白を 1 つに畳んで先頭を切り出す。
 * AI バックエンドに依存しない決定的な処理（要約は行わない）。
 */
export function deriveThreadTitle(userText: string): string {
  const cleaned = stripPromptMetadata(userText).trim().replace(/\s+/g, ' ');
  return cleaned.slice(0, MAX_TITLE_LENGTH) || 'xangi';
}
