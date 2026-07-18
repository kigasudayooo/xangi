# todo: N100 ローカルLLM + Google連携 + Webサーチ2重チェック

計画: `~/.claude/plans/discord-google-obsidian-opus-sonnet-snazzy-hopper.md`

- [x] Phase 2: Google 連携（`src/cli/google-api.ts` + `xangi-cmd google_*` 12種 + ToolHandler 12種 + 認証スクリプト + テスト8件パス）
- [x] Phase 3: Web サーチ 2重チェック（`src/local-llm/web-search.ts` + テスト12件パス）
- [x] Phase 4: AGENTS.md・`docs/n100-setup.md`・`docs/google-workspace-setup.md`・`.gitignore`・`.env.example`
- [x] ビルド・テスト全通過の確認（tsc 成功、1314 パス。16失敗は macOS TMPDIR 由来の既存環境依存で変更前から発生）
- [x] llama.cpp 対応（llama-server 2インスタンス構成。`WEB_SEARCH_VERIFIER_BASE_URL` 追加 + docs/n100-setup.md 全面改訂）
- [ ] 人手作業: GCP セットアップ・refresh token 取得・N100 配備・E2E 検証
