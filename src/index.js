import { Router } from 'itty-router';
import md5 from 'js-md5';

// =================================================================
// BAGIAN 1: DEFINISI DURABLE OBJECT UNTUK SSE
// =================================================================

export class DepositStatusNotifier {
  constructor(state, env) {
    this.state = state;
    this.sessions = []; // Menyimpan koneksi client yang aktif
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Endpoint untuk client terhubung via SSE
    if (url.pathname.endsWith('/connect')) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const session = { writer };
      this.sessions.push(session);

      const keepAliveInterval = setInterval(() => {
        try {
          writer.write(': keep-alive\n\n');
        } catch (e) {
          clearInterval(keepAliveInterval);
        }
      }, 20000);

      readable.cancel(() => {
        clearInterval(keepAliveInterval);
        const index = this.sessions.indexOf(session);
        if (index !== -1) {
          this.sessions.splice(index, 1);
        }
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': this.env.CORS_ORIGIN || '*',
        },
      });
    }

    // Endpoint yang dipanggil oleh webhook untuk menyiarkan status
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      const data = await request.json();
      this.broadcast(data);
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found in Durable Object', { status: 404 });
  }

  // Mengirim data ke semua client yang terhubung
  broadcast(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    this.sessions = this.sessions.filter(session => {
      try {
        session.writer.write(message);
        return true;
      } catch (err) {
        return false;
      }
    });

    if (data.status === 'Success' || data.status === 'Error') {
       this.sessions.forEach(session => session.writer.close());
       this.sessions = [];
    }
  }
}


// =================================================================
// BAGIAN 2: DEFINISI ROUTER DAN LOGIKA WORKER UTAMA
// =================================================================

const router = Router();

const jsonResponse = (data, options = {}) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': options.corsOrigin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-ATL-Signature',
  };

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    status: options.status || 200,
  });
};

// --- KODE YANG DIPERBAIKI ---
// Middleware ini sekarang HANYA menangani request dengan method OPTIONS.
router.options('*', (request, env) => {
  return jsonResponse({}, { corsOrigin: env.CORS_ORIGIN });
});

router.get('/api/events/:depositId/connect', (request, env) => {
  const { depositId } = request.params;
  if (!depositId) {
    return jsonResponse({ message: 'Parameter depositId wajib diisi.' }, { status: 400, corsOrigin: env.CORS_ORIGIN });
  }
  const id = env.DEPOSIT_STATUS.idFromName(depositId.toString());
  const stub = env.DEPOSIT_STATUS.get(id);
  return stub.fetch(request);
});

router.post('/api/deposit/create', async (request, env) => {
  try {
    const { reff_id, nominal, type, metode } = await request.json();
    if (!reff_id || !nominal || !type || !metode) {
      return jsonResponse({ message: 'Parameter reff_id, nominal, type, dan metode wajib diisi.' }, { status: 400, corsOrigin: env.CORS_ORIGIN });
    }
    const params = new URLSearchParams({ api_key: env.ATLANTIC_API_KEY, reff_id, nominal, type, metode });
    const response = await fetch(`${env.BASE_URL}/deposit/create`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    const data = await response.json();
    return jsonResponse(data, { status: data.code || 200, corsOrigin: env.CORS_ORIGIN });
  } catch (error) {
    return jsonResponse({ message: 'Terjadi kesalahan pada server', error: error.message }, { status: 500, corsOrigin: env.CORS_ORIGIN });
  }
});

router.post('/api/deposit/status', async (request, env) => {
    try {
        const { id } = await request.json();
        if (!id) {
            return jsonResponse({ message: 'Parameter id wajib diisi.' }, { status: 400, corsOrigin: env.CORS_ORIGIN });
        }
        const params = new URLSearchParams({ api_key: env.ATLANTIC_API_KEY, id });
        const response = await fetch(`${env.BASE_URL}/deposit/status`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
        const data = await response.json();
        return jsonResponse(data, { status: data.code || 200, corsOrigin: env.CORS_ORIGIN });
    } catch (error) {
        return jsonResponse({ message: 'Terjadi kesalahan pada server', error: error.message }, { status: 500, corsOrigin: env.CORS_ORIGIN });
    }
});

router.post('/webhook', async (request, env) => {
  const signature = request.headers.get('X-ATL-Signature');
  const expectedSignature = md5(env.ATLANTIC_USERNAME);

  if (signature !== expectedSignature) {
    return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
  }

  const { event, data } = await request.json();
  if (event === 'deposit' && data && data.id) {
    const depositId = data.id.toString();
    const id = env.DEPOSIT_STATUS.idFromName(depositId);
    const stub = env.DEPOSIT_STATUS.get(id);
    // Kirim data ke Durable Object untuk di-broadcast
    await stub.fetch(`https://do.dummy/${depositId}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  return jsonResponse({ message: 'Webhook received successfully' });
});

// Fallback untuk route yang tidak ditemukan
router.all('*', () => new Response('404, Not Found!', { status: 404 }));


// =================================================================
// BAGIAN 3: EKSPOR UTAMA WORKER
// =================================================================

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  },
  DEPOSIT_STATUS: DepositStatusNotifier,
};
