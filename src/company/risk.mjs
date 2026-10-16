import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapted from RAG-Yuki/xhs-ad-workbench/content/risk-review.mjs.
// The source workbench is MIT licensed; see licenses/xhs-ad-workbench-MIT.txt.
// The bundled lexicon is a static copy of its publicly distributed extraction.
const rank = Object.freeze({ low: 1, medium: 2, high: 3 });
const lexiconPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'risk-lexicon.json');

function readLexicon() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(lexiconPath, 'utf8')); }
  catch { throw new Error('公司风险词库无法读取或格式无效'); }
  if (!Array.isArray(payload?.entries) || payload.entries.some((entry) =>
    !entry || typeof entry.word !== 'string' || !entry.word || !rank[entry.riskLevel]
    || typeof entry.category !== 'string' || (entry.description != null && typeof entry.description !== 'string')
    || (entry.suggestion != null && typeof entry.suggestion !== 'string'))) {
    throw new Error('公司风险词库无法读取或格式无效');
  }
  return payload.entries;
}

const entries = readLexicon();
const terms = new Set(entries.map((entry) => entry.word));

/** Scan copy for lexicon matches. Results are review hints and never approve content. */
export function checkCompanyCopy(text) {
  if (typeof text !== 'string') throw new Error('检查文案必须是文字');
  if (text.length > 500_000) throw new Error('检查文案超过 500000 字符限制');

  const grouped = new Map();
  for (const entry of entries) {
    let offset = text.indexOf(entry.word);
    while (offset >= 0) {
      const key = `${offset}|${entry.word}`;
      let match = grouped.get(key);
      if (!match) {
        match = {
          term: entry.word,
          offset,
          order: offset,
          category: new Set(),
          level: 'low',
          reason: new Set(),
          suggestions: new Set(),
          sourceIndices: new Set(),
        };
        grouped.set(key, match);
      }
      match.category.add(entry.category);
      if (rank[entry.riskLevel] > rank[match.level]) match.level = entry.riskLevel;
      if (entry.description) match.reason.add(entry.description);
      if (entry.suggestion) match.suggestions.add(entry.suggestion);
      if (Number.isInteger(entry.index)) match.sourceIndices.add(entry.index);
      offset = text.indexOf(entry.word, offset + entry.word.length);
    }
  }

  const matches = [...grouped.values()]
    .sort((left, right) => left.offset - right.offset || right.term.length - left.term.length)
    .map((match) => ({
      term: match.term,
      offset: match.offset,
      order: match.order,
      category: [...match.category],
      level: match.level,
      reason: [...match.reason],
      suggestions: [...match.suggestions],
      index: [...match.sourceIndices],
    }));

  return { matches, recordCount: entries.length, termCount: terms.size };
}
