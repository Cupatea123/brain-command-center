# Office fixtures

Answers shaped like the API of a OneManCompany office, with made-up people and projects. `tests/fake-office.mjs`
serves them; `tests/agents.test.mjs` reads them. One file per route:

| File | Route |
|---|---|
| `state.json` | `GET /api/state` |
| `employees.json` | `GET /api/employees` |
| `projects.json` | `GET /api/projects` |
| `ceo_sessions.json` | `GET /api/ceo/sessions` |
| `ceo_session.json` | `GET /api/ceo/sessions/<project id>`, keyed by project id |
| `candidates_pending.json` | `GET /api/candidates/pending` |
| `employees/<id>/claude_usage.jsonl` | not a route: the per-run token log in the folder of an employee |
