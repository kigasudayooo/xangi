import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildXangiCommands,
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_TRIGGER,
} from '../src/prompts/xangi-commands.js';

const TRIGGER_HEADING = '## イベントトリガー（完了時に自分を起こす）';

describe('buildXangiCommands trigger section', () => {
  const original = process.env.TRIGGER_ENABLED;

  beforeEach(() => {
    delete process.env.TRIGGER_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRIGGER_ENABLED;
    } else {
      process.env.TRIGGER_ENABLED = original;
    }
  });

  it('TRIGGER_ENABLED 未設定なら trigger セクションを注入しない', () => {
    expect(buildXangiCommands('discord')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=false なら注入しない', () => {
    process.env.TRIGGER_ENABLED = 'false';
    expect(buildXangiCommands('discord')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true なら discord に注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    const prompt = buildXangiCommands('discord');
    expect(prompt).toContain(TRIGGER_HEADING);
    expect(prompt).toContain('xangi-cmd trigger');
  });

  it('TRIGGER_ENABLED=true なら slack にも注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('slack')).toContain(TRIGGER_HEADING);
  });

  it('discord には初回履歴取得指示を注入しない', () => {
    const prompt = buildXangiCommands('discord');
    expect(prompt).not.toContain('## セッション再開時の文脈把握（重要）');
    expect(prompt).not.toContain('<prefetched-history');
    expect(prompt).toContain('xangi-cmd discord_history --count <件数>');
  });

  it('slack には Discord 履歴取得コマンドを注入しない', () => {
    const prompt = buildXangiCommands('slack');
    expect(prompt).not.toContain('xangi-cmd discord_history --count 10');
    expect(prompt).not.toContain('## セッション再開時の文脈把握（重要）');
    expect(prompt).not.toContain('<prefetched-history');
    expect(prompt).toContain('xangi-cmd slack_history --count <件数>');
    expect(prompt).toContain('SlackチャンネルIDはDiscord snowflakeではありません');
    expect(prompt).toContain('xangi-cmd slack_send');
    expect(prompt).toContain('xangi-cmd slack_channels');
    expect(prompt).toContain('xangi-cmd slack_search');
    expect(prompt).toContain('xangi-cmd slack_edit');
    expect(prompt).toContain('xangi-cmd slack_delete');
    expect(prompt).toContain('message-ts');
  });

  it('web には履歴取得指示を注入しない', () => {
    const prompt = buildXangiCommands('web');
    expect(prompt).not.toContain('## セッション再開時の文脈把握（重要）');
    expect(prompt).not.toContain('<prefetched-history');
    expect(prompt).not.toContain('web_history');
  });

  it('slack の schedule_add 例には --platform slack を含める', () => {
    const prompt = buildXangiCommands('slack');

    expect(prompt).toContain(
      'xangi-cmd schedule_add --input "毎日 9:00 おはよう" --channel <チャンネルID> --platform slack'
    );
    expect(prompt).toContain('`schedule_add` に `--platform slack` を付ける');
  });

  it('discord の schedule_add 例には --platform discord を含める', () => {
    const prompt = buildXangiCommands('discord');

    expect(prompt).toContain(
      'xangi-cmd schedule_add --input "毎日 9:00 おはよう" --channel <チャンネルID> --platform discord'
    );
  });

  it('TRIGGER_ENABLED=true なら platform 未指定 (後方互換) にも注入する', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands()).toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true でも web には注入しない (トリガーの投稿先にできない)', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('web')).not.toContain(TRIGGER_HEADING);
  });

  it('TRIGGER_ENABLED=true でも line には注入しない', () => {
    process.env.TRIGGER_ENABLED = 'true';
    expect(buildXangiCommands('line')).not.toContain(TRIGGER_HEADING);
  });

  it('環境固有の永続実行を前提に、失敗時も完了情報を残す', () => {
    expect(XANGI_COMMANDS_TRIGGER).toContain('成功時だけでなく失敗時にもtriggerへ到達');
    expect(XANGI_COMMANDS_TRIGGER).toContain('終了状態とログを保存');
    expect(XANGI_COMMANDS_TRIGGER).toContain('ワークスペースの指示に従う');
    expect(XANGI_COMMANDS_TRIGGER).toContain('--source');
    expect(XANGI_COMMANDS_TRIGGER).not.toMatch(/setsid|nohup|\/tmp\/|\`\`\`bash/);
  });
});

describe('buildXangiCommands background process safety', () => {
  it('環境に依存せず、ターン後の存続確認と完了記録を要求する', () => {
    expect(XANGI_COMMANDS_COMMON).toContain('ターン終了後も存続する方法');
    expect(XANGI_COMMANDS_COMMON).toContain('ワークスペースの指示に従う');
    expect(XANGI_COMMANDS_COMMON).toContain('ログと終了状態を保存');
    expect(XANGI_COMMANDS_COMMON).not.toMatch(/Claude|Codex|setsid|nohup|\/tmp\/|SID\/PGID/);
  });

  it.each(['discord', 'slack', 'web', 'line', 'telegram'] as const)(
    '%s で自己再起動を遅延委譲せずsystem_restartへ誘導する',
    (platform) => {
      const prompt = buildXangiCommands(platform);

      expect(prompt).toContain('現在のxangi自身');
      expect(prompt).toContain('`xangi-cmd system_restart`をこのターンから直接呼び');
      expect(prompt).toContain('遅延・子プロセス・スケジューラへ委譲しない');
      expect(prompt).toContain('受付を完了とみなさず');
      expect(prompt.match(/## 自己再起動/g)).toHaveLength(1);
    }
  );

  it('自己再起動ルールも環境固有のプロセス操作を含まない', () => {
    expect(XANGI_COMMANDS_COMMON).toContain('## 自己再起動');
    expect(XANGI_COMMANDS_COMMON).not.toMatch(/Claude|Codex|setsid|nohup|\/tmp\/|SID\/PGID/);
  });
});

describe('buildXangiCommands discord formatting section', () => {
  it('discord には番号付き見出し直下の箇条書きインデント案内を含める', () => {
    const prompt = buildXangiCommands('discord');

    expect(prompt).toContain('## Discord表示フォーマット');
    expect(prompt).toContain('番号付き見出しの直下に箇条書きを置く場合');
    expect(prompt).toContain('   - 詳細');
  });

  it('discord 以外には Discord 表示フォーマット案内を含めない', () => {
    expect(buildXangiCommands('web')).not.toContain('## Discord表示フォーマット');
    expect(buildXangiCommands('line')).not.toContain('## Discord表示フォーマット');
  });
});
