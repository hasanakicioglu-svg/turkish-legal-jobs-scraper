# Hasan Legal Radar manual runner

This Render service backs the Hasan Legal Radar dashboard manual button.

Current scope:

- `GET /health` returns service health and whether search credentials are configured.
- `POST /runs` accepts a manual scan request and returns a `runId`.
- `GET /runs/:runId` returns tracked status, progress, blockers, candidate findings and audit data.
- `GET /runs/:runId/results` returns candidates and audit details.

Important boundary:

- Discovery results are candidates only.
- Candidates are **not** admitted to the dashboard registry until date, active direct URL, duplicate and mandatory third-language filters are verified.
- If `SERPAPI_KEY` is missing, the run completes as `blocked/partial` and explains that no external search was executed.

Render setup:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Plan: free for the initial connectivity/status test
- Environment variable: `ALLOWED_ORIGINS=https://hasan-legal-radar-tr.hasan-akicioglu.chatgpt.site`
- Optional environment variable for actual discovery: `SERPAPI_KEY=<secret>`

This service does not store `OPENAI_API_KEY` or any secret in browser code.
