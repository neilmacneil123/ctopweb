# ctop · web

A web dashboard inspired by the `ctop` TUI that lets you monitor Docker containers from any browser. The project is split into two parts:

- `server/` – lightweight Express service that talks to the Docker Engine (via `dockerode`) and exposes normalized container stats.
- `client/` – Vite + React UI that renders a ctop-style grid with live metrics, filtering, and auto-refresh controls.

## Getting started

```bash
# Terminal 1 – start the API server
cd server
npm install
npm start  # listens on http://localhost:4000

# Terminal 2 – launch the web client
cd client
npm install
npm run dev  # serves http://localhost:5173 by default
```

The client expects the API at `http://localhost:4000`. To point it elsewhere, create a `.env` file inside `client/` and set `VITE_API_BASE_URL=http://your-api-host:port` before running `npm run dev`.

## Docker Compose

The repo includes production-ready container setups for both services plus an Nginx layer that serves the React build and proxies `/api` calls to the backend. Prerequisites: Docker Engine with access to the host Docker socket (for metrics) and Docker Compose v2.

```bash
# Build and start everything
docker compose up --build
```

You now have:

- Backend API at `http://localhost:4000` (still exposing `/api/*` for other tooling)
- Web UI at `http://localhost:8080` (served via Nginx + static React build)

The compose file automatically mounts `/var/run/docker.sock`, so make sure Docker is installed on the host and that your user can read that socket. To override the API URL baked into the frontend build (if you are fronting the stack behind another host), provide `VITE_API_BASE_URL` when building:

```bash
VITE_API_BASE_URL=https://monitor.example.com/api docker compose up --build
```

## Production build

```bash
# Build the frontend
cd client
npm run build

# Static files live in client/dist and can be served by your favorite HTTP server.
```

## Notes

- The API pulls directly from `/var/run/docker.sock`, so run it on a host that has Docker installed and ensure your user can access the socket.
- If the API cannot reach Docker, the client will surface the error but keep running so you can retry once access is restored.
