import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';

const LOG_PATH = '/tmp/mandelbrot-touch.log';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();
	const line = `[${new Date().toISOString()}] ${body}\n`;
	fs.appendFileSync(LOG_PATH, line);
	return new Response('ok');
};

export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.get('clear') === '1') {
		try {
			fs.unlinkSync(LOG_PATH);
		} catch {}
		return new Response('cleared');
	}
	let body = '';
	try {
		body = fs.readFileSync(LOG_PATH, 'utf8');
	} catch {
		body = '(empty)';
	}
	return new Response(body, { headers: { 'content-type': 'text/plain' } });
};
