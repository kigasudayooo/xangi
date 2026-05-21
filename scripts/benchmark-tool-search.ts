/**
 * tool_search ベンチマーク: 現状の substring 一致検索 (scoreToolMatch) と
 * BM25 prototype を同じ query セットで比較し、precision@1 / precision@3 を出す。
 *
 * 実行: cd xangi-dev && npx tsx scripts/benchmark-tool-search.ts
 *
 * 入力: xangi-family の skills (26 個) + 想定 query セット (golden answer 付き)
 * 出力: 各 query での top-3 結果、両 algorithm の precision、改善差分
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { BM25Index, tokenize } from './bm25.js';

interface Skill {
  id: string;
  name: string;
  description: string;
}

interface QueryCase {
  query: string;
  expected: string; // skill id (e.g., 'arxiv')
  category: string; // 'direct' | 'synonym' | 'english' | 'indirect'
}

// ============================================================================
// 現状の substring 検索 (src/local-llm/tools.ts:scoreToolMatch のコピー)
// ============================================================================

function scoreSubstring(query: string, skill: Skill): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();

  if (name === q) return 100;
  let score = 0;
  if (name.includes(q)) score += 50;

  const tokens = q.split(/[\s,]+/).filter(Boolean);
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (name.includes(token)) score += 20;
    if (desc.includes(token)) score += 10;
  }
  return score;
}

// ============================================================================
// Skill loading
// ============================================================================

function loadSkills(skillsDir: string): Skill[] {
  const skills: Skill[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, entry);
    if (!statSync(skillPath).isDirectory()) continue;
    const skillMdPath = join(skillPath, 'SKILL.md');
    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      // frontmatter 抽出 (--- で囲まれた YAML、 name: と description: を simple regex で取り出す)
      const match = content.match(/^---\n([\s\S]+?)\n---/);
      if (!match) continue;
      const fm = match[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (nameMatch && descMatch) {
        skills.push({
          id: entry,
          name: nameMatch[1].trim().replace(/^['"]|['"]$/g, ''),
          description: descMatch[1].trim().replace(/^['"]|['"]$/g, ''),
        });
      }
    } catch {
      // skip malformed
    }
  }
  return skills;
}

// ============================================================================
// クエリセット (golden answer 付き)
//
// category:
//   direct  - skill name や明示的キーワード (例: "arxiv", "calendar")
//   synonym - description 内のキーワード (例: "論文検索" → arxiv)
//   english - 英語 query で日本語 description にマッチ
//   indirect - 間接表現 (description 周辺、推論必要)
// ============================================================================

const QUERY_CASES: QueryCase[] = [
  // direct
  { query: 'arxiv', expected: 'arxiv', category: 'direct' },
  { query: 'calendar', expected: 'calendar', category: 'direct' },
  { query: 'cat-diary', expected: 'cat-diary', category: 'direct' },
  { query: 'code-reviewer', expected: 'code-reviewer', category: 'direct' },
  { query: 'diary', expected: 'diary', category: 'direct' },
  { query: 'news-digest', expected: 'news-digest', category: 'direct' },
  { query: 'transcriber', expected: 'transcriber', category: 'direct' },
  { query: 'web-search', expected: 'web-search', category: 'direct' },

  // synonym (description 内のキーワード)
  { query: '論文検索', expected: 'arxiv', category: 'synonym' },
  { query: '論文分析して', expected: 'arxiv', category: 'synonym' },
  { query: '今日の予定', expected: 'calendar', category: 'synonym' },
  { query: '明日のスケジュール', expected: 'calendar', category: 'synonym' },
  { query: '猫日記', expected: 'cat-diary', category: 'synonym' },
  { query: '猫写真', expected: 'cat-diary', category: 'synonym' },
  { query: 'PR レビュー', expected: 'code-reviewer', category: 'synonym' },
  { query: 'コードレビュー', expected: 'code-reviewer', category: 'synonym' },
  { query: '図を作って', expected: 'diagram-generator', category: 'synonym' },
  { query: 'フローチャート', expected: 'diagram-generator', category: 'synonym' },
  { query: '日記書いて', expected: 'diary', category: 'synonym' },
  { query: '週次振り返り', expected: 'diary', category: 'synonym' },
  { query: 'GitHub リポジトリ分析', expected: 'github-repo-analyzer', category: 'synonym' },
  { query: 'メタボ対策', expected: 'health-advisor', category: 'synonym' },
  { query: 'ニュース', expected: 'news-digest', category: 'synonym' },
  { query: '今日のニュース', expected: 'news-digest', category: 'synonym' },
  { query: 'ノートにまとめて', expected: 'note-taking', category: 'synonym' },
  { query: 'スキル作って', expected: 'skill-creator', category: 'synonym' },
  { query: '話しかけて', expected: 'spontaneous-talk', category: 'synonym' },
  { query: '技術ニュース', expected: 'tech-news-curation', category: 'synonym' },
  { query: '文字起こし', expected: 'transcriber', category: 'synonym' },
  { query: 'ググって', expected: 'web-search', category: 'synonym' },
  { query: 'workspace 検索', expected: 'workspace-rag', category: 'synonym' },
  { query: 'kaizen', expected: 'xangi-kaizen', category: 'synonym' },
  { query: '事象を分析', expected: 'xangi-kaizen', category: 'synonym' },
  { query: 'YouTube 字幕', expected: 'youtube-notes', category: 'synonym' },

  // english (英語 query で日本語 description)
  { query: 'paper search', expected: 'arxiv', category: 'english' },
  { query: 'todays schedule', expected: 'calendar', category: 'english' },
  { query: 'google calendar', expected: 'calendar', category: 'english' },
  { query: 'cat photo', expected: 'cat-diary', category: 'english' },
  { query: 'pr review', expected: 'code-reviewer', category: 'english' },
  { query: 'flowchart', expected: 'diagram-generator', category: 'english' },
  { query: 'github analysis', expected: 'github-repo-analyzer', category: 'english' },
  { query: 'news', expected: 'news-digest', category: 'english' },
  { query: 'youtube', expected: 'youtube-notes', category: 'english' },

  // indirect (推論必要、description 周辺)
  { query: '面白い研究探したい', expected: 'arxiv', category: 'indirect' },
  { query: 'いつ何があるか確認', expected: 'calendar', category: 'indirect' },
  { query: '健康に気をつけたい', expected: 'health-advisor', category: 'indirect' },
  { query: '何が起きてるか知りたい', expected: 'news-digest', category: 'indirect' },
  { query: '音声から文章', expected: 'transcriber', category: 'indirect' },
];

// ============================================================================
// メイン
// ============================================================================

function main(): void {
  const skillsDir = process.argv[2] || '/home/karaage/karaage-family/skills';
  const skills = loadSkills(skillsDir);
  console.log(`Loaded ${skills.length} skills from ${skillsDir}\n`);

  if (skills.length === 0) {
    console.error('No skills loaded, exit');
    process.exit(1);
  }

  // BM25 index 構築
  const bm25 = new BM25Index();
  for (const skill of skills) {
    const text = `${skill.name} ${skill.description}`;
    bm25.add({ id: skill.id, tokens: tokenize(text) });
  }

  // 各 query で両方走らせて比較
  const results: Array<{
    query: string;
    expected: string;
    category: string;
    substringTop3: string[];
    bm25Top3: string[];
    substringHit1: boolean;
    bm25Hit1: boolean;
    substringHit3: boolean;
    bm25Hit3: boolean;
  }> = [];

  for (const qc of QUERY_CASES) {
    const subResults = skills
      .map((s) => ({ id: s.id, score: scoreSubstring(qc.query, s) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const bm25Results = bm25.search(tokenize(qc.query), 3);

    results.push({
      query: qc.query,
      expected: qc.expected,
      category: qc.category,
      substringTop3: subResults.map((r) => r.id),
      bm25Top3: bm25Results.map((r) => r.id),
      substringHit1: subResults[0]?.id === qc.expected,
      bm25Hit1: bm25Results[0]?.id === qc.expected,
      substringHit3: subResults.some((r) => r.id === qc.expected),
      bm25Hit3: bm25Results.some((r) => r.id === qc.expected),
    });
  }

  // カテゴリ別集計
  const categories = ['direct', 'synonym', 'english', 'indirect'];
  for (const cat of categories) {
    const filtered = results.filter((r) => r.category === cat);
    const subP1 = filtered.filter((r) => r.substringHit1).length / Math.max(1, filtered.length);
    const subP3 = filtered.filter((r) => r.substringHit3).length / Math.max(1, filtered.length);
    const bmP1 = filtered.filter((r) => r.bm25Hit1).length / Math.max(1, filtered.length);
    const bmP3 = filtered.filter((r) => r.bm25Hit3).length / Math.max(1, filtered.length);
    console.log(`## ${cat} (n=${filtered.length})`);
    console.log(
      `  substring:  P@1=${(subP1 * 100).toFixed(1)}%  P@3=${(subP3 * 100).toFixed(1)}%`
    );
    console.log(`  BM25:       P@1=${(bmP1 * 100).toFixed(1)}%  P@3=${(bmP3 * 100).toFixed(1)}%`);
    console.log(
      `  Δ P@1=${((bmP1 - subP1) * 100).toFixed(1)}pp   Δ P@3=${((bmP3 - subP3) * 100).toFixed(1)}pp`
    );
    console.log();
  }

  // 全体集計
  const totalSubP1 = results.filter((r) => r.substringHit1).length / results.length;
  const totalSubP3 = results.filter((r) => r.substringHit3).length / results.length;
  const totalBmP1 = results.filter((r) => r.bm25Hit1).length / results.length;
  const totalBmP3 = results.filter((r) => r.bm25Hit3).length / results.length;
  console.log(`## 全体 (n=${results.length})`);
  console.log(
    `  substring:  P@1=${(totalSubP1 * 100).toFixed(1)}%  P@3=${(totalSubP3 * 100).toFixed(1)}%`
  );
  console.log(
    `  BM25:       P@1=${(totalBmP1 * 100).toFixed(1)}%  P@3=${(totalBmP3 * 100).toFixed(1)}%`
  );
  console.log(
    `  Δ P@1=${((totalBmP1 - totalSubP1) * 100).toFixed(1)}pp   Δ P@3=${((totalBmP3 - totalSubP3) * 100).toFixed(1)}pp`
  );
  console.log();

  // 改善 / 悪化 事例
  console.log(`## 改善事例 (substring miss → BM25 hit@1)`);
  for (const r of results) {
    if (!r.substringHit1 && r.bm25Hit1) {
      console.log(
        `  "${r.query}" → expected=${r.expected} | substring=${JSON.stringify(r.substringTop3)} | BM25=${JSON.stringify(r.bm25Top3)}`
      );
    }
  }
  console.log();

  console.log(`## 悪化事例 (substring hit@1 → BM25 miss@1)`);
  for (const r of results) {
    if (r.substringHit1 && !r.bm25Hit1) {
      console.log(
        `  "${r.query}" → expected=${r.expected} | substring=${JSON.stringify(r.substringTop3)} | BM25=${JSON.stringify(r.bm25Top3)}`
      );
    }
  }
  console.log();

  // 両方 miss 事例
  console.log(`## 両方 miss@1 事例 (改善余地大)`);
  for (const r of results) {
    if (!r.substringHit1 && !r.bm25Hit1) {
      console.log(
        `  "${r.query}" → expected=${r.expected} | substring=${JSON.stringify(r.substringTop3)} | BM25=${JSON.stringify(r.bm25Top3)}`
      );
    }
  }
}

main();
