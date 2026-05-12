/**
 * Fleet Maintenance Blueprint Submission Worker
 *
 * Paste this into the Cloudflare Workers dashboard editor and click Deploy.
 *
 * Required environment variables (Settings → Variables → Add):
 *   GITHUB_TOKEN  — Personal Access Token with Issues: Read & Write scope
 *   GITHUB_OWNER  — Your GitHub username  (e.g. "officialxndr")
 *   GITHUB_REPO   — Blueprints repo name  (e.g. "fleet-maintenance-blueprints")
 *
 * Required KV binding (KV → Create namespace "RATE_LIMIT" → bind as variable RATE_LIMIT):
 *   Rate limit: 3 submissions per IP per 24 hours.
 */

var CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

var SAFE_SPEC_KEYS = ['engine_oil', 'oil_filter', 'tire_size', 'tire_pressure', 'wiper_blades', 'manual_url'];

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' })
    });
}

addEventListener('fetch', function(event) {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Rate limiting
    var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    var rlKey = 'rl:' + ip;
    var rlRaw = await RATE_LIMIT.get(rlKey);
    var rlCount = rlRaw ? parseInt(rlRaw, 10) : 0;
    if (rlCount >= 3) {
        return jsonResponse({ error: 'Rate limit reached. You can submit up to 3 blueprints per day.' }, 429);
    }

    // Parse body
    var bp;
    try {
        bp = await request.json();
    } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body.' }, 400);
    }

    // Validate
    if (bp.blueprint_version !== 1 || !bp.make || !bp.model) {
        return jsonResponse({ error: 'Invalid blueprint format.' }, 400);
    }

    // Scrub personal data
    var safe = {
        blueprint_version: 1,
        year:  String(bp.year  || '').trim(),
        make:  String(bp.make  || '').trim(),
        model: String(bp.model || '').trim(),
        services: (bp.services || []).map(function(s) {
            return {
                category:        String(s.category        || 'Other').trim(),
                name:            String(s.name            || '').trim(),
                interval_months: Number(s.interval_months || 0),
                interval_miles:  Number(s.interval_miles  || 0),
                parts_info:      String(s.parts_info      || '').trim(),
                garage_parts:    (s.garage_parts  || []).map(function(p) { return { name: String(p.name || ''), value: String(p.value || '') }; }),
                garage_torque:   (s.garage_torque || []).map(function(t) { return { name: String(t.name || ''), value: String(t.value || '') }; })
            };
        }),
        torque_specs: (bp.torque_specs || []).map(function(t) {
            return {
                component: String(t.component || '').trim(),
                torque:    String(t.torque    || '').trim(),
                labels:    String(t.labels    || '').trim()
            };
        }),
        specs: (function() {
            var out = {};
            SAFE_SPEC_KEYS.forEach(function(k) {
                out[k] = String((bp.specs || {})[k] || '').trim();
            });
            return out;
        })()
    };

    var label = [safe.year, safe.make, safe.model].filter(Boolean).join(' ');
    var bodyLines = [
        '## Blueprint Submission',
        '',
        '**Vehicle:** ' + label,
        '**Services:** ' + safe.services.length
    ];
    if (safe.specs.engine_oil) bodyLines.push('**Engine Oil:** ' + safe.specs.engine_oil);
    if (safe.specs.tire_size)  bodyLines.push('**Tire Size:** '  + safe.specs.tire_size);
    bodyLines.push('', '<details>');
    bodyLines.push('<summary>Full Blueprint JSON (copy into blueprints/{id}.json when approving)</summary>');
    bodyLines.push('', '```json', JSON.stringify(safe, null, 2), '```', '</details>');
    var issueBody = bodyLines.join('\n');

    // Create GitHub issue
    var ghRes = await fetch(
        'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/issues',
        {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GITHUB_TOKEN,
                'Content-Type':  'application/json',
                'User-Agent':    'fleet-maintenance-blueprint-bot/1.0'
            },
            body: JSON.stringify({
                title:  '[Blueprint] ' + label,
                body:   issueBody,
                labels: ['blueprint-submission']
            })
        }
    );

    if (!ghRes.ok) {
        return jsonResponse({ error: 'Failed to create submission. Please try again later.' }, 502);
    }

    var issue = await ghRes.json();

    // Increment rate limit counter (expires after 24h)
    await RATE_LIMIT.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

    return jsonResponse({ status: 'submitted', issue_url: issue.html_url });
}
