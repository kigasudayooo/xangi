/**
 * xangiコマンドのLocal LLM向けToolHandler
 *
 * CLIスクリプト (xangi-cmd.ts) を exec で呼び出す。
 * Discord接続時のみ discord_* ツールを追加。
 */
import { join } from 'path';
import type { ToolHandler, ToolResult } from './types.js';
import type { ChatPlatform } from '../prompts/index.js';

const CMD_TIMEOUT_MS = 30_000;

/**
 * xangi-cmd.js を実行してToolResultを返す
 */
async function runXangiCmd(args: string[], env?: Record<string, string>): Promise<ToolResult> {
  const cp = await import('child_process');
  const { promisify } = await import('util');
  const execFile = promisify(cp.execFile);

  // dist/cli/xangi-cmd.js のパスを解決
  const cmdPath = join(
    import.meta.url.replace('file://', '').replace(/\/local-llm\/xangi-tools\.js$/, ''),
    'cli',
    'xangi-cmd.js'
  );

  try {
    const { stdout, stderr } = await execFile('node', [cmdPath, ...args], {
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim(),
      error: e.message ?? String(err),
    };
  }
}

/**
 * フラグをCLI引数に変換
 */
function flagsToArgs(flags: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && value !== '') {
      args.push(`--${key}`, value);
    }
  }
  return args;
}

// ─── Discord Tools ──────────────────────────────────────────────────

const discordHistoryHandler: ToolHandler = {
  name: 'discord_history',
  description:
    'チャンネルの履歴を取得する。channel省略時は現在のチャンネルを使う。結果はDiscordに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID（省略時は現在のチャンネル）' },
      count: { type: 'string', description: '取得件数（デフォルト10、最大100）' },
      offset: { type: 'string', description: 'オフセット（古いメッセージに遡る）' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.channel) flags.channel = String(args.channel);
    if (args.count) flags.count = String(args.count);
    if (args.offset) flags.offset = String(args.offset);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['discord_history', ...flagsToArgs(flags)], env);
  },
};

const discordSendHandler: ToolHandler = {
  name: 'discord_send',
  description: '指定チャンネルにメッセージを送信する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      message: { type: 'string', description: '送信するメッセージ' },
    },
    required: ['channel', 'message'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_send',
      '--channel',
      String(args.channel),
      '--message',
      String(args.message),
    ]);
  },
};

const discordChannelsHandler: ToolHandler = {
  name: 'discord_channels',
  description: 'サーバーのチャンネル一覧を取得する。',
  parameters: {
    type: 'object',
    properties: {
      guild: { type: 'string', description: 'サーバー（ギルド）ID' },
    },
    required: ['guild'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['discord_channels', '--guild', String(args.guild)]);
  },
};

const discordSearchHandler: ToolHandler = {
  name: 'discord_search',
  description: 'チャンネル内のメッセージを検索する（最新100件から）。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      keyword: { type: 'string', description: '検索キーワード' },
    },
    required: ['channel', 'keyword'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_search',
      '--channel',
      String(args.channel),
      '--keyword',
      String(args.keyword),
    ]);
  },
};

const discordEditHandler: ToolHandler = {
  name: 'discord_edit',
  description: '自分のメッセージを編集する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      'message-id': { type: 'string', description: 'メッセージID' },
      content: { type: 'string', description: '新しいメッセージ内容' },
    },
    required: ['channel', 'message-id', 'content'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_edit',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
      '--content',
      String(args.content),
    ]);
  },
};

const discordDeleteHandler: ToolHandler = {
  name: 'discord_delete',
  description: '自分のメッセージを削除する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      'message-id': { type: 'string', description: 'メッセージID' },
    },
    required: ['channel', 'message-id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_delete',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
    ]);
  },
};

const discordThreadLeaveHandler: ToolHandler = {
  name: 'discord_thread_leave',
  description:
    'スレッドから指定ユーザーを退出させる（Discordの「このスレッドを退出」と同じ＝そのユーザーのサイドバーから消える）。channel 省略時は現在のスレッドが対象。user は必須で、自分を退出させたい場合は発言者のユーザーIDを渡す。',
  parameters: {
    type: 'object',
    properties: {
      user: { type: 'string', description: '退出させるユーザーID（必須。自分＝発言者のIDを渡す）' },
      channel: { type: 'string', description: 'スレッドID（省略時は現在のスレッド）' },
    },
    required: ['user'],
  },
  async execute(args): Promise<ToolResult> {
    const cmd = ['discord_thread_leave', '--user', String(args.user)];
    if (args.channel) cmd.push('--channel', String(args.channel));
    return runXangiCmd(cmd);
  },
};

// ─── Schedule Tools ─────────────────────────────────────────────────

const scheduleListHandler: ToolHandler = {
  name: 'schedule_list',
  description: 'スケジュール一覧を表示する。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['schedule_list']);
  },
};

function schedulePlatformEnv(platform?: ChatPlatform): Record<string, string> | undefined {
  return platform === 'discord' || platform === 'slack' ? { XANGI_PLATFORM: platform } : undefined;
}

function createScheduleAddHandler(defaultPlatform?: ChatPlatform): ToolHandler {
  return {
    name: 'schedule_add',
    description:
      'スケジュールを追加する。例: "30分後 ミーティング", "15:00 レビュー", "毎日 9:00 おはよう", "cron 0 9 * * * おはよう"',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'スケジュール設定（例: "毎日 9:00 おはよう"）',
        },
        channel: { type: 'string', description: '送信先チャンネルID' },
        platform: {
          type: 'string',
          description: 'プラットフォーム（discord/slack）',
          enum: ['discord', 'slack'],
        },
      },
      required: ['input', 'channel'],
    },
    async execute(args): Promise<ToolResult> {
      const flags: Record<string, string> = {
        input: String(args.input),
        channel: String(args.channel),
      };
      if (args.platform) flags.platform = String(args.platform);
      return runXangiCmd(
        ['schedule_add', ...flagsToArgs(flags)],
        schedulePlatformEnv(defaultPlatform)
      );
    },
  };
}

const scheduleRemoveHandler: ToolHandler = {
  name: 'schedule_remove',
  description: 'スケジュールを削除する。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'スケジュールID' },
    },
    required: ['id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_remove', '--id', String(args.id)]);
  },
};

const scheduleToggleHandler: ToolHandler = {
  name: 'schedule_toggle',
  description: 'スケジュールの有効/無効を切り替える。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'スケジュールID' },
    },
    required: ['id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_toggle', '--id', String(args.id)]);
  },
};

// ─── Media Tool ─────────────────────────────────────────────────────

const mediaSendHandler: ToolHandler = {
  name: 'media_send',
  description: 'ファイルをDiscordチャンネルに送信する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      file: { type: 'string', description: 'ファイルパス' },
    },
    required: ['channel', 'file'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'media_send',
      '--channel',
      String(args.channel),
      '--file',
      String(args.file),
    ]);
  },
};

// ─── System Tools ───────────────────────────────────────────────────

const systemRestartHandler: ToolHandler = {
  name: 'system_restart',
  description:
    'xangiを再起動する（管理者が.envでXANGI_SELF_LIFECYCLE=restart-onlyを設定している場合のみ）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['system_restart']);
  },
};

const systemSettingsHandler: ToolHandler = {
  name: 'system_settings',
  description: 'xangiの設定を変更または表示する。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '設定キー（省略で一覧表示）' },
      value: { type: 'string', description: '設定値' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const cliArgs = ['system_settings'];
    if (args.key) {
      cliArgs.push('--key', String(args.key));
      if (args.value !== undefined) cliArgs.push('--value', String(args.value));
    }
    return runXangiCmd(cliArgs);
  },
};

// ─── History Tools ──────────────────────────────────────────────────

/**
 * web_history: 現在の Web Chat ペインの履歴を取得する。
 * Web 経由で runner が起動された時、XANGI_CHANNEL_ID=web-chat:<appSessionId> が
 * セットされているのを web-history-cmd が拾う。
 */
const webHistoryHandler: ToolHandler = {
  name: 'web_history',
  description:
    '現在のWeb Chatペインの会話履歴を取得する。Web経由のセッションでのみ動作。結果はWebに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'string', description: '取得件数（デフォルト10）' },
      session: { type: 'string', description: 'セッションID（省略時は現在のペイン）' },
      'max-chars': { type: 'string', description: '1メッセージあたり最大文字数（デフォルト500）' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.count) flags.count = String(args.count);
    if (args.session) flags.session = String(args.session);
    if (args['max-chars']) flags['max-chars'] = String(args['max-chars']);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['web_history', ...flagsToArgs(flags)], env);
  },
};

/**
 * slack_history: 現在の Slack チャンネルの履歴を取得する。
 * Slack 経由で runner が起動された時、XANGI_CHANNEL_ID=<channelId> がセットされる。
 */
const slackHistoryHandler: ToolHandler = {
  name: 'slack_history',
  description:
    '現在のSlackチャンネルの会話履歴を取得する。Slack経由のセッションでのみ動作。結果はSlackに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID（省略時は現在のチャンネル）' },
      count: { type: 'string', description: '取得件数（デフォルト10、最大100）' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.channel) flags.channel = String(args.channel);
    if (args.count) flags.count = String(args.count);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['slack_history', ...flagsToArgs(flags)], env);
  },
};

const slackSendHandler: ToolHandler = {
  name: 'slack_send',
  description: '指定Slackチャンネルにメッセージを送信する。thread-ts指定でスレッド返信もできる。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      message: { type: 'string', description: '送信するメッセージ' },
      'thread-ts': { type: 'string', description: '返信先スレッドのts（任意）' },
    },
    required: ['message'],
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = { message: String(args.message) };
    if (args.channel) flags.channel = String(args.channel);
    if (args['thread-ts']) flags['thread-ts'] = String(args['thread-ts']);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['slack_send', ...flagsToArgs(flags)], env);
  },
};

const slackChannelsHandler: ToolHandler = {
  name: 'slack_channels',
  description: 'Slackチャンネル一覧を取得する。',
  parameters: {
    type: 'object',
    properties: {
      types: {
        type: 'string',
        description: '取得対象（例: public_channel,private_channel。デフォルトは両方）',
      },
      limit: { type: 'string', description: '取得件数（デフォルト100、最大1000）' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.types) flags.types = String(args.types);
    if (args.limit) flags.limit = String(args.limit);
    return runXangiCmd(['slack_channels', ...flagsToArgs(flags)]);
  },
};

const slackSearchHandler: ToolHandler = {
  name: 'slack_search',
  description: 'Slackチャンネル内のメッセージを検索する（最新メッセージから）。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      keyword: { type: 'string', description: '検索キーワード' },
      count: { type: 'string', description: '検索対象件数（デフォルト15、最大100）' },
    },
    required: ['keyword'],
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = { keyword: String(args.keyword) };
    if (args.channel) flags.channel = String(args.channel);
    if (args.count) flags.count = String(args.count);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['slack_search', ...flagsToArgs(flags)], env);
  },
};

const slackEditHandler: ToolHandler = {
  name: 'slack_edit',
  description: 'Slack上の自分のメッセージを編集する。SlackのメッセージIDはtsを使う。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      'message-ts': { type: 'string', description: 'Slackメッセージts' },
      content: { type: 'string', description: '新しいメッセージ内容' },
    },
    required: ['message-ts', 'content'],
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {
      'message-ts': String(args['message-ts']),
      content: String(args.content),
    };
    if (args.channel) flags.channel = String(args.channel);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['slack_edit', ...flagsToArgs(flags)], env);
  },
};

const slackDeleteHandler: ToolHandler = {
  name: 'slack_delete',
  description: 'Slack上の自分のメッセージを削除する。SlackのメッセージIDはtsを使う。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      'message-ts': { type: 'string', description: 'Slackメッセージts' },
    },
    required: ['message-ts'],
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {
      'message-ts': String(args['message-ts']),
    };
    if (args.channel) flags.channel = String(args.channel);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['slack_delete', ...flagsToArgs(flags)], env);
  },
};

// ─── Google Workspace Tools ─────────────────────────────────────────
// 1〜4Bの小型ローカルLLMが呼ぶ前提のため parameters はフラット・最小限。
// 安全ポリシー: 削除はユーザーの明示指示時のみ / gmail_draft は下書き作成のみ（送信しない）。

const gcalListEventsHandler: ToolHandler = {
  name: 'gcal_list_events',
  description:
    'Googleカレンダーの予定を一覧取得する。例: gcal_list_events() で今後の予定を取得。max_resultsで件数指定（既定10）。',
  parameters: {
    type: 'object',
    properties: {
      max_results: { type: 'string', description: '取得件数（既定10、最大50）' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.max_results) flags['max-results'] = String(args.max_results);
    return runXangiCmd(['google_calendar_list', ...flagsToArgs(flags)]);
  },
};

const gcalCreateEventHandler: ToolHandler = {
  name: 'gcal_create_event',
  description:
    'Googleカレンダーに予定を作成する。例: gcal_create_event(title="会議", start="2026-07-20T15:00:00+09:00")。end省略時は開始から60分。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '予定のタイトル' },
      start: { type: 'string', description: '開始日時（ISO8601、例: 2026-07-20T15:00:00+09:00）' },
      end: { type: 'string', description: '終了日時（ISO8601、省略時は開始+60分）' },
      description: { type: 'string', description: '予定の詳細（任意）' },
    },
    required: ['title', 'start'],
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = {
      summary: String(args.title),
      start: String(args.start),
    };
    if (args.end) flags.end = String(args.end);
    if (args.description) flags.description = String(args.description);
    return runXangiCmd(['google_calendar_create', ...flagsToArgs(flags)]);
  },
};

const gcalUpdateEventHandler: ToolHandler = {
  name: 'gcal_update_event',
  description:
    'Googleカレンダーの予定を更新する。event_idは必須。変更したい項目（title/start/end/description）だけ渡す。',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: '予定のID（gcal_list_eventsで確認）' },
      title: { type: 'string', description: '新しいタイトル（任意）' },
      start: { type: 'string', description: '新しい開始日時 ISO8601（任意）' },
      end: { type: 'string', description: '新しい終了日時 ISO8601（任意）' },
      description: { type: 'string', description: '新しい詳細（任意）' },
    },
    required: ['event_id'],
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = { 'event-id': String(args.event_id) };
    if (args.title) flags.summary = String(args.title);
    if (args.start) flags.start = String(args.start);
    if (args.end) flags.end = String(args.end);
    if (args.description) flags.description = String(args.description);
    return runXangiCmd(['google_calendar_update', ...flagsToArgs(flags)]);
  },
};

const gcalDeleteEventHandler: ToolHandler = {
  name: 'gcal_delete_event',
  description:
    'Googleカレンダーの予定を削除する。安全ポリシー: 削除はユーザーが明示的に依頼したときのみ実行すること。event_idは必須。',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: '削除する予定のID' },
    },
    required: ['event_id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['google_calendar_delete', '--event-id', String(args.event_id)]);
  },
};

const gdriveSearchHandler: ToolHandler = {
  name: 'gdrive_search',
  description:
    'Google Driveのファイルを検索する。例: gdrive_search(name="議事録") でファイル名検索、gdrive_search(fulltext="予算") で全文検索。最大10件。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'ファイル名に含まれる語（任意）' },
      fulltext: { type: 'string', description: '本文に含まれる語（任意）' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.name) flags.name = String(args.name);
    if (args.fulltext) flags.fulltext = String(args.fulltext);
    return runXangiCmd(['google_drive_search', ...flagsToArgs(flags)]);
  },
};

const gdriveReadHandler: ToolHandler = {
  name: 'gdrive_read',
  description:
    'Google Driveのファイル内容を取得する。file_idはgdrive_searchで確認。Google Docsやテキスト系のみ対応（バイナリは取得不可）。',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: '読み取るファイルのID' },
    },
    required: ['file_id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['google_drive_read', '--file-id', String(args.file_id)]);
  },
};

const gdocsCreateHandler: ToolHandler = {
  name: 'gdocs_create',
  description:
    'Google Docsのドキュメントを新規作成する。例: gdocs_create(title="メモ", body="本文")。作成後の編集URLを返す。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'ドキュメントのタイトル' },
      body: { type: 'string', description: '初期本文（任意）' },
    },
    required: ['title'],
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = { title: String(args.title) };
    if (args.body) flags.body = String(args.body);
    return runXangiCmd(['google_docs_create', ...flagsToArgs(flags)]);
  },
};

const gdocsReadHandler: ToolHandler = {
  name: 'gdocs_read',
  description:
    'Google Docsのドキュメント本文を読み取る。document_idはURL（.../document/d/ID/edit）のID部分。',
  parameters: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: 'ドキュメントのID' },
    },
    required: ['document_id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['google_docs_read', '--document-id', String(args.document_id)]);
  },
};

const gdocsAppendHandler: ToolHandler = {
  name: 'gdocs_append',
  description:
    'Google Docsのドキュメント末尾にテキストを追記する。例: gdocs_append(document_id="...", text="追記内容")。',
  parameters: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: 'ドキュメントのID' },
      text: { type: 'string', description: '追記するテキスト' },
    },
    required: ['document_id', 'text'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'google_docs_append',
      '--document-id',
      String(args.document_id),
      '--text',
      String(args.text),
    ]);
  },
};

const gmailSearchHandler: ToolHandler = {
  name: 'gmail_search',
  description:
    'Gmailのメールを検索する。例: gmail_search(query="from:boss@example.com 予算")。Gmail検索構文が使える。最大10件。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail検索クエリ（例: "from:xxx is:unread"）' },
    },
    required: ['query'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['google_gmail_search', '--query', String(args.query)]);
  },
};

const gmailReadHandler: ToolHandler = {
  name: 'gmail_read',
  description: 'Gmailの1通のメール本文を読み取る。message_idはgmail_searchの結果に含まれるID。',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: '読み取るメールのID' },
    },
    required: ['message_id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['google_gmail_read', '--message-id', String(args.message_id)]);
  },
};

const gmailDraftHandler: ToolHandler = {
  name: 'gmail_draft',
  description:
    'Gmailの下書きを作成する。安全ポリシー: これは下書き作成のみで、メールの送信は絶対に行わない（送信APIは存在しない）。例: gmail_draft(to="a@example.com", subject="件名", body="本文")。',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '宛先メールアドレス' },
      subject: { type: 'string', description: '件名（任意）' },
      body: { type: 'string', description: '本文（任意）' },
    },
    required: ['to'],
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = { to: String(args.to) };
    if (args.subject) flags.subject = String(args.subject);
    if (args.body) flags.body = String(args.body);
    return runXangiCmd(['google_gmail_draft', ...flagsToArgs(flags)]);
  },
};

// ─── Export ─────────────────────────────────────────────────────────

/** Discord接続時に追加するツール */
export function getDiscordTools(): ToolHandler[] {
  return [
    discordHistoryHandler,
    discordSendHandler,
    discordChannelsHandler,
    discordSearchHandler,
    discordEditHandler,
    discordDeleteHandler,
    discordThreadLeaveHandler,
    mediaSendHandler,
  ];
}

/** Web接続時に追加するツール */
export function getWebTools(): ToolHandler[] {
  return [webHistoryHandler, mediaSendHandler];
}

/** Slack接続時に追加するツール */
export function getSlackTools(): ToolHandler[] {
  return [
    slackHistoryHandler,
    slackSendHandler,
    slackChannelsHandler,
    slackSearchHandler,
    slackEditHandler,
    slackDeleteHandler,
  ];
}

/** Google Workspace 関連ツール（プラットフォーム非依存、deferred で提供） */
export function getGoogleTools(): ToolHandler[] {
  return [
    gcalListEventsHandler,
    gcalCreateEventHandler,
    gcalUpdateEventHandler,
    gcalDeleteEventHandler,
    gdriveSearchHandler,
    gdriveReadHandler,
    gdocsCreateHandler,
    gdocsReadHandler,
    gdocsAppendHandler,
    gmailSearchHandler,
    gmailReadHandler,
    gmailDraftHandler,
  ];
}

/** スケジュール関連ツール */
export function getScheduleTools(platform?: ChatPlatform): ToolHandler[] {
  return [
    scheduleListHandler,
    createScheduleAddHandler(platform),
    scheduleRemoveHandler,
    scheduleToggleHandler,
  ];
}

/** システム関連ツール */
export function getSystemTools(): ToolHandler[] {
  return [systemRestartHandler, systemSettingsHandler];
}

/** 履歴取得ツール (web_history / slack_history)。プラットフォームに応じてランナーが呼ぶ */
export function getHistoryTools(): ToolHandler[] {
  return [webHistoryHandler, slackHistoryHandler];
}

/** 全xangiツール（プラットフォーム問わず） */
export function getAllXangiTools(): ToolHandler[] {
  return [
    ...getDiscordTools(),
    ...getSlackTools(),
    webHistoryHandler,
    ...getGoogleTools(),
    ...getScheduleTools(),
    ...getSystemTools(),
  ];
}

/** 実行プラットフォームに応じたxangiツール */
export function getXangiTools(platform?: ChatPlatform): ToolHandler[] {
  const commonTools = [...getGoogleTools(), ...getScheduleTools(platform), ...getSystemTools()];

  if (platform === 'web') {
    return [...getWebTools(), ...commonTools];
  }

  if (platform === 'discord') {
    return [...getDiscordTools(), ...commonTools];
  }

  if (platform === 'slack') {
    return [...getSlackTools(), ...commonTools];
  }

  if (platform === 'line') {
    return commonTools;
  }

  return getAllXangiTools();
}
