# Clymbe Check-in

Minimal check-in web app: type your name, describe when you will arrive in plain English, and show who is currently at the gym plus scheduled future sessions.

**Original** [clymbe.rocks](https://clymbe.rocks)
**Live:** [https://climb.rcdis.co/](https://climb.rcdis.co/)

## Includes

- Deno + Oak server (`main.ts`)
- Static single-page UI (`static/index.html`)
- Deno KV for persistence
- Gemini-powered natural language parsing for scheduled sessions

## Run

1. Install Deno (`deno --version` should work).
2. Optional env file:

   ```bash
   cp .env.example .env

   Add `GEMINI_API_KEY` in `.env` to enable natural-language session parsing.
   ```

3. Start:

   ```bash
   deno task start
   ```

4. Open `http://localhost:5353`.

## Deployment

The app is deployed to two independent environments:

- ~~**[clymbe.rocks](https://clymbe.rocks)** — hosted on [Deno Deploy](https://deno.com/deploy). Deploys automatically on push to `main`.~~
- **[clymbe.rcdis.co](https://clymbe.rcdis.co)** — hosted on the [Recurse Center](https://www.recurse.com/) community [Disco](https://letsdisco.dev/) server. Deploys automatically on push to `main` via Docker (`Dockerfile` + `disco.json`).

Each deployment has its own Deno KV database — they do not share data.

## API

- `GET /api/status`
- `POST /api/presence`
  - body: `{ "name": "Your Name", "is_here": true | false }`
- `POST /api/sessions/add`
   - body: `{ "gym": "vital lower east side", "name": "Your Name", "session_details": "arriving in an hour climbing for 90m", "note": "optional", "timezone": "America/New_York", "now_iso": "2026-03-19T22:00:00.000Z" }`
- `POST /api/sessions/cancel`
   - body: `{ "gym": "vital lower east side", "name": "Your Name", "session_id": "uuid" }`
- `GET /api/sessions`
- `POST /api/reset`
- `GET /api/healthz`

Push reminders are sent at 7:00 PM America/New_York time on the day before any scheduled sessions.
