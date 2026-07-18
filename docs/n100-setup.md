# N100 ミニPC セットアップガイド

Intel N100（CPU only、RAM 16GB 程度）の Ubuntu Server ミニPCで、xangi + ローカル LLM（llama.cpp / llama-server）を運用するための手順。省メモリ・省電力な自宅サーバー用途を想定している。

GPU非搭載のCPU推論のため、大型モデルは動かない。本ガイドはメインモデルに軽量な Qwen3-4B-Instruct-2507（Q4_K_M）、verifier（`web_search` の引用検証専用）に更に軽い Qwen3-1.7B（Q4）を使い、**llama-server を別ポートで2インスタンス起動する構成**で説明する。

llama-server は1インスタンス1モデルで、リクエストの `model` フィールドを無視する（起動時にロードしたモデルが常に使われる）。そのため Ollama のように1プロセスでモデルを切り替える運用はできず、メイン用と verifier 用を別々のポート・プロセスとして立てる必要がある。

## 前提

- Ubuntu Server（22.04 / 24.04 系）がセットアップ済みで SSH ログインできること
- RAM 16GB、CPU only（N100 は AVX2 対応・AVX-512 非対応）
- Mac 等の開発機で xangi を開発し、N100 へは `git pull` で配備する運用（後述）

## 1. Node.js 22+ のインストール（nodesource）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v22.x であることを確認
```

## 2. llama.cpp のインストール

### 2-1. プリビルドバイナリを使う（推奨・最速）

[llama.cpp の GitHub Releases](https://github.com/ggml-org/llama.cpp/releases) から Linux 用のビルド済みバイナリ（`llama-<version>-bin-ubuntu-x64.tar.gz` 等、CPU版）を取得する。N100 は AVX2 までの対応（AVX-512 非対応）なので、AVX-512 専用ビルドではなく標準の x64 CPU ビルドを使う。

```bash
# バージョンは Releases ページで最新の b<番号> タグに置き換えること
LLAMA_CPP_VERSION=b7633
wget "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz"
tar -xzf "llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz"
sudo mv build/bin/llama-server build/bin/llama-bench /usr/local/bin/
llama-server --version
```

> ⚠️ Releases のアセット名・ディレクトリ構成はバージョンによって変わることがあるため、`tar tzf` で中身を確認してから配置すること。

### 2-2. ソースからビルドする場合（代替）

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_NATIVE=ON
cmake --build build --config Release -j"$(nproc)"
sudo cp build/bin/llama-server build/bin/llama-bench /usr/local/bin/
```

`-DGGML_NATIVE=ON` でビルドマシン（N100 本体）の CPU 命令セットに最適化される。クロスビルドする場合は `-DGGML_AVX512=OFF`（N100 非対応のため）を明示するとよい。

## 3. モデル取得（GGUF）

llama-server は GGUF 形式のモデルファイルを直接読み込む。Hugging Face から量子化済み GGUF を取得する。

### メインモデル: Qwen3-4B-Instruct-2507（Q4_K_M）

配布元: [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)（bartowski 版 [bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF) も同等）

```bash
mkdir -p ~/models
cd ~/models
wget https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

### verifier 用: Qwen3-1.7B（Q4_K_M）

配布元: [ggml-org/Qwen3-1.7B-GGUF](https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF)（llama.cpp 公式組織（ggml-org）配布。Q4_K_M で約1.28GB）

```bash
wget https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf
```

`web_search` ツールの引用検証（verifier LLM）専用の軽量モデル。`.env` の `WEB_SEARCH_VERIFIER_BASE_URL` から指すインスタンス（後述の :8081）で使う。

## 4. llama-server の起動（tool calling 対応）

xangi は Local LLM のツール呼び出し（`gcal_*` / `web_search` 等）に OpenAI 互換の tool calling を使う。llama-server で tool calling を有効にするには **`--jinja` フラグが必須**（Jinja チャットテンプレートを使ってツール呼び出し形式を組み立てるため。`--jinja` なしだと tools 未対応になる）。

### メインインスタンス（:8080）

```bash
llama-server \
  -m ~/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --jinja \
  -c 8192 \
  -t 4 \
  -fa 1 \
  -ctk q8_0 -ctv q8_0
```

### verifier インスタンス（:8081）

```bash
llama-server \
  -m ~/models/Qwen3-1.7B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8081 \
  --jinja \
  -c 8192 \
  -t 4 \
  -fa 1 \
  -ctk q8_0 -ctv q8_0
```

| フラグ             | 意味                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--jinja`          | Jinja チャットテンプレートを使ってツール呼び出し（tool calling）を有効化する。xangi のツール呼び出しに必須                                                                         |
| `-c`               | コンテキストサイズ（token数）。N100 は長コンテキストで速度が大きく落ちるため 8192 程度に抑える                                                                                     |
| `-t`               | 推論に使うスレッド数。N100 は4コアのため `-t 4` を目安にする                                                                                                                       |
| `-fa 1`            | Flash Attention を有効化（メモリ・速度両面で有利。KV量子化と組み合わせる場合は必須に近い）                                                                                         |
| `-ctk` / `-ctv`    | KV キャッシュの K/V それぞれの量子化型。`q8_0` は品質劣化がごく僅かでメモリを約半分にできる安全な選択。K/V を同じ型（対称）にすると Flash Attention の高速な融合カーネルが使われる |
| `--host 127.0.0.1` | ローカルホストのみ待受（外部公開しない）                                                                                                                                           |

> ⚠️ 上記フラグ名は執筆時点の llama.cpp（[`tools/server/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[`docs/function-calling.md`](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)）に基づく。バージョンによって変わることがあるため、導入時に `llama-server --help` で最新のフラグ名・既定値を確認すること。

## 5. systemd unit（自動起動）

`/etc/systemd/system/llama-server-main.service`:

```ini
[Unit]
Description=llama-server (main, Qwen3-4B-Instruct-2507)
After=network.target

[Service]
ExecStart=/usr/local/bin/llama-server -m /home/USER/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf --host 127.0.0.1 --port 8080 --jinja -c 8192 -t 4 -fa 1 -ctk q8_0 -ctv q8_0
Restart=on-failure
User=USER

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/llama-server-verifier.service`:

```ini
[Unit]
Description=llama-server (verifier, Qwen3-1.7B)
After=network.target

[Service]
ExecStart=/usr/local/bin/llama-server -m /home/USER/models/Qwen3-1.7B-Q4_K_M.gguf --host 127.0.0.1 --port 8081 --jinja -c 8192 -t 4 -fa 1 -ctk q8_0 -ctv q8_0
Restart=on-failure
User=USER

[Install]
WantedBy=multi-user.target
```

`USER` は実際のユーザー名・ホームディレクトリに置き換えること。反映:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llama-server-main llama-server-verifier
systemctl status llama-server-main llama-server-verifier
```

## 6. メモリ見積り

| 項目                                                          | 概算                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Qwen3-4B-Instruct-2507 Q4_K_M（重み）                         | 約2.5GB                                               |
| Qwen3-1.7B Q4_K_M（重み）                                     | 約1.1GB                                               |
| KV キャッシュ（両インスタンス、`-c 8192` + `-ctk/-ctv q8_0`） | 数百MB〜1GB程度（コンテキスト長・バッチサイズに依存） |
| OS・xangi・SearXNG 等                                         | 残り                                                  |

合計で 16GB RAM に十分収まる想定。ただし実際のKVキャッシュ使用量は起動ログ（`llama-server` 起動時に出力されるメモリ確保量）で確認すること。

## 7. tok/s の実測

### llama-bench で計測

```bash
llama-bench -m ~/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf -p 512 -n 128 -t 4 -fa 1
```

`pp512`（プロンプト処理速度）と `tg128`（生成速度、bs=1）が表示される。生成速度（tg128）が実運用の応答速度の目安になる。

### 実運用ログでの確認

llama-server は各リクエストの `timings`（prompt_per_second / predicted_per_second 等）をレスポンスやログに出力する。OpenAI 互換エンドポイント経由でも `curl` で直接叩けば `timings` フィールドを確認できる。

**目安**: 5 tok/s を大きく下回るようなら、メインモデルも `Qwen3-1.7B` に統一する（4B より劣化するが、応答速度を優先する構成）ことを検討する。

**既知の注意点**: N100 は長コンテキストで速度が大きく落ちる傾向がある。`-c`（コンテキストサイズ）は欲張らず、必要最小限（本ガイドの例では 8192）に留めること。

## 8. SearXNG の Docker 起動（web_search 用）

`web_search` ツールは SearXNG の JSON API を使うため、`settings.yml` で JSON フォーマットを明示的に有効化する必要がある。

```bash
mkdir -p ~/searxng
cd ~/searxng
docker run --rm -v "$(pwd):/etc/searxng" searxng/searxng cp /etc/searxng/settings.yml /etc/searxng/settings.yml 2>/dev/null || true
# 初回は空ディレクトリでコンテナを一度起動し settings.yml を生成させてもよい
```

`settings.yml` に以下を追記（`search:` セクション）:

```yaml
search:
  formats:
    - html
    - json
```

Google エンジンはブロック（CAPTCHA）が発生しやすいため無効化し、Bing / DuckDuckGo など複数エンジンに検索を分散させる:

```yaml
engines:
  - name: google
    disabled: true
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
```

N100 の限られたCPUリソース向けに uwsgi のワーカー数を絞る（`uwsgi.ini` または `settings.yml` の `server:` セクション、Docker イメージのバージョンにより設定箇所が異なるので同梱の `uwsgi.ini` を確認）:

```ini
[uwsgi]
workers = 2
threads = 2
```

起動:

```bash
docker run -d --name searxng \
  -p 8090:8080 \
  -v "$(pwd):/etc/searxng" \
  --restart unless-stopped \
  searxng/searxng
```

> ⚠️ 本ガイドの llama-server はメイン :8080 / verifier :8081 を使うため、SearXNG のホスト側公開ポートは衝突しないよう `8090` 等の空きポートに変更している（コンテナ内部は `8080` のままでよい）。`.env` の `SEARXNG_BASE_URL` もこのポートに合わせること。

動作確認:

```bash
curl -s "http://localhost:8090/search?q=test&format=json" | head -c 200
```

## 9. xangi のセットアップ

```bash
git clone <xangiのリポジトリURL>
cd xangi
npm install
npm run build
cp .env.example .env
vim .env   # 下記の推奨設定を反映
```

pm2 での常駐運用:

```bash
./bin/xangi service start
./bin/xangi service autostart   # OS起動時にpm2経由で自動起動
```

詳細は [使い方ガイド: プロセス管理](docs/usage.md) を参照。

## 10. `.env` 推奨設定（llama.cpp / llama-server）

```bash
# Local LLM (llama.cpp / llama-server, メインインスタンス)
AGENT_BACKEND=local-llm
LOCAL_LLM_BASE_URL=http://localhost:8080
LOCAL_LLM_MODEL=qwen3-4b-instruct-2507   # llama-server は起動時ロード済みモデルを使うため任意の文字列でよい
LOCAL_LLM_NUM_CTX=8192

# web_search (SearXNG + verifier)
# ポートは上記 SearXNG 起動例（8090）に合わせる
SEARXNG_BASE_URL=http://localhost:8090
WEB_SEARCH_VERIFIER_MODEL=qwen3-1.7b
WEB_SEARCH_VERIFIER_BASE_URL=http://localhost:8081   # verifier 専用インスタンス（必須。メインと同一だと盲点分散の意味がなくなる）

# Discord（自分専用インスタンス想定。"*" で全員許可は絶対にしないこと）
DISCORD_ALLOWED_USER=<自分のDiscordユーザーID>
```

> ⚠️ **`LOCAL_LLM_BASE_URL` のポートに `11434` を使わないこと**: xangi の `LLMClient` は baseUrl に `11434` または `ollama` という文字列を含む場合、Ollama ネイティブAPI経路（`/api/chat`）を使う実装になっている。llama-server は OpenAI 互換の `/v1/chat/completions` のみを提供するため、`11434` を含むポートを指定すると誤動作する。本ガイドの `8080` / `8081` のように別ポートを使うこと。

> ⚠️ **`LOCAL_LLM_MODEL` に 1〜4B クラスのモデルを使う場合の注意**: xangi が Local LLM のツール呼び出し（tool calling）で推奨しているのは最小 9B クラスのモデルである。1〜4B モデルはそれを下回るため、ツール呼び出しの成功率（意図通りに `gcal_*` / `web_search` 等を呼べるか）が実運用で不安定になる可能性がある。導入後は実際のタスクでツール呼び出しが安定して成功するかを実測し、成功率が低い場合はメイン・verifier 双方を `Qwen3-1.7B` に統一するなど、モデルサイズの見直しを検討すること。

## 代替: Ollama を使う場合

Ollama のネイティブAPI（`http://localhost:11434`）を使う場合は、llama-server の代わりに以下でセットアップできる（xangi の `LLMClient` は baseUrl に `11434` を含むと自動でこの経路を使う）。

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b-instruct-2507-q4_K_M   # 正確なタグ名は https://ollama.com/library で要確認
ollama pull qwen3:1.7b
```

`web_search` の verifier は同一の Ollama インスタンス（1プロセスで複数モデルを切替可能）に対して `WEB_SEARCH_VERIFIER_MODEL=qwen3:1.7b` を指定すればよく、`WEB_SEARCH_VERIFIER_BASE_URL` は未設定のままでよい（`LOCAL_LLM_BASE_URL` にフォールバックする）。

省メモリ設定（systemd override）:

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KEEP_ALIVE=-1"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

## 11. Mac で開発 → N100 へ配備するフロー

1. Mac（開発機）でコード変更・動作確認（`npm run dev` 等）
2. 変更を commit・push
3. N100 側で `git pull`
4. `npm install && npm run build`（依存追加・ビルド成果物の変更があった場合のみ install が必要）
5. `.env` を変更した場合は編集後 `./bin/xangi service restart`
6. コードのみの変更（`.env` 変更なし）の場合も、`dist/` の反映のため再起動が必要

```bash
# N100側
cd xangi
git pull
npm install
npm run build
./bin/xangi service restart
```

複数 clone を運用する場合の注意点は [使い方ガイド: 複数インスタンスの運用](docs/usage.md#複数インスタンスの運用) を参照。
