# Deploy (Sun Nov 1)

One Railway service runs the Express server, which also serves the built client. No Docker, no database.

## Railway
1. New project from the GitHub repo `rahilpatel0402/See-The-Germs`, branch `main`. Nixpacks picks up `nixpacks.toml` (installs ffmpeg, runs `npm run build`, starts `npm start`).
2. Variables: `MODEL_API_KEY`, `MAX_UPLOADS_PER_DAY=20`, `CLIENT_ORIGIN=*`, and optionally `FIREWORKS_API_KEY` or `BASETEN_API_KEY` with `SPARK_BACKEND` to serve the open-weight model. `PORT` is set by Railway. `DEMO_CLIPS` defaults to `feasibility,A,B,C`.
3. The four demo clip caches ship in the repo under `data/clips/`, so the site runs offline from the first deploy with no volume and never calls SAM for them. A volume at `/app/data` is only needed if uploads should survive a redeploy; without one, uploads live until the next deploy, which is fine for the judging window.
4. Open the Railway URL. `GET /api/health` returns `{ ok: true }`. `GET /api/demo` lists the cached clips. The root serves the client.

## Vercel (optional, client only)
If the client should live on Vercel instead of the Railway service: root directory `client`, build command `npm run build` from the repo root with `vite build client`, output `client/dist`, and set `VITE_API_BASE` is not used; the client calls `/api` on its own origin, so add a Vercel rewrite from `/api/:path*` to the Railway URL. Simpler: skip Vercel and use the Railway URL for everything.

## Live path checks before submission
- Upload the never-shown fourth clip through the hosted UI on cellular; watch it segment, adjudicate, and analyze end to end.
- A clip longer than 45 s is refused with 413. The 21st upload of the day is refused with 429. Adjudication stops at 12 per clip.
- Keys appear nowhere in the client bundle: `grep -r MODEL_API_KEY client/dist` returns nothing.
