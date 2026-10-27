# Deploy (Sun Nov 1)

One Railway service runs the Express server, which also serves the built client. No Docker, no database.

## Railway
1. New project from the GitHub repo `rahilpatel0402/See-The-Germs`, branch `main`. Nixpacks picks up `nixpacks.toml` (installs ffmpeg, runs `npm run build`, starts `npm start`).
2. Variables: `MODEL_API_KEY`, `DEMO_CLIPS=A,B,C`, `MAX_UPLOADS_PER_DAY=20`, `CLIENT_ORIGIN=*` (or the Vercel origin if the client is hosted separately). `PORT` is set by Railway.
3. Attach a volume at `/app/data` so the demo clip caches survive deploys. Then copy the three demo clip folders (`source.mp4`, `sampled.mp4`, `meta.json`, `entities.json`, `scenario.json`, `tracks/`, `adjudications.json`, `analysis.json`, `narrative.json`) into `data/clips/<id>/` on the volume, for example with `railway ssh` and a tar stream, or by uploading once through the API and running the scripts there. The demo clips must never call SAM live.
4. Open the Railway URL. `GET /api/health` returns `{ ok: true }`. `GET /api/demo` lists the cached clips. The root serves the client.

## Vercel (optional, client only)
If the client should live on Vercel instead of the Railway service: root directory `client`, build command `npm run build` from the repo root with `vite build client`, output `client/dist`, and set `VITE_API_BASE` is not used; the client calls `/api` on its own origin, so add a Vercel rewrite from `/api/:path*` to the Railway URL. Simpler: skip Vercel and use the Railway URL for everything.

## Live path checks before submission
- Upload the never-shown fourth clip through the hosted UI on cellular; watch it segment, adjudicate, and analyze end to end.
- A clip longer than 45 s is refused with 413. The 21st upload of the day is refused with 429. Adjudication stops at 12 per clip.
- Keys appear nowhere in the client bundle: `grep -r MODEL_API_KEY client/dist` returns nothing.
