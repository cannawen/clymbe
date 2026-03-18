# Clymbe Check-in

Minimal check-in web app: type your name, choose **1 / 2 / 3** hours to check in, and show who is currently at the gym.

**Original** [clymbe.rocks](https://clymbe.rocks)
**Live:** [https://climb.rcdis.co/](https://climb.rcdis.co/)

## Includes

- Deno + Oak server (`main.ts`)
- Static single-page UI (`static/index.html`)
- Deno KV for persistence

## Run

1. Install Deno (`deno --version` should work).
2. Optional env file:

   ```bash
   cp .env.example .env
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
- `POST /api/reset`
- `GET /api/healthz`
