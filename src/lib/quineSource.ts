// Strip /* ... */ block comments, // line comments, and <!-- ... --> HTML
// comments from a Svelte/TS/JS source string. String literals (single,
// double, backtick) are preserved with backslash-escape handling — so a
// `//` inside a string isn't accidentally treated as a comment.
//
// Trailing blank lines from removed comment blocks are collapsed to single
// blanks so the layout doesn't end up half-empty after stripping a long
// header comment.
export function stripComments(src: string): string {
	let out = '';
	let i = 0;
	const n = src.length;
	while (i < n) {
		const ch = src[i];
		const next = i + 1 < n ? src[i + 1] : '';
		if (ch === '/' && next === '/') {
			while (i < n && src[i] !== '\n') i++;
		} else if (ch === '/' && next === '*') {
			i += 2;
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i += 2;
		} else if (ch === '<' && src.substr(i, 4) === '<!--') {
			i += 4;
			while (i < n && src.substr(i, 3) !== '-->') i++;
			i += 3;
		} else if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch;
			out += ch;
			i++;
			while (i < n && src[i] !== quote) {
				if (src[i] === '\\' && i + 1 < n) {
					out += src[i] + src[i + 1];
					i += 2;
				} else {
					out += src[i];
					i++;
				}
			}
			if (i < n) {
				out += src[i];
				i++;
			}
		} else {
			out += ch;
			i++;
		}
	}

	const lines = out.split('\n').map((l) => l.replace(/\s+$/, ''));
	const compact: string[] = [];
	for (const line of lines) {
		if (line === '' && compact.length > 0 && compact[compact.length - 1] === '') continue;
		compact.push(line);
	}
	return compact.join('\n');
}
