export function appendJsonlChunk(
  buffer: string,
  chunk: string
): { lines: string[]; buffer: string } {
  const parts = `${buffer}${chunk}`.split('\n');
  return {
    lines: parts.slice(0, -1).filter((line) => line.trim()),
    buffer: parts[parts.length - 1] ?? '',
  };
}

export function flushJsonlBuffer(buffer: string): string[] {
  return buffer.trim() ? [buffer] : [];
}
