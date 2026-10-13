# Trivial Pursuit Live Multiplayer — v1.28

## v1.28 additions
- Added **New Game** and **Play Again** buttons to the host's post-game screen.
- **New Game** clears the current question set, used-question history, player stats, points, wedges, and game state; the host must upload and validate a new workbook before Start Game is enabled.
- **Play Again** clears player stats, points, wedges, and per-game state while keeping the currently loaded workbook and the persistent used-question history.
- Questions used in previous games are excluded from subsequent Play Again games.
- Final-round category sets are marked used when their category actually begins, so unplayed final categories are not unnecessarily consumed if a game ends early.
- Start Game validates that enough unused Quickstarter/Switchagories multi-choice, Grab Bag, Close Call, and Final Round questions remain. Insufficient remaining question types are reported with the requested popup message.
- Workbook replacement is restricted to lobby state; use New Game to clear an old workbook before loading a different set.

## Run locally
```bash
npm install
npm start
```
Open `http://localhost:3000`.


## v1.35 connectivity fixes
- Existing disconnected players can reconnect during an active game; new players remain blocked after play starts.
- Player reconnect credentials persist locally for refresh/tab recovery.
- Host credentials persist locally so a disconnected/refreshed host can reclaim and continue the live game.
