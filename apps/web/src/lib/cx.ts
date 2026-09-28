/** Join class names, skipping falsy values: `cx('a', cond && 'b')`. */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  let out = '';
  for (const p of parts) {
    if (p) out = out ? `${out} ${p}` : p;
  }
  return out;
}
