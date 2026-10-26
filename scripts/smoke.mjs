#!/usr/bin/env node
/**
 * End-to-end check: spawns the real MCP server over stdio, calls the real
 * `meatsack` tool, and plays the human through the real HTTP backend.
 *
 *   npm run build && npm run smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let passed = 0;
const failures = [];

function check(label, condition, extra) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${extra ? `\n      got: ${JSON.stringify(extra)}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('backend never came up');
}

/** Poll until a pending request shows up, like a human staring at the screen. */
async function waitForPending(matcher = () => true) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${BASE}/api/requests`);
      const { requests } = await res.json();
      const found = requests.find((r) => r.status === 'pending' && matcher(r));
      if (found) return found;
    } catch {
      /* the hub may be changing hands */
    }
    await sleep(50);
  }
  throw new Error('no pending request appeared');
}

function listRequests() {
  return fetch(`${BASE}/api/requests`).then((r) => r.json());
}

function postAsk(body) {
  return fetch(`${BASE}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal hand-rolled HTTP/1.1 GET, so we can forge the Host header. */
function rawRequest(host, pathname, port = PORT, ip = '127.0.0.1', extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, ip, () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\n${extraHeaders}Connection: close\r\n\r\n`,
      );
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function respond(id, body) {
  return fetch(`${BASE}/api/requests/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'index.js')],
  env: { ...process.env, MEATSACK_PORT: String(PORT), MEATSACK_OPEN: '0' },
  stderr: 'pipe',
  cwd: ROOT,
});

const client = new Client({ name: 'meatsack-smoke', version: '0.1.0' });
await client.connect(transport);
transport.stderr?.on('data', (chunk) => process.stderr.write(`    │ ${chunk}`));
await waitForHealth();

console.log('\nmeatsack smoke test\n');

// ---------------------------------------------------------------- tools
console.log('tool listing');
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === 'meatsack');
check('exposes one tool called meatsack', tools.length === 1 && Boolean(tool), tools.map((t) => t.name));
check(
  'action enum is do / answer / physical',
  JSON.stringify(tool?.inputSchema?.properties?.action?.enum) === '["do","answer","physical"]',
  tool?.inputSchema?.properties?.action,
);
check('declares an output schema', Boolean(tool?.outputSchema));

// ---------------------------------------------------------------- answer
console.log('\naction: answer (with choices)');
{
  const call = client.callTool({
    name: 'meatsack',
    arguments: {
      action: 'answer',
      prompt: 'Which environment is this bug on?',
      choices: ['prod', 'staging'],
      timeoutSeconds: 60,
    },
  });
  const request = await waitForPending((r) => r.action === 'answer');
  check('UI sees the question with its choices', request.choices?.length === 2, request.choices);

  const bad = await respond(request.id, { outcome: 'done' });
  check('rejects a "done" on a question', bad.status === 400, await bad.clone().text());

  const empty = await respond(request.id, { outcome: 'answered' });
  check('rejects an empty answer', empty.status === 400);

  const notOnList = await respond(request.id, { outcome: 'answered', choice: 'mars' });
  check('rejects a choice that was not offered', notOnList.status === 400);

  const ok = await respond(request.id, { outcome: 'answered', choice: 'staging', text: 'since Tuesday' });
  check('accepts a real answer', ok.status === 200);

  const result = await call;
  check('tool returns outcome=answered', result.structuredContent?.outcome === 'answered', result.structuredContent);
  check('tool returns the choice', result.structuredContent?.choice === 'staging');
  check('tool returns the free text', result.structuredContent?.answer === 'since Tuesday');
  check('summary text is explicit', result.content[0].text.startsWith('HUMAN ANSWERED'), result.content[0].text);
}

// ---------------------------------------------------------------- do
console.log('\naction: do (declined)');
{
  const call = client.callTool({
    name: 'meatsack',
    arguments: {
      action: 'do',
      prompt: 'Restart the staging box',
      steps: ['ssh in', 'sudo reboot'],
      timeoutSeconds: 60,
    },
  });
  const request = await waitForPending((r) => r.action === 'do');
  check('checklist survived the trip', request.steps?.length === 2, request.steps);

  const ok = await respond(request.id, { outcome: 'declined', text: 'staging is mid-demo' });
  check('accepts a refusal', ok.status === 200);

  const result = await call;
  check('tool returns outcome=declined', result.structuredContent?.outcome === 'declined');
  check('tells the model it did NOT happen', /did NOT happen/.test(result.content[0].text), result.content[0].text);
}

// ---------------------------------------------------------------- physical
console.log('\naction: physical (hazard + proof)');
{
  const call = client.callTool({
    name: 'meatsack',
    arguments: {
      action: 'physical',
      prompt: 'Unplug the blue cable from switch port 4',
      location: 'server cupboard',
      hazard: 'high',
      requireProof: true,
      timeoutSeconds: 60,
    },
  });
  const request = await waitForPending((r) => r.action === 'physical');
  check('hazard and location made it through', request.hazard === 'high' && request.location === 'server cupboard');

  const noAck = await respond(request.id, { outcome: 'done' });
  check('blocks confirming without the safety tick', noAck.status === 400, await noAck.clone().json());

  const noProof = await respond(request.id, { outcome: 'done', acknowledged: true });
  check('blocks confirming without the photo', noProof.status === 400, await noProof.clone().json());

  const junk = await respond(request.id, {
    outcome: 'done',
    acknowledged: true,
    proof: { mimeType: 'image/png', data: 'not base64!!' },
  });
  check('rejects a rubbish attachment', junk.status === 400);

  const ok = await respond(request.id, {
    outcome: 'done',
    acknowledged: true,
    text: 'cable is out, port light is off',
    proof: { mimeType: 'image/png', data: PNG_1X1, filename: 'port4.png' },
  });
  check('accepts ack + photo', ok.status === 200, await ok.clone().text());

  const result = await call;
  check('tool returns outcome=done', result.structuredContent?.outcome === 'done');
  check('tool reports the safety ack', result.structuredContent?.acknowledged === true);
  check('photo comes back as an image block', result.content[1]?.type === 'image' && result.content[1]?.mimeType === 'image/png', result.content[1]?.type);
}

// ---------------------------------------------------------------- timeout
console.log('\nnobody is home');
{
  const started = Date.now();
  const result = await client.callTool({
    name: 'meatsack',
    arguments: { action: 'do', prompt: 'Water the plant', timeoutSeconds: 5 },
  });
  const waited = (Date.now() - started) / 1000;
  check('times out instead of hanging forever', result.structuredContent?.outcome === 'timeout', result.structuredContent);
  check('waited about 5s', waited >= 4.5 && waited < 9, waited);
  check('tells the model it did NOT happen', /did NOT happen/.test(result.content[0].text));

  const late = await fetch(`${BASE}/api/requests`);
  const { requests } = await late.json();
  check('the expired ask leaves the pending list', requests.every((r) => r.status !== 'pending'));
}

// ---------------------------------------------------------------- backend
console.log('\nbackend hygiene');
{
  const ui = await fetch(`${BASE}/`);
  check('serves the prompt UI', ui.ok && (await ui.text()).includes('meatsack'));

  const traversal = await fetch(`${BASE}/../package.json`);
  check('refuses to climb out of public/', traversal.status === 403 || traversal.status === 404, traversal.status);

  // fetch() refuses to set Host, so speak HTTP by hand for this one.
  const rebind = await rawRequest('evil.example.com', '/health');
  check('refuses non-localhost Host headers', rebind.includes('403'), rebind.split('\r\n')[0]);

  const stillFine = await rawRequest(`localhost:${PORT}`, '/health');
  check('still serves a proper localhost Host', stillFine.includes('200'), stillFine.split('\r\n')[0]);

  const missing = await respond('does-not-exist', { outcome: 'done' });
  check('404s an unknown request id', missing.status === 404);
}

// ------------------------------------------------------- two sessions, one window
console.log('\ntwo sessions, one window');

const transport2 = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'index.js')],
  env: { ...process.env, MEATSACK_PORT: String(PORT), MEATSACK_OPEN: '0' },
  stderr: 'pipe',
  cwd: ROOT,
});
const client2 = new Client({ name: 'meatsack-smoke-two', version: '0.1.0' });
await client2.connect(transport2);

let stderr2 = '';
transport2.stderr?.on('data', (chunk) => {
  stderr2 += chunk;
  process.stderr.write(`    ┆ ${chunk}`);
});
for (let i = 0; i < 100 && !/prompt UI at/.test(stderr2); i++) await sleep(50);

const hubHealth = await (await fetch(`${BASE}/health`)).json();
check(
  'health is signed so other processes can recognise it',
  hubHealth.service === 'meatsack' && typeof hubHealth.version === 'string',
  hubHealth,
);
check('the hub counts one remote session', hubHealth.clients === 1, hubHealth);
check('the second process says it is sharing the window', /sharing the prompt UI/.test(stderr2), stderr2.slice(-400));

const portsSeen = [...stderr2.matchAll(/http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
check(
  'the second process never opened a port of its own',
  portsSeen.length > 0 && portsSeen.every((p) => p === PORT),
  portsSeen,
);

{
  const callA = client.callTool({
    name: 'meatsack',
    arguments: {
      action: 'answer',
      prompt: 'Session A: which database?',
      choices: ['postgres', 'mysql'],
      timeoutSeconds: 60,
    },
  });
  const callB = client2.callTool({
    name: 'meatsack',
    arguments: { action: 'do', prompt: 'Session B: restart nginx', timeoutSeconds: 60 },
  });

  const askA = await waitForPending((r) => r.prompt.startsWith('Session A'));
  const askB = await waitForPending((r) => r.prompt.startsWith('Session B'));

  const { requests } = await listRequests();
  const pending = requests.filter((r) => r.status === 'pending');
  check('both asks are in one listing on one port', pending.length === 2, pending.map((r) => r.prompt));
  check(
    'each ask is labelled with the session that asked',
    askA.asker === 'meatsack-smoke' && askB.asker === 'meatsack-smoke-two',
    [askA.asker, askB.asker],
  );

  // Answer the remote one first: they must be independent.
  const okB = await respond(askB.id, { outcome: 'done', text: 'nginx is back' });
  check('the remote session\'s ask can be answered', okB.status === 200, await okB.clone().text());

  const resultB = await callB;
  check(
    'the remote session gets its own result',
    resultB.structuredContent?.outcome === 'done' && /nginx is back/.test(resultB.content[0].text),
    resultB.structuredContent,
  );

  const mid = await listRequests();
  check(
    'the other session is still waiting, untouched',
    mid.requests.some((r) => r.id === askA.id && r.status === 'pending'),
  );

  const okA = await respond(askA.id, { outcome: 'answered', choice: 'postgres' });
  check('the hub session\'s ask can be answered', okA.status === 200);

  const resultA = await callA;
  check(
    'each result goes back to the right caller',
    resultA.structuredContent?.id === askA.id && resultA.structuredContent?.choice === 'postgres',
    resultA.structuredContent,
  );
}

// A photo has to survive the hop back over the hub's event stream too.
{
  const call = client2.callTool({
    name: 'meatsack',
    arguments: {
      action: 'physical',
      prompt: 'Session B: photograph the rack',
      hazard: 'low',
      requireProof: true,
      timeoutSeconds: 60,
    },
  });
  const ask = await waitForPending((r) => /photograph the rack/.test(r.prompt));

  const noAck = await respond(ask.id, { outcome: 'done', proof: { mimeType: 'image/png', data: PNG_1X1 } });
  check('a remote ask keeps the hazard rules', noAck.status === 400, await noAck.clone().json());

  const ok = await respond(ask.id, {
    outcome: 'done',
    acknowledged: true,
    proof: { mimeType: 'image/png', data: PNG_1X1, filename: 'rack.png' },
  });
  check('a remote ask accepts ack + photo', ok.status === 200, await ok.clone().text());

  const result = await call;
  check(
    'the photo reaches the remote session as an image',
    result.content[1]?.type === 'image' && result.content[1]?.data === PNG_1X1,
    result.content[1]?.type,
  );
  check('the remote session is told about the ack', result.structuredContent?.acknowledged === true);
}

// ---------------------------------------------------------------- the remote door
console.log('\nthe remote ask door');
{
  const bogus = await postAsk({ action: 'teleport', prompt: 'beam me up' });
  check('rejects an action the tool does not have', bogus.status === 400, await bogus.clone().text());

  const bare = await postAsk({ action: 'do' });
  check('rejects an ask with no prompt', bare.status === 400);

  const made = await postAsk({
    action: 'answer',
    prompt: 'Does a question get a checklist?',
    steps: ['it should not'],
    hazard: 'high',
    asker: 'some other session',
    timeoutSeconds: 30,
  });
  const { request } = await made.json();
  check('accepts a well-formed remote ask', made.status === 201 && Boolean(request?.id), request);
  check('keeps the asker label', request?.asker === 'some other session', request?.asker);
  check(
    'strips the fields the tool would strip',
    !request?.steps && request?.hazard === 'none',
    { steps: request?.steps, hazard: request?.hazard },
  );

  const withdrawn = await fetch(`${BASE}/api/requests/${request.id}/cancel`, { method: 'POST' });
  check('a remote ask can be withdrawn', withdrawn.status === 200);

  const after = await listRequests();
  check(
    'the withdrawn ask leaves the pending list',
    after.requests.find((r) => r.id === request.id)?.status === 'cancelled',
  );

  const ghost = await fetch(`${BASE}/api/requests/does-not-exist/cancel`, { method: 'POST' });
  check('404s withdrawing an unknown ask', ghost.status === 404);
}

// ---------------------------------------------------------------- model gives up
console.log('\nthe remote model gives up');
{
  const controller = new AbortController();
  const call = client2.callTool(
    { name: 'meatsack', arguments: { action: 'do', prompt: 'Session B: nobody will do this', timeoutSeconds: 120 } },
    undefined,
    { signal: controller.signal },
  );
  const ask = await waitForPending((r) => /nobody will do this/.test(r.prompt));
  controller.abort();
  await call.catch(() => {});
  await sleep(300);

  const after = await listRequests();
  const found = after.requests.find((r) => r.id === ask.id);
  check('an aborted remote call is withdrawn from the window', found?.status === 'cancelled', found?.status);
}

// ---------------------------------------------------------------- hub dies
console.log('\nthe hub dies under a remote session');
{
  const call = client2.callTool({
    name: 'meatsack',
    arguments: { action: 'do', prompt: 'Session B: outlives the hub', timeoutSeconds: 300 },
  });
  await waitForPending((r) => /outlives the hub/.test(r.prompt));

  const started = Date.now();
  await client.close(); // takes the hub process with it
  const result = await call;
  const waited = (Date.now() - started) / 1000;

  check(
    'the stranded ask comes back instead of hanging',
    ['cancelled', 'timeout'].includes(result.structuredContent?.outcome),
    result.structuredContent,
  );
  check('it comes back quickly', waited < 20, waited);
  check(
    'the model is told it did not happen',
    /WITHDRAWN|did NOT happen|never answered/.test(result.content[0].text),
    result.content[0].text,
  );

  let reborn = null;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      const body = res.ok ? await res.json() : null;
      if (body?.service === 'meatsack' && body.pid !== hubHealth.pid) {
        reborn = body;
        break;
      }
    } catch {
      /* nobody on the port yet */
    }
    await sleep(100);
  }
  check('the surviving session takes the port over', Boolean(reborn), reborn);

  const call2 = client2.callTool({
    name: 'meatsack',
    arguments: { action: 'answer', prompt: 'Session B: still working?', timeoutSeconds: 30 },
  });
  const ask2 = await waitForPending((r) => /still working/.test(r.prompt));
  await respond(ask2.id, { outcome: 'answered', text: 'yes' });
  const result2 = await call2;
  check('asks keep working after the handover', result2.structuredContent?.answer === 'yes', result2.structuredContent);
}

// ---------------------------------------------------------------- phones
console.log('\nletting a phone in');
{
  // Its own process, so none of the hub drama above can colour the result.
  const pairPort = 20000 + Math.floor(Math.random() * 20000);
  const desk = `http://127.0.0.1:${pairPort}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js'), '--ui-only'], {
    env: { ...process.env, MEATSACK_PORT: String(pairPort), MEATSACK_OPEN: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: ROOT,
  });

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${desk}/health`)).ok) break;
    } catch {
      /* still booting */
    }
    await sleep(100);
  }

  const before = await (await fetch(`${desk}/api/pair`)).json();
  check('starts out not sharing', before.active === false, before);

  const started = await fetch(`${desk}/api/pair`, { method: 'POST' });
  const pair = await started.json();

  if (!started.ok) {
    // No usable network (offline, or a locked-down CI box). Not a failure.
    console.log(`  — skipped the LAN checks: ${pair.error}`);
    check('refuses to pair with no network, politely', started.status === 409, pair);
  } else {
    const lan = `http://${pair.address}:${pairPort}`;
    const token = new URL(pair.url).searchParams.get('k');

    check('hands back a link on the LAN address', pair.url.startsWith(lan), pair.url);
    check('the link carries a fat random token', (token ?? '').length >= 32, token?.length);
    check('draws an actual QR', pair.qr?.startsWith('<svg') && pair.qr.includes('<path'), pair.qr?.slice(0, 40));
    check('it expires by itself', pair.expiresAt - Date.now() > 60_000);

    check('pairing twice keeps the same link', (await (await fetch(`${desk}/api/pair`, { method: 'POST' })).json()).url === pair.url);

    const lanGet = (path, init) => fetch(`${lan}${path}`, init);
    check('a stranger on the LAN gets nothing', (await lanGet('/api/requests')).status === 401);
    check('a wrong token gets nothing', (await lanGet(`/api/requests?k=${'x'.repeat(32)}`)).status === 401);
    check('the token works in the query', (await lanGet(`/api/requests?k=${token}`)).status === 200);
    check(
      'the token works as a bearer',
      (await lanGet('/api/requests', { headers: { Authorization: `Bearer ${token}` } })).status === 200,
    );

    // The QR link only carries the token once; the cookie covers css/js/reloads.
    const page = await lanGet(`/?k=${token}`);
    const cookie = page.headers.get('set-cookie') ?? '';
    check('the first hit hands out a cookie', /meatsack_k=/.test(cookie) && /HttpOnly/.test(cookie), cookie.slice(0, 40));
    const jar = cookie.split(';')[0];
    check('the stylesheet loads with it', (await lanGet('/style.css', { headers: { cookie: jar } })).status === 200);
    check('the stylesheet is refused without it', (await lanGet('/style.css')).status === 401);

    // A phone answers prompts. It does not get to invent them.
    check(
      'a phone cannot create asks',
      (await lanGet('/api/requests', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'do', prompt: 'sneaky' }),
      })).status === 403,
    );
    check('a phone cannot read health', (await lanGet('/health', { headers: { cookie: jar } })).status === 403);
    check('a phone cannot re-pair', (await lanGet('/api/pair', { method: 'POST', headers: { cookie: jar } })).status === 403);
    const forged = await rawRequest('evil.example.com', `/api/requests?k=${token}`, pairPort, pair.address);
    check('a forged Host gets nothing', forged.includes('403'), forged.split('\r\n')[0]);

    // The whole point: answer a real ask from the phone.
    const seeded = await fetch(`${desk}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'do', prompt: 'Check the tap', asker: 'phone test', timeoutSeconds: 60 }),
    });
    const { request: seededRequest } = await seeded.json();
    const answered = await lanGet(`/api/requests/${seededRequest.id}/respond`, {
      method: 'POST',
      headers: { cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'done', text: 'tap was off' }),
    });
    check('the phone can answer an ask', answered.status === 200, await answered.clone().text());
    const after = await (await fetch(`${desk}/api/requests`)).json();
    const settled = after.requests.find((r) => r.id === seededRequest.id);
    check('that answer reaches the desk', settled?.resolution?.outcome === 'done', settled?.resolution);

    // Stop sharing and make sure the door is really shut, not just guarded.
    const stopped = await (await fetch(`${desk}/api/pair`, { method: 'DELETE' })).json();
    check('stopping sharing reports it stopped', stopped.active === false);
    await sleep(300);
    let reachable = true;
    try {
      await fetch(`${lan}/style.css`, { headers: { cookie: jar }, signal: AbortSignal.timeout(2000) });
    } catch {
      reachable = false;
    }
    check('the LAN door is shut, not merely locked', reachable === false);
    check('the desk still works after unpairing', (await fetch(`${desk}/health`)).ok);
  }

  child.kill();
  await sleep(200);
}

// ---------------------------------------------------------------- done
await client2.close();
await sleep(200);

console.log(`\n${failures.length ? '✗' : '✓'} ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
process.exit(0);
