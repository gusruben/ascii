// Downsampled luma map of microsoft.ai's `orange-gradient.png` (the static
// painterly bokeh texture used in the OUTPUT pass). Captured from
// /wp-content/themes/wp-base-theme/dist/assets/textures/orange-gradient.png
// (1728×1038 RGBA), reduced to 64×32 and converted to grayscale via
// ImageMagick (`magick … -resize 64x32! -colorspace gray`). 2048 bytes
// total, encoded as base64 to keep the source file readable.
//
// The texture is the source of the visible "painterly collection of
// ovals" the eye locks onto on the live page — the vignette + sine +
// shatter + bokeh chain only modulates this baked-in pattern at ~26%.
// See OUTPUT shader at block-gl-element.js:155.

const TEXTURE_W = 64;
const TEXTURE_H = 32;
const B64 =
	'nZ6foaKkpqmrra+xsrKys7OztLS0tbW1tra2t7e3uLi4uLm6vL7Aw8XHysvNz9DR0tDOy8nHx8fGw7+7t7Kvq5qbnJ6goqSmqauusLGysrKzs7O0tLS1tbW2tra3t7e4uLi3uLq8vsDCxcfKzM3Pz87MycbFxcfHxsK+urWxraqWl5ianJ+ipKeprK6wsbKysrOzs7S0tLW1tba2tre3t7e2tbW2uLq8vsDDxsnKy8vKx8XEw8XGx8XBvbi0sK2qkpOVl5qdn6KlqKutr7GxsrKys7OztLS0tbW1tra2tra1tLOys7S1t7m7vsHDxsfGxcXExMTExMTCv7u3s7Ctqo+QkpWYm56ho6apq66vsLGxsrKzs7O0tLS1tbW2tra1s7Kwr6+wsbKztbi6vb/AwcLDxcXEw8HAv726t7OwrqyMjZCTlpmcn6Kkp6msrq+vsLGxsrOztLS0tLW1tra1tLKwrqysrKytrq+xtLa4u73AwsTEw8G/vby7uba0sq+tioyPkpWYm56ho6Woqqutra6vsLGysrOztLS1tbW1tLOwrqyqqaioqKmqq62ws7a6vcDCwsHAvbu5uLi3trSxr4yNkJOVmJueoKKkpqipqqusra6vsLGys7S0tLW1tbSysK2qqKalpaWlpaaoq6+zt7q9v7+/vr27ubi4t7e1tLKPkJKUlpmbnZ+ho6WmqKipqqqrra6vsbKztLS0tbS0sq+tqqekoqKhoaGipKerr7O2ury+vr6+vbu5uLe3t7a0kpOUlpianJ2foaKkpaamp6eoqaqsra+wsrO0tLS0s7KvraqnpKGgn5+foKKkp6uwtLi7vb+/v7+9u7m4uLi4t5aWl5iam52en6Cio6SkpKWlpqeoqqusrrCxs7S0tLOysK6sqaWhn52dnZ6goqWorbK2ur2/wMDAv768urm5ubmZmZqbnJ2en6CgoaKioqOjo6SlpqepqqyusLGztLS0s7Gwrauno6CdnJyeoKKkpqqvtLm9v8HBwcHAvry7urq7nJydnZ6en5+goaGhoaGhoaGio6Slp6mqrK6wsrO0tLSzsa+tqqein52cnqCjpaaorLK4vMDBwsLCwcC/vby8vJ+fn6CgoKCgoaGhoKCfn5+foKGio6WnqKqsrrCytLW2tbSyr62qpqKfnp+hpKeoqauvtbvAwsPDwsLCwcC+vb2hoaKioqKioqGhoKCfnp2dnZ6foKKjpaepq62vsbS1t7e2tLKwrqqmo6CgoaWoq6usrrO5v8LDxMPDw8PCwL++o6Ojo6Ojo6OioaCfnp2cm5ucnZ6goqOlp6mrrbCztre4uLe1s7GvrKikoqKkqKyvr6+xt73CxMTExMTEw8LBwKOkpKSkpKOjoqGgnp2cm5qampudnqCipKaoqq2vs7W3ubm5uLe1tLGuqqakpKitsbOzs7a7wMTFxcXFxMTEw8Kio6OkpKOjo6Khn56cm5qZmZmanJ2foaOlp6msr7K0t7m6u7u6ubi2tLCsqKanq7G2uLi3ur7CxcbGxsXFxcTEoaGioqOioqKhoJ+enJuamZmZmpudnqCipKaoq66xs7a4uru8vb28u7m3tK+qqKqvtru9vLu9wMTGx8bGxsXFxZ6foKChoaGhoaCfnpybmpqZmZqbnZ6goqSmqKutsLO1t7m6vL2/v7++vbu3sq2rrrS7wMG/vr/CxcfHx8fGxsWbnJ2en5+goKCgn56dnJuampqbnJ2eoKKjpaiqrbCytLa4ubu9v8DCwsLBv7u2sa+yub/Dw8HAwcTHyMjHx8fGmJmanJ2enp+fn5+fnZybmpqam5ydn6Cio6Woq62vsrS1t7i6vL7AwsTFxcXDv7m0s7a8wsXFw8LExsjJyMjHx5WWl5mam52enp+fn56dnJubm5ucnp+hoqSmqKutr7Kztba3uLq9v8LExsfIx8XBu7e2ub/Ex8fFxcbIycnJyMiSk5SWmJmbnJ2en5+fnp2cm5ubnJ6goaOkpqmrrrCytLW1tre5u77BxMbHyMnJx8O9ubm8wcbJycfHyMnKysnIj5CRk5WXmZucnZ6foJ+enZybm5ydn6GjpaeprK6xs7S1tbW2uLq9wMPFx8nKy8rIxL+8vL/EycvLycnKysrKyYuMjpCSlJeZm5yen6CgoJ+dnJycnJ6go6Wnqq2vsrS1tra2tre5vL/CxcfJy8zMzMrGwr+/wsfLzMzLy8vLy8qHiYuNj5KUl5mbnZ+goaGgn56cnJydn6Gkp6uusLO1tre3tra3uby+wcTHysvMzc7OzMjEwsLFyc3Ozc3MzMvLhIWIio2QkpWYmp2foKGioqGfnpycnJ2goqaqrrG0tre4uLi3uLm7vsHEx8rMzc7Pz8/Oy8fFxcjMzs/Ozs3My4CChYiLjpGUl5mcnqCio6SjoqCenJycnqCkqa6xtbe4ubm5ubm6u77BxMfKzM3Oz9DR0dDNysjJy87Pz87Ozcx9gIOGiY2Qk5aYm56goqSlpaSioJ6cm5yeoaarsLS3ubq6u7q6ury+wcTHyszOz9DR0tPT0s/Ny8zOz9DPzs7Ne36ChYmMj5KVmJqdn6KkpaenpaOgnZybnJ+jqK2ytri6u7y8vLy8vcDDx8rMzs/Q0tPU1NTT0tDPz9DQ0M/OzXt+goWJjI+SlZianZ+hpKanqKelop+dm5ucn6Spr7S3uru9vr6+vb7Aw8fKzM7P0dLT1NXW1tXT0tHR0dHQz84=';

function decode(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// Flip rows on load so v=0 corresponds to the visual TOP of the source
// image — matching OGL's default `flipY=true` texture upload (which is
// what the microsoft.ai pipeline uses). Without this the diagonal axis
// of brightness comes out as TL→BR; with it, it's BL→TR like the page.
function flipRows(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let y = 0; y < h; y++) {
		const srcRow = y * w;
		const dstRow = (h - 1 - y) * w;
		for (let x = 0; x < w; x++) out[dstRow + x] = src[srcRow + x];
	}
	return out;
}

export const TEXTURE_LUMA = flipRows(decode(B64), TEXTURE_W, TEXTURE_H);
export const TEX_W = TEXTURE_W;
export const TEX_H = TEXTURE_H;
