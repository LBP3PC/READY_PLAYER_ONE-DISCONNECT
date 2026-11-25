import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleGameSignup, handleGameUsernameAvailability } from '../game-bridge.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { SUPABASE_URL: 'https://site.example', SUPABASE_PUBLISHABLE_KEY: 'public', GAME_ACCOUNTS_HOST: 'https://accounts.example', GAME_AUTH_HOST: 'https://auth.example', SITE_BRIDGE_TOKEN: 'test-bridge' };
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = (pseudo = 'player123', password = 'correct-password') => new Request('https://site.example/api/game/signup', {
  method: 'POST', headers: { Authorization: 'Bearer site-session', 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo, password })
});
const siteUser = { id: 'user-1', email: 'player123@players.recblue.invalid' };

function mock(options = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/auth/v1/user') return response(200, siteUser);
    if (path === '/auth/v1/token') return options.badPassword ? response(400, {}) : response(200, { user: siteUser });
    if (path.startsWith('/account/username/')) return options.exists ? response(200, {}) : response(404, {});
    if (path === '/connect/token') {
      const data = new URLSearchParams(init.body);
      if (data.get('grant_type') === 'password') return options.existingMatches ? response(200, { access_token: 'game-session' }) : response(400, {});
      return response(200, { access_token: 'game-session', account_id: 42 });
    }
    if (path === '/account/me/username') return response(200, options.renameFailed ? { success: false, error: 'nom déjà pris' } : { success: true, error: '' });
    if (path === '/internal/site/link') return response(200, { ok: true });
    throw new Error('unexpected request: ' + path);
  };
  return calls;
}

test('inscription avec même pseudo et mot de passe', async () => {
  mock(); const result = await handleGameSignup(request(), env); const data = await result.json();
  assert.equal(result.status, 200); assert.equal(data.renamed, true); assert.equal(data.linked, true); assert.equal(data.username, 'player123');
});
test('mot de passe erroné ou pseudo différent ne crée pas de compte', async () => {
  let calls = mock({ badPassword: true }); assert.equal((await handleGameSignup(request(), env)).status, 401); assert.ok(!calls.includes('/connect/token'));
  calls = mock(); assert.equal((await handleGameSignup(request('someoneelse'), env)).status, 403); assert.ok(!calls.includes('/connect/token'));
});
test('pseudo existant réutilisé uniquement avec le bon mot de passe', async () => {
  mock({ exists: true, existingMatches: true }); let result = await handleGameSignup(request(), env); assert.equal((await result.json()).existing, true);
  mock({ exists: true }); result = await handleGameSignup(request(), env); assert.equal(result.status, 409);
});
test('refus du renommage reconnu malgré HTTP 200', async () => {
  mock({ renameFailed: true }); const result = await handleGameSignup(request(), env); assert.equal((await result.json()).renamed, false);
});
test('disponibilité du pseudo', async () => {
  mock(); let result = await handleGameUsernameAvailability(new Request('https://site.example/api/game/username-availability?pseudo=player123'), env); assert.equal((await result.json()).available, true);
  mock({ exists: true }); result = await handleGameUsernameAvailability(new Request('https://site.example/api/game/username-availability?pseudo=player123'), env); assert.equal((await result.json()).available, false);
  result = await handleGameUsernameAvailability(new Request('https://site.example/api/game/username-availability?pseudo=under_score'), env); assert.equal(result.status, 400);
});
