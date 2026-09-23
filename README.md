# Trivial Pursuit Live — Custom Multiplayer

Version 1.17

A host-controlled multiplayer trivia game built with Node.js, Express, Socket.IO, and XLSX.

## Recent updates

- Host can remove players from the lobby.
- Disconnected players can reconnect with their reconnect token, or from a new browser/device session by entering the same player name while their previous player record is disconnected.
- Questions are tracked globally per game so a question ID is never reused in another round during the same game.
- Grab Bag automatically reveals all answers once every correct option has been claimed.
- Grab Bag host screen shows a temporary selection dialog whenever a player makes a selection.
- Wedge awards have a host-side fanfare animation and sound.
- Final Round category completion waits for the host to press Next before moving to the next category.
- Winner screen includes a celebratory confetti animation and victory sound.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Internet multiplayer

The server listens on `0.0.0.0` and uses the hosting provider's `PORT` environment variable, so it can be deployed as a Node.js web service. Players on different Wi-Fi networks can connect through the same public HTTPS URL.

## Workbook

Upload the prepared Excel workbook from the Host screen. The first sheet contains the six categories and the second sheet contains the questions.

Close Call answer choices use columns E:I and their corresponding values use J:N. The correct order remains in column U / `answer`.
