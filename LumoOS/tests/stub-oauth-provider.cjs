// stub-oauth-provider.cjs — minimal OAuth 2.0 authorization server for the
// connection-lifecycle tests. Implements the authorization-code grant with
// PKCE (S256), one-time codes, client_id / redirect_uri validation, and
// records the last token request for assertions.
'use strict';

const http = require('http');
const crypto = require('crypto');

function createStubOauthProvider() {
    const codes = new Map(); // code -> { challenge, redirectUri, clientId, used }
    const state = { lastTokenBody: null, issuedCodes: 0, deniedCount: 0 };

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://stub-oauth');
        if (req.method === 'GET' && u.pathname === '/authorize') {
            const code = 'code-' + crypto.randomBytes(8).toString('hex');
            state.issuedCodes += 1;
            codes.set(code, {
                challenge: u.searchParams.get('code_challenge'),
                redirectUri: u.searchParams.get('redirect_uri'),
                clientId: u.searchParams.get('client_id'),
                used: false,
            });
            const loc = new URL(u.searchParams.get('redirect_uri'));
            loc.searchParams.set('code', code);
            loc.searchParams.set('state', u.searchParams.get('state'));
            res.writeHead(302, { Location: loc.toString() });
            res.end();
            return;
        }
        if (req.method === 'POST' && u.pathname === '/token') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
                state.lastTokenBody = Object.fromEntries(form);
                const fail = (error) => {
                    state.deniedCount += 1;
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error }));
                };
                const rec = codes.get(form.get('code'));
                if (!rec || rec.used) return fail('invalid_grant');
                if (form.get('client_id') !== rec.clientId) return fail('invalid_client');
                if (form.get('redirect_uri') !== rec.redirectUri) return fail('invalid_grant');
                if (rec.challenge) {
                    const expected = crypto.createHash('sha256')
                        .update(form.get('code_verifier') || '').digest('base64url');
                    if (expected !== rec.challenge) return fail('invalid_grant');
                }
                rec.used = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    access_token: 'stub-at-' + crypto.randomBytes(12).toString('hex'),
                    refresh_token: 'stub-rt-' + crypto.randomBytes(6).toString('hex'),
                    token_type: 'Bearer',
                    expires_in: 3600,
                }));
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    return {
        server,
        state,
        listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
        // fetch() keep-alive sockets would stall server.close() — drop them
        close: () => new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => r());
        }),
        port: () => server.address().port,
    };
}

module.exports = { createStubOauthProvider };
