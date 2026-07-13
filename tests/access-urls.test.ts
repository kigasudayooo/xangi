import { describe, it, expect, vi } from 'vitest';

// child_process.execFile を vi.hoisted でモック
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// promisify(execFile) は callback スタイルを Promise に変換するので、mock も
// (cmd, args, options, cb) のシグネチャで callback を呼ぶ必要がある
function setExecFileResponses(
  responses: Array<{ args: string[]; result: { stdout?: string; error?: Error } }>
): void {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      options: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      const matched = responses.find((r) => JSON.stringify(r.args) === JSON.stringify(args));
      if (!matched) {
        cb(new Error(`unexpected execFile args: ${cmd} ${args.join(' ')}`), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      if (matched.result.error) {
        cb(matched.result.error, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: matched.result.stdout || '', stderr: '' });
      }
    }
  );
}

// dynamic import で mock 後にロード
async function loadModule() {
  return import('../src/access-urls.js');
}

describe('resolveAccessUrls', () => {
  it('Tailscale が利用不可なら localhost のみ返す', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { error: new Error('command not found') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889']);
  });

  it('Tailscale IP のみ取得できれば IP を追加する', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      { args: ['status', '--self', '--json'], result: { error: new Error('json failed') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889', 'http://100.86.210.85:18889']);
  });

  it('Tailscale IP + hostname 両方取れれば両方含める', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      {
        args: ['status', '--self', '--json'],
        result: { stdout: JSON.stringify({ Self: { HostName: 'spark-edbc' } }) },
      },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual([
      'http://localhost:18889',
      'http://spark-edbc:18889',
      'http://100.86.210.85:18889',
    ]);
  });

  it('複数 IP（IPv4 のみ）に対応する', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n100.64.0.1\n' } },
      { args: ['status', '--self', '--json'], result: { error: new Error('skip') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toContain('http://100.86.210.85:18889');
    expect(urls).toContain('http://100.64.0.1:18889');
    expect(urls[0]).toBe('http://localhost:18889');
  });

  it('壊れた IP 文字列は無視する', async () => {
    setExecFileResponses([{ args: ['ip', '-4'], result: { stdout: 'garbage\nnot-an-ip\n' } }]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889']);
  });

  it('host が loopback なら Tailscale を probe せず localhost のみ返す', async () => {
    // Tailscale が使える状況でも loopback bind なら localhost だけを返す。
    // execFile が一度も呼ばれないこと（= probe しない）も確認する。
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      {
        args: ['status', '--self', '--json'],
        result: { stdout: JSON.stringify({ Self: { HostName: 'spark-edbc' } }) },
      },
    ]);
    mockExecFile.mockClear();
    const { resolveAccessUrls } = await loadModule();
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const urls = await resolveAccessUrls(18889, host);
      expect(urls).toEqual(['http://localhost:18889']);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('host が 0.0.0.0 / 未指定なら従来どおり LAN/Tailscale URL を含める', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      {
        args: ['status', '--self', '--json'],
        result: { stdout: JSON.stringify({ Self: { HostName: 'spark-edbc' } }) },
      },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889, '0.0.0.0');
    expect(urls).toEqual([
      'http://localhost:18889',
      'http://spark-edbc:18889',
      'http://100.86.210.85:18889',
    ]);
  });

  it('host が特定 IP なら probe せず、その host の URL のみ返す', async () => {
    // 特定 IP に bind した場合、localhost や別 IF の URL は到達できないので出さない。
    // probe（execFile）も呼ばれないこと（無駄・誤誘導の防止）を確認する。
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      {
        args: ['status', '--self', '--json'],
        result: { stdout: JSON.stringify({ Self: { HostName: 'spark-edbc' } }) },
      },
    ]);
    mockExecFile.mockClear();
    const { resolveAccessUrls } = await loadModule();
    expect(await resolveAccessUrls(18889, '192.168.1.10')).toEqual(['http://192.168.1.10:18889']);
    expect(await resolveAccessUrls(18889, '100.86.210.85')).toEqual(['http://100.86.210.85:18889']);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('host が特定 IPv6 なら角括弧で囲んだ URL を返す', async () => {
    const { resolveAccessUrls } = await loadModule();
    expect(await resolveAccessUrls(18889, 'fd00::1')).toEqual(['http://[fd00::1]:18889']);
  });
});

describe('classifyBindHost', () => {
  it('loopback / wildcard / specific を分類する', async () => {
    const { classifyBindHost } = await loadModule();
    for (const h of ['127.0.0.1', 'localhost', '::1', ' LOCALHOST ']) {
      expect(classifyBindHost(h)).toBe('loopback');
    }
    for (const h of ['0.0.0.0', '::', undefined, '', '  ']) {
      expect(classifyBindHost(h)).toBe('wildcard');
    }
    for (const h of ['192.168.1.10', '100.86.210.85', 'fd00::1']) {
      expect(classifyBindHost(h)).toBe('specific');
    }
  });
});

describe('primaryAccessUrl', () => {
  it('specific は bind した host、それ以外は localhost を返す', async () => {
    const { primaryAccessUrl } = await loadModule();
    expect(primaryAccessUrl(18889)).toBe('http://localhost:18889');
    expect(primaryAccessUrl(18889, '0.0.0.0')).toBe('http://localhost:18889');
    expect(primaryAccessUrl(18889, '127.0.0.1')).toBe('http://localhost:18889');
    expect(primaryAccessUrl(18889, '192.168.1.10')).toBe('http://192.168.1.10:18889');
    expect(primaryAccessUrl(18889, 'fd00::1')).toBe('http://[fd00::1]:18889');
  });
});

describe('isLoopbackHost', () => {
  it('loopback host を判定し、全インターフェース bind は false', async () => {
    const { isLoopbackHost } = await loadModule();
    for (const h of ['127.0.0.1', 'localhost', '::1', ' LOCALHOST ']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', undefined, '', '192.168.1.10']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('formatAccessUrls', () => {
  it('label と URL リストを整形する', async () => {
    const { formatAccessUrls } = await loadModule();
    const out = formatAccessUrls('web-chat', ['http://localhost:18889', 'http://spark-edbc:18889']);
    expect(out).toBe(
      ['[web-chat] Access URLs:', '  - http://localhost:18889', '  - http://spark-edbc:18889'].join(
        '\n'
      )
    );
  });

  it('URL リストが空でもヘッダだけ出る', async () => {
    const { formatAccessUrls } = await loadModule();
    const out = formatAccessUrls('web-chat', []);
    expect(out).toBe('[web-chat] Access URLs:');
  });
});
