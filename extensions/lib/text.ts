const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "you", "your",
  "its", "not", "but", "has", "had", "have", "out", "all", "any", "can", "will", "just", "than",
  "then", "when", "what", "why", "how", "does", "did", "get", "got", "our", "their", "them", "they",
  "there", "here", "been", "being", "some", "only", "also", "more", "most", "one", "two", "use",
  "used", "using", "where", "which", "who", "should", "would", "could", "about", "after", "before",
]);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

export function jaccard(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function overlaps(a: string, b: string): boolean {
  const left = tokens(a);
  const right = tokens(b);
  for (const word of left) if (right.has(word)) return true;
  return false;
}
