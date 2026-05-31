/**
 * Discord 等の文字数上限に合わせてテキストを分割するユーティリティ。
 *
 * separator (既定 '\n') 単位で結合しながら maxLength 以内のチャンクに分ける。
 * 1 ブロックが maxLength を超える場合は行単位 → さらに改行の無い超長行は
 * 文字数単位で強制スライスする。これにより「改行の無い長い 1 行」(長い URL /
 * 連結された長文 / 改行なしコード等) でも全チャンクが必ず maxLength 以内になる。
 *
 * この最後の文字数フォールバックが無いと、超長行が maxLength を超えたまま
 * Discord に送られ DiscordAPIError[50035] (content BASE_TYPE_MAX_LENGTH) で
 * 送信に失敗し、メッセージが更新されず「無反応」に見える事象が起きる。
 */
export function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (line.length > maxLength) {
            // 改行の無い超長行は maxLength 単位で文字数強制スライスする
            if (current) {
              chunks.push(current.trim());
              current = '';
            }
            for (let i = 0; i < line.length; i += maxLength) {
              const piece = line.slice(i, i + maxLength);
              if (i + maxLength < line.length) {
                chunks.push(piece);
              } else {
                // 末尾の半端は current に残し、後続ブロックと結合可能にする
                current = piece;
              }
            }
          } else if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}
