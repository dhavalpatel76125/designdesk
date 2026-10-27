# VELTROX Design Desk

## Run locally with the project JSON file

Use Node.js 18 or newer:

1. Open a terminal in this folder.
2. Run `node app.js`.
3. Open `http://127.0.0.1:3000` in your browser.

Project edits and uploaded images are saved in
`VELTROX-Complete-Backup-2026-10-27.json` in this folder. The app keeps the
five most recent project versions in `VELTROX-Design-Desk-History.json`.
Use the app's complete backup export before making major changes.

The local server listens only on this computer and does not share or sync data
with other devices. Do not open `index.html` directly; run `node app.js` so the
app can read and write the JSON file.

This local-file setup is not a persistent database when deployed to Vercel.
Vercel deployments need a hosted database or storage service for edits to
persist across deployments and devices.
