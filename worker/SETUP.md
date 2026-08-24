# Nomad17 one-click launcher

The launcher is a Cloudflare Worker between the public GitHub Pages dashboard and GitHub Actions.

## GitHub repository secrets required for deployment

Add these under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with permission to edit Workers.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.
- `NOMAD17_GH_TOKEN` — a fine-grained GitHub token scoped only to `wertikooo-web/nomad17` with Actions read/write permission.
- `NOMAD17_RUN_PASSWORD` — your PIN or secret phrase for the launch button.

Then run Actions → Deploy Nomad17 Launcher → Run workflow.

The deployment creates a Worker named `nomad17-run` and stores `GH_TOKEN` and `RUN_PASSWORD` as Worker secrets. They are never written into the Pages source.

## One-minute limit

The Worker refuses a launch when the latest workflow run started less than 60 seconds ago. The Nomad17 workflow also independently checks `data/state.json` and skips an agent cycle when the previous cycle completed less than 60 seconds ago.

## Connect the Pages button

After deployment Cloudflare will show a URL similar to:

`https://nomad17-run.<your-workers-subdomain>.workers.dev`

Put that URL into `docs/launcher-config.js` as `window.NOMAD17_RUN_ENDPOINT`. Until that is done, the Pages UI allows the operator to paste the Worker URL once and stores it only in that browser's localStorage.
