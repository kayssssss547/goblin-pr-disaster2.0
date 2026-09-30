# Goblin PR Disaster

## Run locally

Requirements: Node.js 18 or newer.

1. Open a terminal in this folder.
2. Run `npm run dev`.
3. Open http://localhost:4173 in Chrome.
4. Open that same address on each player's device while they are on the same network.

The host creates a room, then shares the four-letter room code. Players join with a unique display name.

Rooms are stored in memory and reset when the server stops.

## Put it online

This project includes `render.yaml` for a public Render deployment.

1. Create a GitHub repository and upload the contents of this folder.
2. In Render, choose **New → Blueprint** and connect that repository.
3. Render reads `render.yaml`, builds the app, and gives you a public `onrender.com` URL.
4. Share that URL with players. They can join from any phone with internet access.

The free service may sleep when unused and wake when someone opens the URL. Rooms reset if the service restarts.
