# Rugpull Journal

An interactive trading journal — concentration tiles, drag-to-trade board, behavioral
analytics, and a margin / margin-call scenario engine. React + Vite, deployable to
GitHub Pages.

## Run locally

```bash
npm install
npm run dev
```

Opens at http://localhost:5173.

## Deploy to GitHub Pages

1. Create a **public** repo named `trading-journal` (the name must match `base` in
   `vite.config.js` — if you use a different name, change that line).

2. Push this folder:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/trading-journal.git
   git push -u origin main
   ```

3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

4. The workflow in `.github/workflows/deploy.yml` runs on every push to `main`.
   When it finishes, the site is live at:

   `https://<your-username>.github.io/trading-journal/`

## Notes

- **Data lives in the browser.** The journal persists to `localStorage`, so it's
  per-browser and per-device — clearing site data wipes it. Use Settings → Export JSON
  for backups.
- **FMP API key** is entered in the app's Settings screen and stored only in
  `localStorage`. Never hardcode it in the source — a public Pages build exposes
  anything in the bundle.
- **Margin math** is a Reg-T-style approximation, not broker-exact. Tune the
  maintenance rates in Settings. Not financial advice.

## Optional: deterministic CI builds

The workflow uses `npm install`. After your first local `npm install`, commit the
generated `package-lock.json` and change the workflow step to `npm ci` for faster,
reproducible builds.
