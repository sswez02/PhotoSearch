import http from 'k6/http';
import { check, group, sleep } from 'k6';

export const options = {
  vus: __ENV.VUS ? Number(__ENV.VUS) : 20,
  duration: __ENV.DURATION ?? '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Overall request latency
    http_req_duration: ['p(95)<1000'],
    // Endpoint-specific p95s (tags are set below)
    'http_req_duration{endpoint:post_photos}': ['p(95)<600'],
    'http_req_duration{endpoint:get_photos_q}': ['p(95)<600'],
  },
};

const BASE_URL = (__ENV.BASE_URL ?? '').replace(/\/$/, '');
if (!BASE_URL) {
  throw new Error('Set BASE_URL, e.g. k6 run -e BASE_URL=https://... loadtest/k6_api_latency.js');
}

function randHex(nBytes) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < nBytes * 2; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function postJson(url, body, tags) {
  return http.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    tags,
  });
}

export default function () {
  const filename = `k6_${randHex(6)}.jpg`;
  let id = null;

  group('POST /photos', () => {
    const r = postJson(
      `${BASE_URL}/photos`,
      { originalFilename: filename, contentType: 'image/jpeg' },
      { endpoint: 'post_photos' },
    );

    check(r, {
      'create status is 201': (x) => x.status === 201,
    });

    if (r.status === 201) {
      const json = r.json();
      id = json?.id ?? null;
    }
  });

  // Query for a substring that should match at least the row we just created
  group('GET /photos?q=', () => {
    const q = filename.slice(0, 6);
    const r = http.get(`${BASE_URL}/photos?q=${encodeURIComponent(q)}&limit=20`, {
      tags: { endpoint: 'get_photos_q' },
    });

    check(r, {
      'search status is 200': (x) => x.status === 200,
      'search returns items': (x) => Array.isArray(x.json('items')),
    });
  });

  sleep(0.1);
}
