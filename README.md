# Trivial Pursuit Live — Multiplayer Prototype v0.8

This prototype is a Node.js + Express + Socket.IO multiplayer implementation of the custom Trivial Pursuit Live rules defined for this project.

## v0.8 — TV host display + phone player UI

- Host screen is optimized for a TV/large display.
- Host has a full-screen button.
- Live player scoreboard shows names, scores, wedges, connection status, and whose turn it is.
- Round badge and game-stage layout make the current round easier to follow from a distance.
- Player view is optimized for phones with larger answer buttons and simplified controls.
- Player connection state is shown on the phone UI.
- Existing v0.7 reconnect tokens remain supported.
- Existing custom workbook upload/validation remains supported.

## Current game structure

1. Quickstarter — 5 questions, each from a different category.
2. Grab Bag — 5 questions, each from a different category.
3. Switchagories — 2 category selections/questions per player.
4. Close Call — 5 questions, each from a different category.
5. Final Round — one five-question set per category, stopping at six wedges or after all categories are used.

## Current scoring

### First four rounds

- Quickstarter: 200 / 400 / 600 / 800 / 1,000.
- Grab Bag round 2: 300 per correct selection.
- Grab Bag round 4: 1,200 per correct selection.
- Close Call round 2: 1,200 / 1,000 / 800 / 600 / 0 by answer rank.
- Close Call round 4: 2,400 / 2,000 / 1,600 / 1,200 / 0 by answer rank.
- Switchagories: 900 normally, 1,800 for the player who selected the category.

Score thresholds for wedges: 2,000 / 6,000 / 12,000 / 20,000 / 30,000 / 42,000. The question category that crosses each threshold determines the wedge color.

### Final Round

- 1,000 points per correct answer.
- A player can earn the category wedge by being the last player remaining in that category or by getting all five questions in that category correct.
- The game ends immediately when a player reaches six wedges.
- If nobody reaches six wedges, most wedges wins, with points as the tiebreaker.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` on the host/TV computer. Players can open the same address on their phones and select Player.

Games are currently stored in server memory. Restarting the Node process ends active games.

## v1.0 game-show polish
- Animated round and Final Round transitions.
- Animated question entry and answer reveal.
- Countdown urgency animation during the final 5 seconds.
- Wedge-award highlight animation on the host scoreboard.
- Animated winner screen.
- Lightweight browser-generated sound cues for question, reveal, round transition, wedge award, and game win.
- Respects `prefers-reduced-motion`.
