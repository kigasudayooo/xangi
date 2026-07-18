import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// LLMClient を module-level の chat vi.fn でモックする。
// 各テストで chatMock.mockResolvedValueOnce(...) して verifier 応答をキューイングする。
// constructorMock でコンストラクタ引数（baseUrl, model）を記録し、
// verifier の接続先解決の優先順位をテストできるようにする。
const chatMock = vi.fn();
const constructorMock = vi.fn();
vi.mock('../src/local-llm/llm-client.js', () => ({
  LLMClient: class {
    chat = chatMock;
    constructor(...args: unknown[]) {
      constructorMock(...args);
    }
  },
}));

import {
  verifyQuoteInSource,
  normalizeForMatch,
  parseQuoteArray,
  webSearchToolHandler,
} from '../src/local-llm/web-search.js';

const ctx = { workspace: '/tmp' };

function chatResponse(content: string) {
  return { content, finishReason: 'stop' as const };
}

describe('verifyQuoteInSource', () => {
  it('正規化後の完全部分一致を検証する', () => {
    const source = 'これは  出典本文です。\n重要な事実がここにあります。';
    expect(verifyQuoteInSource('重要な事実がここにあります', source)).toBe(true);
  });

  it('全角スペース・引用符・改行の差異を吸収して一致とみなす', () => {
    const source = 'The　quick "brown"\nfox jumps.';
    expect(verifyQuoteInSource('the quick brown fox jumps', source)).toBe(true);
  });

  it('軽微なタイプミスは fuzzy 一致で許容する', () => {
    const source = 'The quick brown fox jumps over the lazy dog repeatedly.';
    // 1文字違い（jumps→jumbs）でも類似度 >= 0.85
    expect(verifyQuoteInSource('the quick brown fox jumbs over the lazy dog', source)).toBe(true);
  });

  it('出典に存在しない引用は破棄する（不一致）', () => {
    const source = 'The quick brown fox jumps over the lazy dog.';
    expect(verifyQuoteInSource('完全に無関係な捏造された事実です', source)).toBe(false);
  });

  it('空引用は false', () => {
    expect(verifyQuoteInSource('   ', 'something')).toBe(false);
  });
});

describe('normalizeForMatch', () => {
  it('全角スペースと連続空白を圧縮する', () => {
    expect(normalizeForMatch('a　b   c\nd')).toBe('a b c d');
  });
});

describe('parseQuoteArray', () => {
  it('フェンス付き JSON 配列をパースする', () => {
    expect(parseQuoteArray('```json\n["a", "b"]\n```')).toEqual(['a', 'b']);
  });
  it('不正 JSON は null', () => {
    expect(parseQuoteArray('これは配列ではありません')).toBeNull();
  });
});

describe('web_search pipeline', () => {
  beforeEach(() => {
    chatMock.mockReset();
    constructorMock.mockReset();
    process.env.SEARXNG_BASE_URL = 'http://searxng.local';
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.WEB_SEARCH_VERIFIER_BASE_URL;
  });

  function mockFetchDispatch(
    pageBodies: Record<string, { ok?: boolean; body: string }>,
    searchResults: Array<{ title: string; url: string; content: string }>
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('format=json')) {
          return {
            ok: true,
            json: async () => ({ results: searchResults }),
          } as unknown as Response;
        }
        const page = pageBodies[url];
        if (!page) return { ok: false, status: 404, text: async () => '' } as unknown as Response;
        return {
          ok: page.ok !== false,
          status: page.ok === false ? 500 : 200,
          text: async () => page.body,
        } as unknown as Response;
      })
    );
  }

  it('検証を通った引用のみ返す', async () => {
    const results = [
      { title: 'Page One', url: 'http://a.example/1', content: 'snippet' },
      { title: 'Page Two', url: 'http://b.example/2', content: 'snippet' },
    ];
    mockFetchDispatch(
      {
        'http://a.example/1': {
          body: '<html><body>本文に確かな事実が書いてあります。</body></html>',
        },
        'http://b.example/2': { body: '<html><body>別ページの内容です。</body></html>' },
      },
      results
    );
    // page1: 本文に実在する引用 + 実在しない引用
    chatMock.mockResolvedValueOnce(
      chatResponse('["本文に確かな事実が書いてあります", "捏造された存在しない事実"]')
    );
    // page2: 実在する引用
    chatMock.mockResolvedValueOnce(chatResponse('["別ページの内容です"]'));

    const res = await webSearchToolHandler.execute({ query: '事実' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('[検証済み] "本文に確かな事実が書いてあります"');
    expect(res.output).toContain('出典: Page One (http://a.example/1)');
    expect(res.output).toContain('[検証済み] "別ページの内容です"');
    // 捏造引用は破棄される
    expect(res.output).not.toContain('捏造された存在しない事実');
    // 末尾のインライン指示
    expect(res.output).toContain('この結果に含まれない事実を回答に加えないこと');
  });

  it('SEARXNG_BASE_URL 未設定はエラー', async () => {
    delete process.env.SEARXNG_BASE_URL;
    const res = await webSearchToolHandler.execute({ query: 'x' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('SEARXNG_BASE_URL が未設定');
  });

  it('verifier の JSON パース失敗時は当該ページをスキップ', async () => {
    const results = [{ title: 'Only', url: 'http://a.example/1', content: 'snippet' }];
    mockFetchDispatch(
      { 'http://a.example/1': { body: '<html><body>実在する本文テキスト。</body></html>' } },
      results
    );
    // パース不能な応答 → スキップ → 検証済み引用ゼロ → 未検証一覧
    chatMock.mockResolvedValueOnce(chatResponse('壊れた出力で配列ではない'));

    const res = await webSearchToolHandler.execute({ query: 'x' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('※本文検証済みの引用は得られなかった');
    expect(res.output).toContain('- Only (http://a.example/1)');
    expect(res.output).toContain('この結果に含まれない事実を回答に加えないこと');
  });

  it('verifier LLM 呼び出し失敗は success:false', async () => {
    const results = [{ title: 'Only', url: 'http://a.example/1', content: 'snippet' }];
    mockFetchDispatch(
      { 'http://a.example/1': { body: '<html><body>本文。</body></html>' } },
      results
    );
    chatMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await webSearchToolHandler.execute({ query: 'x' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('検証LLM');
  });

  it('WEB_SEARCH_VERIFIER_BASE_URL が設定されていれば LOCAL_LLM_BASE_URL より優先する', async () => {
    process.env.WEB_SEARCH_VERIFIER_BASE_URL = 'http://localhost:8081';
    const results = [{ title: 'Only', url: 'http://a.example/1', content: 'snippet' }];
    mockFetchDispatch(
      { 'http://a.example/1': { body: '<html><body>本文。</body></html>' } },
      results
    );
    chatMock.mockResolvedValueOnce(chatResponse('[]'));

    await webSearchToolHandler.execute({ query: 'x' }, ctx);
    expect(constructorMock).toHaveBeenCalledWith('http://localhost:8081', expect.any(String));
  });

  it('WEB_SEARCH_VERIFIER_BASE_URL 未設定時は LOCAL_LLM_BASE_URL にフォールバックする', async () => {
    delete process.env.WEB_SEARCH_VERIFIER_BASE_URL;
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:8080';
    const results = [{ title: 'Only', url: 'http://a.example/1', content: 'snippet' }];
    mockFetchDispatch(
      { 'http://a.example/1': { body: '<html><body>本文。</body></html>' } },
      results
    );
    chatMock.mockResolvedValueOnce(chatResponse('[]'));

    await webSearchToolHandler.execute({ query: 'x' }, ctx);
    expect(constructorMock).toHaveBeenCalledWith('http://localhost:8080', expect.any(String));
  });
});
