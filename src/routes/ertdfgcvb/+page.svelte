<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Port of the screensaver on https://ertdfgcvb.xyz/?mode=screensaver
	// (Andreas Gysin). A 3-letter word is rasterized to a small bitmap;
	// per-frame we sample that bitmap through Perlin-warped UVs and pick
	// a ramp char from K or S on a checkerboard, producing flowing blobs
	// of ASCII with the current word peeking through the dense areas.

	const WORDS = [
		'abs','ace','act','add','age','ago','aim','air','all','ant','any','ape','arc','ark','arm','art',
		'ash','ask','ate','awe','axe','bad','bag','bar','bat','bay','bed','bee','beg','bet','big','bin',
		'bit','bob','boo','bow','box','boy','bud','bug','bus','but','buy','bye','cab','cam','can','cap',
		'car','cat','cob','cop','cow','cry','cub','cue','cup','cut','dad','day','dim','dip','dog','dot',
		'dry','due','dug','duo','dye','ear','eat','egg','ego','elf','elm','end','era','eve','eye','fad',
		'fan','far','fat','fax','fee','few','fig','fin','fit','fix','fly','fog','fox','fry','fun','fur',
		'gap','gas','gel','gem','get','gin','got','gum','gun','gut','guy','gym','had','ham','has','hat',
		'hay','hen','her','hey','him','hip','his','hit','hop','hot','how','hub','hue','hug','hum','hut',
		'ice','ink','inn','ion','ivy','jam','jar','jaw','jet','job','jog','joy','jug','key','kid','kin',
		'kit','lad','law','lay','led','leg','let','lid','lie','lip','log','lot','low','mad','man','map',
		'mat','may','men','met','mix','mob','mom','mop','mud','mug','nap','net','new','nil','nod','not',
		'now','nut','oak','odd','off','oil','old','one','opt','orb','our','out','owe','owl','own','pad',
		'pal','pan','pat','paw','pay','pea','pen','pet','pie','pig','pin','pit','pod','pop','pot','pub',
		'pup','put','rad','rag','ram','rap','rat','raw','ray','red','rib','rid','rig','rim','rip','rob',
		'rod','row','rub','rug','rum','run','rye','sad','sat','saw','say','sea','see','set','sew','shy',
		'sin','sip','sir','sit','ski','sky','sly','son','soy','spa','spy','sub','sum','sun','tab','tag',
		'tan','tap','tar','tax','tea','tee','ten','the','tie','tin','tip','toe','too','top','toy','try',
		'tub','tug','two','use','van','vet','via','vow','war','wax','way','web','wee','wet','who','why',
		'wig','win','wit','won','woo','wow','yen','yes','yet','you','zip','zoo'
	];

	const K = ' .·•-+=:;=*ABC0123!*';
	const S_RAMP = ' ·-•~+:*abcXYZ*';

	// Value noise (Perlin-ish) — seeded for determinism across runs.
	const PERM = new Uint8Array(512);
	(() => {
		const p = new Uint8Array(256);
		for (let i = 0; i < 256; i++) p[i] = i;
		let seed = 1337;
		for (let i = 255; i > 0; i--) {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			const j = seed % (i + 1);
			const t = p[i];
			p[i] = p[j];
			p[j] = t;
		}
		for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
	})();
	const G = new Float32Array(256);
	for (let i = 0; i < 256; i++) G[i] = PERM[i] / 255;
	const smooth = (t: number) => t * t * (3 - 2 * t);
	function noise(x: number, y: number): number {
		const xi = Math.floor(x);
		const yi = Math.floor(y);
		const xf = x - xi;
		const yf = y - yi;
		const u = smooth(xf);
		const v = smooth(yf);
		const X0 = xi & 255;
		const Y0 = yi & 255;
		const X1 = (xi + 1) & 255;
		const Y1 = (yi + 1) & 255;
		const a = G[PERM[PERM[X0] + Y0] & 255];
		const b = G[PERM[PERM[X1] + Y0] & 255];
		const c2 = G[PERM[PERM[X0] + Y1] & 255];
		const d = G[PERM[PERM[X1] + Y1] & 255];
		const ab = a + (b - a) * u;
		const cd = c2 + (d - c2) * u;
		return ab + (cd - ab) * v;
	}

	// Word bitmap: rasterize the current 3-letter word to a small grayscale
	// texture. Warped UVs sample this every frame.
	let texData: Uint8Array | null = null;
	let texW = 0;
	let texH = 0;
	let lastWordT = -1000;

	function rasterize(word: string) {
		if (typeof OffscreenCanvas === 'undefined') return;
		const W = 96;
		const H = 24;
		const canvas = new OffscreenCanvas(W, H);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, W, H);
		ctx.fillStyle = '#fff';
		ctx.font = 'bold 20px ui-monospace, "SFMono-Regular", Menlo, monospace';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.fillText(word.toUpperCase(), W / 2, H / 2 + 1);
		const img = ctx.getImageData(0, 0, W, H);
		const data = new Uint8Array(W * H);
		for (let i = 0; i < W * H; i++) data[i] = img.data[i * 4];
		texData = data;
		texW = W;
		texH = H;
	}

	function effect(c: AsciiApi) {
		const t = c.elapsed;
		if (!texData || t - lastWordT > 3) {
			rasterize(WORDS[Math.floor(Math.random() * WORDS.length)]);
			lastWordT = t;
		}
		if (!texData) return;

		const cols = c.cols;
		const rows = c.rows;
		const aspect = c.cellAspect;
		const s = t * 0.35;
		const u = 1.6;
		const scale = Math.min(cols, rows) * 0.22;

		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const nx = (x - cols / 2) / scale;
				const ny = ((y - rows / 2) / scale) * aspect;
				const wx = nx + 0.9 * (noise(nx * u + s, ny * u) - 0.5);
				const wy = ny + 1.6 * (noise(nx * u, ny * u + s) - 0.5);
				const tx = Math.floor((wx * 0.5 + 0.5) * texW);
				const ty = Math.floor((wy * 0.5 + 0.5) * texH);
				let v = 0;
				if (tx >= 0 && tx < texW && ty >= 0 && ty < texH) {
					v = texData[ty * texW + tx] / 255;
				}
				const ramp = (x + y) & 1 ? K : S_RAMP;
				let idx = Math.floor(v * ramp.length);
				if (idx >= ramp.length) idx = ramp.length - 1;
				c.set(x, y, ramp[idx]);
			}
		}
	}
</script>

<AsciiCanvas {effect} />
