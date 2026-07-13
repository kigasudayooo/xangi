/**
 * 起動時に表示する Web UI のアクセス URL を解決する。
 *
 * - localhost は必ず含める
 * - tailscale CLI が利用可能なら MagicDNS hostname と Tailscale IP も加える
 * - tailscale が見つからない / オフライン / タイムアウトしたら黙って localhost のみ返す
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TAILSCALE_TIMEOUT_MS = 2000;

interface TailscaleStatusJson {
  Self?: {
    HostName?: string;
    DNSName?: string;
  };
  MagicDNSSuffix?: string;
}

interface TailscaleInfo {
  ips: string[];
  hostname?: string;
}

/** tailscale CLI から自分の IP と MagicDNS hostname を取得（best-effort）。失敗時 null。 */
async function probeTailscale(): Promise<TailscaleInfo | null> {
  let ips: string[] = [];
  try {
    const { stdout } = await execFileAsync('tailscale', ['ip', '-4'], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    ips = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
  } catch {
    return null;
  }
  if (ips.length === 0) return null;

  let hostname: string | undefined;
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--self', '--json'], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    const j = JSON.parse(stdout) as TailscaleStatusJson;
    const h = j?.Self?.HostName;
    if (typeof h === 'string' && h.length > 0) hostname = h;
  } catch {
    // hostname なしでも IP だけで十分
  }
  return { ips, hostname };
}

/**
 * bind host の種別。表示すべきアクセス URL の範囲を決める。
 * - loopback : 127.0.0.1 / localhost / ::1 → localhost からのみ到達可能
 * - wildcard : 0.0.0.0 / :: / 未指定 → 全インターフェースで待受
 * - specific : 上記以外（特定の LAN IP / Tailscale IP 等）→ その host のみ到達可能
 */
export type BindHostKind = 'loopback' | 'wildcard' | 'specific';

export function classifyBindHost(host?: string): BindHostKind {
  if (!host) return 'wildcard';
  const h = host.trim().toLowerCase();
  if (h === '') return 'wildcard';
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'loopback';
  if (h === '0.0.0.0' || h === '::') return 'wildcard';
  return 'specific';
}

/**
 * bind host が loopback（localhost からのみ到達可能）かどうか。
 * 0.0.0.0 / :: / 未指定は全インターフェース bind 扱いで false を返す。
 */
export function isLoopbackHost(host?: string): boolean {
  return classifyBindHost(host) === 'loopback';
}

/** host を URL の authority 表記にする（IPv6 は角括弧で囲む）。 */
function hostToAuthority(host: string): string {
  const h = host.trim();
  // IPv6（`:` を含み、まだ角括弧で囲まれていない）は [] で囲む
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

/**
 * 指定 port のアクセス URL 候補を返す（重複なし、実際に到達できる経路のみ）。
 * 例: ['http://localhost:18889', 'http://spark-edbc:18889', 'http://100.86.210.85:18889']
 *
 * host の種別で表示範囲を変え、到達できない URL を出して誤誘導しないようにする:
 * - loopback (127.0.0.1 / localhost / ::1) : localhost のみ（Tailscale の probe もしない）
 * - wildcard (0.0.0.0 / :: / 未指定)       : localhost + LAN/Tailscale（従来どおり）
 * - specific (特定 IP 等)                  : bind した host の URL のみ
 */
export async function resolveAccessUrls(port: number, host?: string): Promise<string[]> {
  const kind = classifyBindHost(host);
  if (kind === 'loopback') return [`http://localhost:${port}`];
  if (kind === 'specific') return [`http://${hostToAuthority(host as string)}:${port}`];
  // wildcard: localhost + Tailscale/LAN（best-effort）
  const urls: string[] = [`http://localhost:${port}`];
  const ts = await probeTailscale();
  if (!ts) return urls;
  if (ts.hostname) urls.push(`http://${ts.hostname}:${port}`);
  for (const ip of ts.ips) urls.push(`http://${ip}:${port}`);
  return Array.from(new Set(urls));
}

/**
 * 起動直後に同期表示する主アクセス URL（probe 前でも確定できる）。
 * specific bind なら bind した host、それ以外は localhost。
 */
export function primaryAccessUrl(port: number, host?: string): string {
  if (classifyBindHost(host) === 'specific') {
    return `http://${hostToAuthority(host as string)}:${port}`;
  }
  return `http://localhost:${port}`;
}

/** 起動ログ用にフォーマット。複数行を返す（caller が console.log するだけで OK） */
export function formatAccessUrls(label: string, urls: string[]): string {
  const lines = [`[${label}] Access URLs:`];
  for (const u of urls) lines.push(`  - ${u}`);
  return lines.join('\n');
}

/** テスト用に inject できる probe 関数（mock 差し替え用） */
export const __test__ = {
  probeTailscale,
};
