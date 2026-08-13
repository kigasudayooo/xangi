# Windows + NVIDIA GPU ローカルLLM セットアップガイド

Windows PC + NVIDIA GPU（VRAM 6GB 前後の中堅GPU想定）で、xangi + ローカル LLM（llama.cpp / llama-server）+ Web検索（SearXNG）を運用するための手順。[N100 セットアップガイド](n100-setup.md)のCPU onlyミニPC構成に対して、こちらはデスクトップGPUでMoE（Mixture of Experts）系の大型モデルをVRAM+RAMのハイブリッドオフロードで動かす構成を扱う。

## 前提

- Windows 11、NVIDIA GPU（本ガイドの実測環境: GTX 1660 SUPER, VRAM 6GB、RAM 32GB、6コアCPU）
- PowerShell（管理者権限不要、`winget` が使えること）
- コンテナランタイムは Docker Desktop ではなく **Podman** を使用（ライセンス上の制約が少ないため）

## 1. Node.js のインストール

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
```

インストール後は新しいターミナルを開くか、PATHを再読込してから確認する。

```powershell
node -v
npm -v
```

## 2. xangi のビルド

```powershell
cd path\to\xangi
npm install
npm run build
```

## 3. llama.cpp（CUDA版）の導入

[llama.cpp の GitHub Releases](https://github.com/ggml-org/llama.cpp/releases) から Windows x64 CUDA版のビルド済みバイナリを取得する。バージョンは Releases ページで最新の `b<番号>` タグに置き換えること。GPUのCUDAドライバのメジャーバージョンに合わせて `cuda-12.x` 等を選ぶ。

```powershell
$dest = "C:\path\to\tools\llama.cpp"
New-Item -ItemType Directory -Force -Path "$dest\models" | Out-Null

Invoke-WebRequest -Uri "https://github.com/ggml-org/llama.cpp/releases/download/<tag>/llama-<tag>-bin-win-cuda-12.4-x64.zip" -OutFile "$dest\llama.zip"
Invoke-WebRequest -Uri "https://github.com/ggml-org/llama.cpp/releases/download/<tag>/cudart-llama-bin-win-cuda-12.4-x64.zip" -OutFile "$dest\cudart.zip"

Expand-Archive -Path "$dest\llama.zip" -DestinationPath $dest -Force
Expand-Archive -Path "$dest\cudart.zip" -DestinationPath $dest -Force
Remove-Item "$dest\llama.zip", "$dest\cudart.zip"
```

`cudart-*.zip`（CUDAランタイムDLL）を同じディレクトリに展開しておかないと、`llama-server.exe`起動時にDLLが見つからずエラーになる。

## 4. GGUFモデルの取得

Hugging Face 等から量子化済みGGUFファイルをダウンロードし、`models\` 以下に配置する。VRAM 6GB程度のGPUでは、モデル全体をVRAMに収めるのは7B〜8Bクラスが限度。それ以上のサイズ（30B級のMoEモデル等）を使う場合は、次項の `--cpu-moe` によるハイブリッドオフロードを前提にする。

> ⚠️ コミュニティ配布のGGUF・モデル名は、実際のベースモデルや学習元と異なる誇大な名称（存在しないバージョン表記等）を名乗っている場合がある。ダウンロード前にモデルカードの記載を鵜呑みにせず、配布元の信頼性を確認すること。

## 5. llama-server の起動（MoEハイブリッドオフロード）

VRAMに収まらない大型MoEモデルは、`--cpu-moe`（または `-ncmoe N` で層数指定）でMoEのexpert重みをCPU/RAM側に置き、attention等の共有層のみGPUにオフロードすることで、限られたVRAMでも動かせる。

```powershell
cd C:\path\to\tools\llama.cpp
.\llama-server.exe -m models\<model>.gguf --host 127.0.0.1 --port 8080 -c 32000 -ngl 999 --cpu-moe
```

- `-ngl 999`: 可能な限りの層をGPUへ（`--cpu-moe`併用時はMoE以外の層が対象）
- `--cpu-moe`: MoEのexpert重みを常にCPU側に保持
- `-c`: コンテキストサイズ。xangi側の `LOCAL_LLM_NUM_CTX` と必ず一致させる（後述）
- 起動ログに `model loaded` / `listening on http://127.0.0.1:8080` が出れば成功。ウィンドウは起動したままにする

### コンテキストサイズの落とし穴

`LOCAL_LLM_NUM_CTX` を小さく設定しすぎると、xangi側のコンテキスト予算計算で「システムプロンプト分＋出力分＋安全マージン」が `NUM_CTX` を超過し、**会話履歴に割り当てられるトークン数がマイナスになる**（＝会話の文脈をほぼ保持できない）。起動ログの以下の行で確認できる。

```
[local-llm] Context budget (derived from NUM_CTX=...): contextMaxChars=... (historyTokens=...)
```

`historyTokens` がマイナスの場合は `LOCAL_LLM_NUM_CTX`（および `llama-server` の `-c`）を大きくする。目安として、system予算8000 + output予算4096 + safetyマージン1000 = 13096トークンより十分大きい値（例: 32000以上）を確保する。

## 6. SearXNG（Web検索）の導入（Podman）

`web_search` ツールは SearXNG の JSON API を使う。Docker Desktop の代わりに Podman を使う場合の手順:

```powershell
winget install -e --id RedHat.Podman --accept-package-agreements --accept-source-agreements
podman machine init
podman machine start
```

設定ディレクトリを作り、コンテナを一度起動して既定の `settings.yml` を生成させる。

```powershell
New-Item -ItemType Directory -Force -Path "C:\path\to\tools\searxng" | Out-Null

podman run -d --name searxng `
  -p 8090:8080 `
  -v "C:\path\to\tools\searxng:/etc/searxng:Z" `
  --restart unless-stopped `
  searxng/searxng
```

生成された `settings.yml` に以下を追記し、JSON APIを有効化する（`web_search`ツール利用に必須）。Googleエンジンはブロック（CAPTCHA）が発生しやすいため無効化しておく。

```yaml
search:
  formats:
    - html
    - json

engines:
  - name: google
    disabled: true
  - name: bing
    disabled: false
  - name: duckduckgo
    disabled: false
```

設定変更後はコンテナを再起動する。

```powershell
podman restart searxng
```

動作確認:

```powershell
Invoke-WebRequest -Uri "http://localhost:8090/search?q=test&format=json" -UseBasicParsing
```

> ⚠️ **ポート衝突に注意**: SearXNGの既定ポートはコンテナ内部で`8080`だが、これは`llama-server`の既定ポートと同じ。ホスト側公開ポートは`8090`など別番号にし、`.env`の`SEARXNG_BASE_URL`もそのポートに合わせること。

## 7. `.env` の設定

```bash
AGENT_BACKEND=local-llm
LOCAL_LLM_BASE_URL=http://localhost:8080
LOCAL_LLM_MODEL=<任意の識別用文字列>   # llama-serverは起動時ロード済みモデルを使うため実際のモデル名と一致していなくてよい
LOCAL_LLM_NUM_CTX=32000                # llama-server起動時の -c と揃える

SEARXNG_BASE_URL=http://localhost:8090
```

Discord連携を使う場合は [Discord セットアップガイド](discord-setup.md) を参照。

## 8. 起動順序（毎回の起動）

PC再起動後などは、以下の順で起動する（自動起動設定をしていない場合）。

```powershell
# 1. SearXNG
podman machine start
podman start searxng

# 2. llama-server
cd C:\path\to\tools\llama.cpp
.\llama-server.exe -m models\<model>.gguf --host 127.0.0.1 --port 8080 -c 32000 -ngl 999 --cpu-moe

# 3. xangi
cd C:\path\to\xangi
npm start
```

常時稼働・自動復帰させたい場合は `./bin/xangi service start`（pm2）を使う（`llama-server` / SearXNG の自動起動は別途 pm2 やタスクスケジューラ等で設定する）。

## トラブルシューティング

| 症状 | 原因・対処 |
|---|---|
| `llama-server.exe` 起動時にDLLが見つからないエラー | `cudart-llama-bin-win-cuda-*.zip` を同じディレクトリに展開し忘れている |
| VRAM不足でモデルロードに失敗 | `--cpu-moe` を付けているか確認。それでも足りない場合は `-ngl` を下げてより多くの層をCPU側に逃がす |
| 応答はあるが文脈を全く覚えていない | 起動ログの `historyTokens` がマイナスになっていないか確認。`LOCAL_LLM_NUM_CTX` と `-c` を上げる |
| `web_search` が使えない | `SEARXNG_BASE_URL` のポートが `llama-server` と衝突していないか、`settings.yml` の `formats` に `json` があるか確認 |
