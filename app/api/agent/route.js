import { runAgent } from '@/lib/agent/agent.js';

export async function POST(req) {
  try {
    const { message } = await req.json();
    if (!message) return Response.json({ error: '缺少 message' }, { status: 400 });
    const t0 = Date.now();
    const out = await runAgent(message);
    return Response.json({ ok: true, elapsedMs: Date.now() - t0, ...out });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
