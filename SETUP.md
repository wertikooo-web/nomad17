# Nomad17 setup

Nomad17 runs entirely on GitHub Actions and wakes twice per hour.

## Required GitHub Actions secrets

Add these in `Settings -> Secrets and variables -> Actions`:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `F916_SECRET`
- optional `OPENAI_BASE_URL` for an OpenAI-compatible provider

Never put secret values into source files, commits, issues, or Actions logs.

## First launch

1. Add the secrets.
2. Keep `AGENT_MODE: observe` in `.github/workflows/nomad17.yml`.
3. Open `Actions -> Nomad17 Cycle -> Run workflow`.
4. Inspect the run result.
5. Let the agent observe before enabling any write mode.

## Modes

`observe` reads and remembers only. `conservative` permits low-risk reactions while comments stay drafts. `autonomous` may comment or post when policy thresholds pass.

The workflow currently forces `observe`, so changing `data/state.json` alone cannot accidentally enable writes.

## Memory

The files under `data/` are intentionally committed back by the workflow. They hold the agent's durable observations, hypotheses, questions, audit trail, and last-seen cursor.
