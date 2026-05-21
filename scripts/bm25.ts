/**
 * Okapi BM25 — 古典的 TF-IDF 改良アルゴリズム。
 *
 * https://en.wikipedia.org/wiki/Okapi_BM25
 *
 * score(D, Q) = sum over q in Q of:
 *   IDF(q) * (f(q,D) * (k1 + 1)) / (f(q,D) + k1 * (1 - b + b * |D| / avgdl))
 *
 * - f(q,D): term frequency of q in document D
 * - |D|: length of document D in terms
 * - avgdl: average document length across the corpus
 * - k1: term frequency saturation parameter (default 1.5)
 * - b: length normalization (default 0.75)
 */

export interface BM25Document {
  /** unique identifier (returned in results) */
  id: string;
  /** tokens (already tokenized / lowercased) */
  tokens: string[];
}

export interface BM25Hit {
  id: string;
  score: number;
}

export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly documents = new Map<string, string[]>();
  /** term → number of documents containing the term */
  private readonly df = new Map<string, number>();
  private avgdl = 0;
  private totalDocs = 0;

  constructor(k1: number = 1.5, b: number = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  add(doc: BM25Document): void {
    this.documents.set(doc.id, doc.tokens);
    const uniqueTerms = new Set(doc.tokens);
    for (const term of uniqueTerms) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.totalDocs++;
    this.recalcAvgdl();
  }

  private recalcAvgdl(): void {
    let total = 0;
    for (const tokens of this.documents.values()) total += tokens.length;
    this.avgdl = total / Math.max(1, this.totalDocs);
  }

  private idf(term: string): number {
    const dfTerm = this.df.get(term) ?? 0;
    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    return Math.log((this.totalDocs - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
  }

  search(queryTokens: string[], limit: number = 10): BM25Hit[] {
    const hits: BM25Hit[] = [];
    for (const [id, docTokens] of this.documents) {
      const score = this.scoreDocument(queryTokens, docTokens);
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  private scoreDocument(queryTokens: string[], docTokens: string[]): number {
    const docLen = docTokens.length;
    if (docLen === 0) return 0;

    const tf = new Map<string, number>();
    for (const token of docTokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    let score = 0;
    const queryUnique = new Set(queryTokens);
    for (const q of queryUnique) {
      const fqD = tf.get(q) ?? 0;
      if (fqD === 0) continue;
      const idf = this.idf(q);
      const numerator = fqD * (this.k1 + 1);
      const denominator = fqD + this.k1 * (1 - this.b + (this.b * docLen) / Math.max(1, this.avgdl));
      score += idf * (numerator / denominator);
    }
    return score;
  }
}

/**
 * 日本語+英語混在テキストの簡易トークナイザ。
 *
 * - ASCII 英数字: 単語境界で分割 (lowercase)
 * - 日本語 (CJK): 2-gram (bigram) で文字レベル分割
 * - 句読点・記号: 区切りとして扱う
 *
 * 高度な形態素解析 (kuromoji 等) を使わず、依存性ゼロで日英対応するための実装。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // ASCII word run と CJK run を交互に取り出す
  const asciiWord = /[a-z0-9]+/g;
  const cjkChar = /[　-ヿ㐀-鿿豈-﫿]+/g;

  // ASCII 単語をまず抽出
  let m: RegExpExecArray | null;
  asciiWord.lastIndex = 0;
  while ((m = asciiWord.exec(lower)) !== null) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }

  // CJK 文字列を bigram 分割
  cjkChar.lastIndex = 0;
  while ((m = cjkChar.exec(lower)) !== null) {
    const cjkStr = m[0];
    for (let i = 0; i < cjkStr.length - 1; i++) {
      tokens.push(cjkStr.substring(i, i + 2));
    }
    // 1 文字だけの場合は unigram も
    if (cjkStr.length === 1) tokens.push(cjkStr);
  }

  return tokens;
}
