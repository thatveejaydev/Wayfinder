type SearchText = {
  literal: string;
  phrase: string;
  compact: string;
  compactChars: string[];
  words: string[];
  wordChars: string[][];
  initials: string;
};

function searchText(value: string): SearchText {
  const literal = value.normalize().toLowerCase().trim().replace(/\s+/g, " ");
  const phrase = literal.normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize().replace(/[\p{P}\s]+/gu, " ").trim();
  const words = phrase ? phrase.split(" ") : [];
  const compact = words.join("");
  return {
    literal,
    phrase,
    compact,
    compactChars: Array.from(compact),
    words,
    wordChars: words.map((word) => Array.from(word)),
    initials: words.map((word) => String.fromCodePoint(word.codePointAt(0)!)).join(""),
  };
}

export function indexShortcut<T extends { id: string }>(item: T, name: string, parents: string[]) {
  return { item, name: searchText(name), parents: parents.map(searchText) };
}

type IndexedShortcut<T extends { id: string }> = ReturnType<typeof indexShortcut<T>>;

// One insertion, deletion, substitution, or adjacent swap. Compare code points
// so a character outside the BMP is treated as one edit.
function withinOneEdit(term: string[], other: string[]): boolean {
  if (Math.abs(term.length - other.length) > 1) return false;
  let index = 0;
  while (index < term.length && term[index] === other[index]) index++;
  if (term.length === other.length) {
    if (term.slice(index + 1).every((letter, offset) => letter === other[index + 1 + offset])) return true;
    return term[index] === other[index + 1] && term[index + 1] === other[index]
      && term.slice(index + 2).every((letter, offset) => letter === other[index + 2 + offset]);
  }
  const [shorter, longer] = term.length < other.length ? [term, other] : [other, term];
  return shorter.slice(index).every((letter, offset) => letter === longer[index + 1 + offset]);
}

function wordRank(words: string[], term: string): number {
  if (words.includes(term)) return 0;
  if (words.some((word) => word.startsWith(term))) return 1;
  if (words.some((word) => word.includes(term))) return 2;
  return Infinity;
}

function matchRank(name: SearchText, parents: SearchText[], query: SearchText) {
  if (name.literal === query.literal) return [0, 0];
  if (!query.compact) return name.literal.includes(query.literal) ? [3, 0] : null;
  if (name.phrase === query.phrase || name.compact === query.compact) return [1, 0];
  const compactMatch = query.compactChars.length > 2;
  if (name.phrase.startsWith(query.phrase) || (compactMatch && name.compact.startsWith(query.compact))) return [2, 0];
  if (name.phrase.includes(query.phrase) || (compactMatch && name.compact.includes(query.compact))) return [3, 0];

  const nameRanks = query.words.map((word) => wordRank(name.words, word));
  if (nameRanks.every(Number.isFinite)) return [4, nameRanks.reduce((sum, rank) => sum + rank, 0)];
  if (name.words.length > 1 && name.initials === query.compact) return [5, 0];

  let nameMatches = 0;
  let typos = 0;
  let score = 0;
  for (const [index, word] of query.words.entries()) {
    const nameRank = nameRanks[index];
    if (Number.isFinite(nameRank)) {
      nameMatches++;
      score += nameRank;
      continue;
    }
    if (name.words.length > 1 && name.initials === word) {
      nameMatches++;
      score += 3;
      continue;
    }
    const parentRank = Math.min(...parents.map((parent) => wordRank(parent.words, word)));
    if (Number.isFinite(parentRank)) {
      score += 3 + parentRank;
      continue;
    }
    const letters = query.wordChars[index];
    if (letters.length < 4 || !name.wordChars.some((candidate) => withinOneEdit(letters, candidate))) return null;
    nameMatches++;
    typos++;
  }
  if (!nameMatches) return null;
  if (!typos) return [6, score];
  const wholeNameTypo = typos === 1 && withinOneEdit(query.compactChars, name.compactChars);
  return [7, typos * 5 + score + (wholeNameTypo ? 0 : 1)];
}

export function rankShortcutMatches<T extends { id: string }>(index: IndexedShortcut<T>[], value: string, recentIds: string[]): T[] {
  const query = searchText(value);
  if (!query.literal) return [];
  const recent = new Map(recentIds.map((id, position) => [id, position]));
  const matches = index.flatMap(({ item, name, parents }) => {
    const rank = matchRank(name, parents, query);
    return rank ? [{ item, rank, recent: recent.get(item.id) ?? recent.size }] : [];
  });
  matches.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.recent - b.recent);
  return matches.map(({ item }) => item);
}
