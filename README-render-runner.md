# Hasan Legal Radar manual runner

This is a minimal Render test service for the Hasan Legal Radar dashboard manual button.

Current scope:

- `GET /health` returns service health.
- `POST /runs` accepts a manual scan request and returns a `runId`.
- `GET /runs/:runId` returns in-memory test status while the service is alive.

This does **not** run the full legal job scan yet. It only verifies that the dashboard can reach a server-side endpoint without putting API keys in browser code.

Render setup:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Plan: free for the initial connectivity test
- Environment variable: `ALLOWED_ORIGINS=https://hasan-legal-radar-tr.hasan-akicioglu.chatgpt.site`
