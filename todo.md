# todo: N100 ローカルLLM + Google連携 + Webサーチ2重チェック

計画: `~/.claude/plans/discord-google-obsidian-opus-sonnet-snazzy-hopper.md`

- [x] Phase 2: Google 連携（`src/cli/google-api.ts` + `xangi-cmd google_*` 12種 + ToolHandler 12種 + 認証スクリプト + テスト8件パス）
- [x] Phase 3: Web サーチ 2重チェック（`src/local-llm/web-search.ts` + テスト12件パス）
- [x] Phase 4: AGENTS.md・`docs/n100-setup.md`・`docs/google-workspace-setup.md`・`.gitignore`・`.env.example`
- [x] ビルド・テスト全通過の確認（tsc 成功、1314 パス。16失敗は macOS TMPDIR 由来の既存環境依存で変更前から発生）
- [x] llama.cpp 対応（llama-server 2インスタンス構成。`WEB_SEARCH_VERIFIER_BASE_URL` 追加 + docs/n100-setup.md 全面改訂）
- [ ] 人手作業: GCP セットアップ・refresh token 取得・N100 配備・E2E 検証

# todo: Discord + ローカルLLM(llama.cpp) セットアップ

- [x] Discord Bot Token 取得・`.env` の `DISCORD_TOKEN` 設定
- [x] 自分のDiscordユーザーIDを取得・`DISCORD_ALLOWED_USER` 設定（現状 `*` で全員許可。運用実態を見て絞る）
- [x] Node.js インストール、`npm install` / `npm run build`
- [x] llama.cpp (CUDA版) ダウンロード・展開
- [x] Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled GGUF (IQ4_XS) ダウンロード完了
- [x] llama-server 起動確認（ポート8080、`-ngl 999 --cpu-moe`、`-c 32000`）
- [x] Web検索（SearXNG）セットアップ・ポート衝突回避（Podman、ポート8090、llama-server:8080と分離、JSON API動作確認済み）
- [x] xangi起動・Discord動作確認（`おうちアシスタントbot` としてログイン成功）
- [x] `LOCAL_LLM_NUM_CTX` を 8192→32000 に修正（historyTokensがマイナスだった問題を解消）
- [ ] 家族2人目のDiscordユーザーIDを取得し `DISCORD_ALLOWED_USER` に追加するか検討
      - 論点: 現状 `LOCAL_LLM_TOOLS=true` のため exec（コマンド実行）権限も両者に付与される
      - 現状は `*`（全員許可）のまま運用中。将来的に絞る場合は本タスクで対応
      - 選択肢: 両者に同等権限を与える／家族用チャンネルは `LOCAL_LLM_MODE=chat` 等でツール無効化して分離
- [ ] `llama-server` / SearXNG(Podman) を pm2 等で自動起動・自動復帰させる運用に切り替える（現状は手動起動）
