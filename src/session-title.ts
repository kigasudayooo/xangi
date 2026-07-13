/**
 * セッションタイトル導出ユーティリティ。
 *
 * Discord/Slack/Web のプロンプトにはメタデータ行（`[プラットフォーム: ...]` など）が
 * 先頭に付くため、UI に出すときはそれを剥がした最初の本文をタイトル候補として使う。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripReplySuggestionMarkup } from './reply-suggestions.js';

const PROMPT_METADATA_PATTERNS: RegExp[] = [
  /^\[runtime\][^\n]*\n?\n?/,
  /^\[プラットフォーム: [^\]]*\]\n?/,
  /^\[チャンネル: [^\]]*\]\n?/,
  /^\[スレッド: [^\]]*\]\n?/,
  /^\[発言者: [^\]]*\]\n?/,
  /^\[現在時刻: [^\]]*\]\n?/,
];

const PREFETCHED_HISTORY_BLOCK = /<prefetched-history\b[^>]*>[\s\S]*?<\/prefetched-history>\s*/g;
const PLATFORM_SYSTEM_CONTEXT_BLOCK = /<system-context\b[^>]*>[\s\S]*?<\/system-context>\s*/g;
const PREFETCH_FOLLOWUP =
  /初期文脈確認だけを目的に history コマンドを再実行しないでください。さらに古い履歴や追加件数が必要な場合だけ実行してください。\s*/g;
const REPLY_SUGGESTION_CONTEXT =
  /\s*\[system-context\]\s*通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を\d+件生成してください。[\s\S]*?<\/xangi_reply_suggestions>\s*$/;

/**
 * プロンプト先頭のメタデータ行を順に剥がして本文だけ返す。
 * 4種類のメタデータ行（プラットフォーム / チャンネル / 発言者 / 現在時刻）が
 * 並ぶ前提で、未指定の行はスキップして OK。
 */
export function stripPromptMetadata(text: string): string {
  let s = text
    .replace(PLATFORM_SYSTEM_CONTEXT_BLOCK, '')
    .replace(PREFETCHED_HISTORY_BLOCK, '')
    .replace(PREFETCH_FOLLOWUP, '')
    .replace(REPLY_SUGGESTION_CONTEXT, '');
  let changed = true;
  while (changed) {
    const before = s;
    for (const re of PROMPT_METADATA_PATTERNS) s = s.replace(re, '');
    s = s.trimStart();
    changed = s !== before;
  }
  return stripReplySuggestionMarkup(s).trim();
}

/**
 * セッションログ（logs/sessions/<id>.jsonl）の最初のユーザーメッセージから
 * 表示用タイトルを生成する。50 文字に切り詰める。導出できなければ空文字。
 */
export function deriveTitleFromFirstMessage(workdir: string, sessionId: string): string {
  try {
    const filePath = join(workdir, 'logs', 'sessions', `${sessionId}.jsonl`);
    if (!existsSync(filePath)) return '';
    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
    if (!firstLine) return '';
    const entry = JSON.parse(firstLine) as { role?: string; content?: unknown };
    if (entry.role !== 'user' || typeof entry.content !== 'string') return '';
    return stripPromptMetadata(entry.content).slice(0, 50);
  } catch {
    return '';
  }
}
