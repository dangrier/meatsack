# 🧍 meatsack

An MCP server that lets a model ask a **human** for help.

The model calls one tool. A prompt window pops up on your machine. The tool call
sits there, blocked, until you press a button. Your answer goes straight back to
the model — including a photo, if it asked for one.

```
model ──▶ meatsack tool ──▶ local backend ──▶ browser prompt UI ──▶ you
  ▲                                                                 │
  └─────────────── outcome + answer + photo ◀───────────────────────┘
```

Every session you have open shares **one** window. See
[One window, every session](#one-window-every-session).

## One tool, three actions

The `action` decides what the human is being asked for, which buttons they get,
and what counts as a valid reply.

| action     | for                              | human sees                                   | they reply with    |
| ---------- | -------------------------------- | -------------------------------------------- | ------------------ |
| `do`       | a task to perform                | checklist, notes box                         | **done** / refused |
| `answer`   | a fact or decision only they have| choice buttons and/or a text box             | **answered** / "I don't know" |
| `physical` | moving atoms in the real world   | location, hazard warning + tick, photo upload| **done** / refused |

### Examples

```jsonc
// answer — ask a question, offer options
{ "action": "answer",
  "prompt": "Which environment is the checkout bug on?",
  "choices": ["production", "staging", "both"] }

// do — ask for a task, with a checklist
{ "action": "do",
  "prompt": "Approve the release PR so I can carry on",
  "steps": ["Open the PR", "Skim the diff", "Hit Approve"],
  "urgency": "high" }

// physical — move atoms, with a safety tick and photo proof
{ "action": "physical",
  "prompt": "Unplug the blue cable from switch port 4",
  "location": "server cupboard, second rack from the door",
  "hazard": "medium",
  "requireProof": true }
```

### What comes back

```jsonc
{ "outcome": "done",        // done | answered | declined | timeout | cancelled
  "answer": "cable is out", // free text they typed
  "choice": "staging",      // the option they picked
  "acknowledged": true,     // they ticked the safety box
  "proofAttached": true,    // photo is in the content as an image block
  "waitedSeconds": 84.3 }
```

Only `done` and `answered` mean the human came through. `declined`, `timeout`
and `cancelled` all mean **it did not happen** — the text block says so in
capital letters, because models are optimists.

## Install

```bash
npm install && npm run build
```

## Wire it into a client

Claude Code (`.mcp.json` in your project, or `claude mcp add`), Claude Desktop
(`claude_desktop_config.json`), or anything else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "meatsack": {
      "command": "node",
      "args": ["/absolute/path/to/meatsack/dist/index.js"]
    }
  }
}
```

## One window, every session

MCP over stdio gives **every client its own server process**. Three Claude
sessions means three meatsacks, and naively that means three prompt windows on
three different ports, two of which you have to dig out of a log.

So they elect a hub:

```
session A ──▶ meatsack #1 ─── binds :7777 ──▶ the window ──▶ you
session B ──▶ meatsack #2 ─── POST /api/requests ─┤
session C ──▶ meatsack #3 ─── POST /api/requests ─┘
```

- On startup each process tries to bind `MEATSACK_PORT`. Whoever gets it is the
  **hub** and behaves exactly as a lone meatsack does.
- Anyone who gets `EADDRINUSE` asks the port `GET /health`. If the answer is
  signed `{"service":"meatsack"}` it becomes a **client**: it posts its asks to
  the hub over HTTP and waits for the answer on the hub's event stream. If the
  port belongs to something else entirely, it takes a free port and runs alone.
- Every card is labelled with the session that asked, so you know who you are
  answering.

Clients validate nothing of their own: `POST /api/requests` runs the same
schema and the same action rules as the tool, so the HTTP door cannot create an
ask the tool could not. When a model aborts a call, its process withdraws the
ask from the hub (`POST /api/requests/:id/cancel`) rather than silently
ignoring the reply.

### When the hub's session ends

**The hub does not survive its own session, and the others re-elect.**

The tempting alternative is to keep the hub alive while other sessions depend
on it. You cannot: an MCP host kills its server process on disconnect — it
closes stdin, waits, sends `SIGTERM`, waits, then `SIGKILL`. Any "stay alive
for the others" logic is a four-second stay of execution and then a lie.

So instead the hub says goodbye on its way out, and the survivors race to bind
the port. The winner becomes the new hub; the rest reconnect to it. A hub that
is hard-killed with no goodbye is noticed within about three seconds, by the
event stream failing to come back up.

The trade-off, stated plainly:

- **You pay for it in history.** The new hub is a new process with an empty
  store, so the resolved cards from before the handover are gone. Your browser
  tab reconnects on its own (same port) and re-syncs to the new hub.
- **Asks in flight at the moment the hub dies are lost**, because they only
  ever lived in the dead process's memory. They come back to their model as
  `cancelled` — "REQUEST WITHDRAWN … was never answered" — within a few
  seconds. They never hang.
- Each ask also carries a local timer in its own process, so even if the event
  stream dies in a way nobody notices, a tool call still ends in `timeout`
  rather than waiting forever.

## Try it without a model

```bash
npm run demo
```

Fires one of each action at the UI, then prints the replies exactly as a model
would receive them. Open <http://127.0.0.1:7777> and click around.

```bash
npm run smoke
```

End-to-end test: a real MCP client, the real tool, the real HTTP backend, with
the test playing the human. 62 checks, including two clients sharing one
window and a hub dying under a session that depended on it.

## Answer on your phone

Press **📱** in the window. meatsack shows a QR code; point your phone camera
at it and the same prompt UI opens there. Handy for `physical` asks, where the
photo-proof box becomes your phone camera.

```
desk ──[📱]──▶ QR with a one-off token ──▶ phone on the same Wi-Fi
```

What actually happens when you press it:

1. A second listener opens, on your LAN address only, on the same port.
2. A random 32-character token is minted and baked into the QR link.
3. The first hit with that token gets an `HttpOnly` cookie, so the stylesheet,
   the script, the event stream and every later reload get in too.
4. After an hour (or when you press **Stop sharing**) the listener closes, the
   token dies, and any connected phone is told it has been unplugged.

Until you press that button meatsack is localhost-only, exactly as before.
Nothing is listening on your network.

**A paired phone can only read the asks and answer them.** It cannot create an
ask, read `/health`, or pair another device — those are refused with a 403 even
with a valid token. A phone is a pair of hands, not another robot.

### Before you use it

- **Same Wi-Fi only.** Your phone must be on the same network. Guest networks
  and "client isolation" on the router will block it.
- **It is plain HTTP.** Anyone who can watch your network traffic can see the
  token and the prompts. Do not pair on café or hotel Wi-Fi.
- **Anyone who scans the code is in**, for as long as the pairing lasts. Do not
  share your screen with the QR on it.
- **macOS may ask** whether `node` can accept incoming connections the first
  time you pair. Say yes, or the phone cannot reach it.

## Knobs

| env var              | default     | what it does                                    |
| -------------------- | ----------- | ----------------------------------------------- |
| `MEATSACK_PORT`      | `7777`      | The shared window. First process to bind it is the hub; the rest join it. |
| `MEATSACK_HOST`      | `127.0.0.1` | Bind address. Leave it alone.                    |
| `MEATSACK_OPEN`      | on          | `0` stops it opening your browser; it logs the URL instead. |
| `MEATSACK_PAIR_TTL`  | `60`        | Minutes a phone pairing lasts before it shuts itself off (1–480). |

`node dist/index.js --ui-only` runs just the backend, no MCP. It never joins
someone else's hub — if the port is busy it takes a free one.

## How it behaves

- **The browser only opens when nobody is watching.** If a meatsack tab is
  already open, new asks just appear in it. Bursts are throttled to one window.
- **Timeouts are real.** Default 300s, set `timeoutSeconds` per ask (5–3600).
  The card counts down and goes dead when it expires.
- **Refusing is a first-class answer.** Every card has a "no" button, and it
  never needs a reason.
- **Hazards need a tick.** Any `hazard` above `none` makes the human confirm
  they have read the warning before the confirm button will work — enforced on
  the server, not just in the UI.
- **Proof is enforced too.** `requireProof` means no photo, no confirmation.
- **If the model gives up** (client disconnects, call aborted), the ask is
  withdrawn so nobody acts on a stale request — including across the hub, when
  the asking session is not the one holding the port.
- **One window for every session.** See
  [One window, every session](#one-window-every-session) above.

## Safety notes

- The backend binds to `127.0.0.1` and rejects any request whose `Host` header
  is not localhost, so a random web page cannot drive it. The one exception is
  a phone pairing you started yourself, which opens a second listener on your
  LAN address — token-guarded, time-limited, and shut again on demand. See
  [Answer on your phone](#answer-on-your-phone).
- Everything the model writes reaches the page as `textContent`, never HTML.
- There is no auth. Anything running as you on your machine can answer these
  prompts, and — now that sessions share a hub — anything running as you can
  also post an ask into your window. That is the trade for zero setup; it is
  the same trust boundary as before, since every one of those processes could
  already have started a meatsack of its own. Do not expose the port.
- Attachments are capped at 8MB and must be real base64.

## Layout

```
src/types.ts   shared vocabulary (actions, outcomes)
src/store.ts   the asks, the waiting, the rules about valid replies
src/http.ts    hub: REST + SSE + static UI, localhost-only — and the client
               that talks to someone else's hub when we lost the port
src/pairing.ts the phone door: LAN listener, token, QR, expiry
src/mcp.ts     the `meatsack` tool: schema, description, result shaping
src/index.ts   wires it together: hub-or-client election, stdio transport,
               re-election when the hub dies, shutdown
public/        the prompt UI (no build step, no framework)
scripts/       demo.mjs and smoke.mjs, both real MCP clients
```
