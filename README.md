# Trivial Pursuit Live Multiplayer — v1.28

## v1.28 additions
- Added **New Game** and **Play Again** buttons to the host's post-game screen.
- **New Game** clears the current question set, used-question history, player stats, points, wedges, and game state; the host must upload and validate a new workbook before Start Game is enabled.
- **Play Again** clears player stats, points, wedges, and per-game state while keeping the currently loaded workbook and the persistent used-question history.
- Questions used in previous games are excluded from subsequent Play Again games.
- Final-round category sets are marked used when their category actually begins, so unplayed final categories are not unnecessarily consumed if a game ends early.
- Start Game validates that enough unused Quickstarter/Switchagories multi-choice, Grab Bag, Close Call, and Final Round questions remain. Insufficient remaining question types are reported with the requested popup message.
- Workbook replacement is restricted to lobby state; use New Game to clear an old workbook before loading a different set.

## v1.1.4 — visual polish
- New look: a deep board-game indigo stage. The six category colours are the only bright accents, and the wedge pie is the signature element. Each category has a fixed slot in the pie, like the board-game playing piece.
- Smooth updates: the screen now updates only what changed instead of rebuilding on every server message. Animations no longer replay or flicker, colour changes on reveal animate, and the host's category text boxes keep what's being typed.
- Host / TV: a big lobby join card (address + room code tiles), a scoreboard strip with turn and leader badges, animated score count-ups with "+points" floats, standings that slide into their new order, a countdown ring, answer-progress dots, a full-colour category reveal, a wedge award showing the player's pie with the new slice popping in, a final-standings game-over card, and a dark-themed animated stats modal.
- Host controls: only relevant buttons show for each phase, the next action is highlighted, and keyboard shortcuts work (Space/Enter = Reveal/Next/Start, P = pause, S = skip turn). Setup panels hide once the game starts. The "Hide code" button now works.
- Player / phone: a sticky header with pie, score and round, a full-width countdown bar, large lettered answer buttons, a "You" tag on your pick, a lobby waiting screen with the player list, a green/red screen-edge flash and vibration on reveal, a buzz when it's your turn, and hover effects that no longer stick after a tap.
- Pop-up dialogs replace browser alert/confirm (Play again now has a Cancel option). Toasts handle short messages.
- Timer sync: the server now sends `serverNow` and `timerTotalMs`, so countdowns stay accurate even if a phone's clock is off.
- Phones open on the Player screen automatically. `?code=ABC123` in the URL pre-fills the room code.
- Respects the operating system's reduced-motion setting.

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

## v1.41
Pie chart legend displays correct/answered fraction; bar chart unchanged.
