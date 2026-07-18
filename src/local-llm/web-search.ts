/**
 * web_search ツール — 検証パイプライン内蔵の Web 検索
 *
 * 小型ローカルLLM（1〜4B）のハルシネーション対策として、検索〜引用抽出〜検証を
 * ツール内部で完結させる。verifier LLM が本文から抜き出した引用を、プログラム的に
 * 出典本文との一致で二重チェックし、検証を通った引用のみを返す（フェイルクローズ）。
 *
 * パイプライン:
 *   1. 検索: SearXNG JSON API で上位 num_results 件を取得
 *   2. 取得: 上位3件のページを fetch し HTML から簡易テキスト抽出
 *   3. 引用抽出: verifier LLM に本文（先頭 ~6000字）から関連記述を一字一句抜かせる
 *   4. 検証: 抽出引用が出典本文に実在するかを verifyQuoteInSource で機械検証
 *   5. 返却: 検証済み引用のみを構造化テキストで返す
 *
 * llama.cpp（llama-server）運用時は、メインモデルと verifier を別ポートの2インスタンス
 * （例: :8080 と :8081）で起動し、WEB_SEARCH_VERIFIER_BASE_URL で verifier 側を指す想定。
 */
import { LLMClient } from './llm-client.js';
import type { ToolHandler, ToolResult } from './types.js';

// --- 設定値（env はテストで差し替え可能にするため呼び出し時に読む） ---

const VERIFY_SIMILARITY_THRESHOLD = 0.85;
const SOURCE_TRUNCATE_CHARS = 6000;
const PAGE_FETCH_BYTES_LIMIT = 100 * 1024;
const MAX_PAGES_TO_FETCH = 3;
const MAX_QUOTES_PER_PAGE = 3;
const QUOTE_MAX_CHARS = 400; // verifier 暴走時に DP コストが爆発しないよう上限を設ける
const TRAILING_NOTE = 'この結果に含まれない事実を回答に加えないこと';

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface VerifiedQuote {
  quote: string;
  title: string;
  url: string;
}

// --- テキスト正規化と引用検証（純関数・テスト可能） ---

/**
 * 一致判定用にテキストを正規化する。
 * 全角スペース・改行・タブ・各種引用符を吸収し、連続空白を1つに圧縮する。
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/\u3000/g, ' ') // 全角スペース → 半角
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'`“”‘’「」『』«»]/g, '') // 引用符を除去して両者を揃える
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * quote を source の部分文字列として近似照合したときの最小編集距離を返す。
 * source のどの位置からでもマッチ開始できるよう先頭行をゼロで初期化する
 * approximate substring matching DP（スライディングウィンドウの正規化
 * レーベンシュタインと機能的に等価で、計算量は O(m*n)）。
 */
function approximateSubstringDistance(quote: string, source: string): number {
  const m = quote.length;
  const n = source.length;
  if (m === 0) return 0;
  if (n === 0) return m;

  // prev/curr は source 上の各終端位置における最小編集距離
  let prev = new Array<number>(n + 1).fill(0); // dp[0][j] = 0（どこからでも開始可）
  const curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i; // quote の先頭 i 文字を空にマッチ = i 回削除
    const qc = quote.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = qc === source.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    prev = curr.slice();
  }

  // quote 全体（i=m 行）を消費したうえで、任意の終端位置での最小値が近似距離
  let min = prev[0];
  for (let j = 1; j <= n; j++) {
    if (prev[j] < min) min = prev[j];
  }
  return min;
}

/**
 * quote が source 本文中に実在するかを検証する。
 * 第一判定は正規化後の部分一致、失敗時は近似部分一致の正規化類似度
 * （1 - dist/quote長）がしきい値以上かで判定する。
 */
export function verifyQuoteInSource(quote: string, source: string): boolean {
  const nq = normalizeForMatch(quote).slice(0, QUOTE_MAX_CHARS);
  const ns = normalizeForMatch(source);
  if (nq.length === 0) return false;

  // 第一判定: 正規化後の完全部分一致
  if (ns.includes(nq)) return true;

  // 第二判定: 近似部分一致の類似度
  const dist = approximateSubstringDistance(nq, ns);
  const similarity = 1 - dist / nq.length;
  return similarity >= VERIFY_SIMILARITY_THRESHOLD;
}

// --- HTML 簡易テキスト抽出（依存追加なし） ---

/**
 * HTML から素朴にテキストを抽出する。script/style を除去し、タグを剥がし、
 * 主要な HTML エンティティをデコードして空白を正規化する。
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * verifier LLM の応答テキストから JSON 配列（文字列配列）を抽出する。
 * ```json フェンスや前後の地の文を許容し、パース失敗時は null を返す。
 */
export function parseQuoteArray(raw: string): string[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

// --- パイプライン各段 ---

/** SearXNG JSON API で検索する。未設定・失敗は例外で表現する。 */
async function searxngSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_BASE_URL;
  if (!base) {
    throw new Error('SEARXNG_BASE_URL が未設定です');
  }
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;

  const timeoutMs = parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? '15000', 10);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'xangi/local-llm', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(data.results) ? data.results : [];
    return results.slice(0, numResults).map((r) => ({
      title: typeof r.title === 'string' ? r.title : '(no title)',
      url: typeof r.url === 'string' ? r.url : '',
      content: typeof r.content === 'string' ? r.content : '',
    }));
  } finally {
    clearTimeout(timeoutId);
  }
}

/** ページを fetch し HTML からテキスト抽出する。失敗時は null（当該ページをスキップ）。 */
async function fetchPageText(url: string): Promise<string | null> {
  if (!url) return null;
  const timeoutMs = parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? '15000', 10);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'xangi/local-llm',
        Accept: 'text/html,application/json,text/plain,*/*',
      },
    });
    if (!res.ok) return null;
    let raw = await res.text();
    if (raw.length > PAGE_FETCH_BYTES_LIMIT) raw = raw.slice(0, PAGE_FETCH_BYTES_LIMIT);
    return stripHtml(raw);
  } catch {
    // ネットワークエラー・タイムアウト等はフェイルクローズで当該ページをスキップ
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const VERIFIER_SYSTEM_PROMPT =
  'あなたは出典テキストからの引用抽出器です。ユーザーのクエリに関連する記述を、' +
  '出典テキストから一字一句そのまま、最大3つまで抜き出してください。' +
  '要約・言い換え・翻訳・創作は禁止です。関連情報がなければ空配列を返します。' +
  '出力は文字列の JSON 配列のみ（例: ["...", "..."]）。それ以外の文字は一切含めないこと。';

/**
 * verifier LLM に本文（先頭 ~6000字）からクエリ関連の引用を抜かせる。
 * chat() が例外を投げた場合（Ollama 停止等）はそのまま伝播させ、
 * 呼び出し側で success:false のエラーに変換する。
 * JSON パース失敗は null を返し、当該ページをスキップさせる。
 */
async function extractQuotes(
  verifier: LLMClient,
  query: string,
  sourceText: string
): Promise<string[] | null> {
  const truncated = sourceText.slice(0, SOURCE_TRUNCATE_CHARS);
  const response = await verifier.chat(
    [
      {
        role: 'user',
        content:
          `クエリ: ${query}\n\n` +
          `出典テキスト:\n"""\n${truncated}\n"""\n\n` +
          'このクエリに関連する記述を出典テキストから一字一句そのまま、最大3つ、' +
          'JSON 配列で抜き出してください。関連情報がなければ [] を返してください。',
      },
    ],
    { systemPrompt: VERIFIER_SYSTEM_PROMPT, temperature: 0 }
  );
  return parseQuoteArray(response.content);
}

// --- 出力整形 ---

function formatVerified(verified: VerifiedQuote[]): string {
  const blocks = verified.map((v) => `[検証済み] "${v.quote}"\n出典: ${v.title} (${v.url})`);
  return `${blocks.join('\n\n')}\n\n${TRAILING_NOTE}。`;
}

function formatUnverified(results: SearchResult[]): string {
  const header = '※本文検証済みの引用は得られなかった。以下は未検証の検索結果一覧';
  if (results.length === 0) {
    return `${header}\n（検索結果なし）\n\n${TRAILING_NOTE}。`;
  }
  const list = results.map((r) => `- ${r.title} (${r.url})`).join('\n');
  return `${header}\n${list}\n\n${TRAILING_NOTE}。`;
}

// --- ToolHandler ---

export const webSearchToolHandler: ToolHandler = {
  name: 'web_search',
  description:
    'Web検索。返される引用は出典との一致を機械検証済み。結果にない事実を足さないこと。' +
    'クエリを渡すと検索・本文取得・引用抽出・検証を内部で完結し、' +
    '出典本文と一致が確認できた引用のみを返す。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索クエリ' },
      num_results: {
        type: 'number',
        description: '取得する検索結果件数（既定5）',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    if (!query || typeof query !== 'string') {
      return { success: false, output: '', error: 'query is required' };
    }
    const numResults =
      typeof args.num_results === 'number' && args.num_results > 0
        ? Math.floor(args.num_results)
        : 5;

    // 1. 検索
    let results: SearchResult[];
    try {
      results = await searxngSearch(query, numResults);
    } catch (err) {
      return { success: false, output: '', error: String((err as Error).message ?? err) };
    }

    // verifier LLM を内部インスタンス化
    // 優先順位: WEB_SEARCH_VERIFIER_BASE_URL（別インスタンス） > LOCAL_LLM_BASE_URL > localhost:11434
    const baseUrl = (
      process.env.WEB_SEARCH_VERIFIER_BASE_URL ||
      process.env.LOCAL_LLM_BASE_URL ||
      'http://localhost:11434'
    ).replace(/\/$/, '');
    const verifierModel = process.env.WEB_SEARCH_VERIFIER_MODEL || 'qwen3:1.7b';
    const verifier = new LLMClient(baseUrl, verifierModel);

    // 2〜4. 上位3件を取得 → 引用抽出 → 機械検証
    const verified: VerifiedQuote[] = [];
    const pages = results.slice(0, MAX_PAGES_TO_FETCH);
    try {
      for (const result of pages) {
        const text = await fetchPageText(result.url);
        if (!text) continue; // ページ取得失敗はスキップ（フェイルクローズ）

        const quotes = await extractQuotes(verifier, query, text);
        if (quotes === null) continue; // JSON パース失敗はスキップ（フェイルクローズ）

        const source = text.slice(0, SOURCE_TRUNCATE_CHARS);
        for (const quote of quotes.slice(0, MAX_QUOTES_PER_PAGE)) {
          if (verifyQuoteInSource(quote, source)) {
            verified.push({ quote, title: result.title, url: result.url });
          }
          // 一致しない引用は破棄
        }
      }
    } catch (err) {
      // verifier LLM 呼び出し失敗（Ollama 停止等）は明示エラー
      return {
        success: false,
        output: '',
        error: `検証LLMの呼び出しに失敗しました: ${String((err as Error).message ?? err)}`,
      };
    }

    // 5. 返却
    const output = verified.length > 0 ? formatVerified(verified) : formatUnverified(results);
    return { success: true, output };
  },
};
