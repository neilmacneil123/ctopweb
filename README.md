# ctop · web

A web dashboard inspired by the `ctop` TUI that lets you monitor Docker containers from any browser. The project is split into two parts:

- `server/` - lightweight Go service that talks to the Docker Engine (via the official Docker client) and exposes normalized container stats.
- `client/` - static HTML/CSS/JS UI that renders a ctop-style grid with live metrics, filtering, and auto-refresh controls.

## Getting started

```bash
# Terminal 1 - start the API server
cd server
go run .  # listens on http://localhost:4000

# Terminal 2 - serve the static client
cd client
python -m http.server 5173  # serves http://localhost:5173 by default
```

The client expects the API at `http://localhost:4000`. To point it elsewhere, edit `client/config.js` and set `window.CTOP_API_BASE_URL` to your API origin.

## Docker Compose

The repo includes production-ready container setups for both services plus an Nginx layer that serves the static UI and proxies `/api` calls to the backend. Prerequisites: Docker Engine with access to the host Docker socket (for metrics) and Docker Compose v2.

```bash
# Build and start everything
docker compose up --build
```

You now have:

- Backend API at `http://localhost:4000` (still exposing `/api/*` for other tooling)
- Web UI at `http://localhost:8080` (served via Nginx + static assets)

The compose file automatically mounts `/var/run/docker.sock`, so make sure Docker is installed on the host and that your user can read that socket.

## Production build

```bash
# The frontend is static HTML/JS; files live directly in client/ and can be
# served by your favorite HTTP server.
```

## Notes

- The API pulls directly from `/var/run/docker.sock`, so run it on a host that has Docker installed and ensure your user can access the socket.
- If the API cannot reach Docker, the client will surface the error but keep running so you can retry once access is restored.
