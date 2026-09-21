# Trivial Pursuit Live Multiplayer

A host-controlled multiplayer trivia game with player devices, custom Excel question workbooks, Socket.IO multiplayer state, custom categories, scoring, wedges, and Final Round logic.

## Current round flow
1. Quickstarter — 5 multi-choice questions. Every player answers independently; answer choices are never locked between players.
2. Round 2 — either Grab Bag or Close Call.
3. Switchagories — always Round 3. The current player receives 2 random category choices, selects one, and then **all players answer** the resulting multi-choice question. The selecting player receives 1,800 points for a correct answer; other players receive 900.
4. Round 4 — whichever of Grab Bag / Close Call was not used in Round 2.
5. Final Round — category sets of five final-round questions. Players answer independently; eliminated players cannot answer that category.

## Answer-lock behavior
- Quickstarter: no cross-player answer locking.
- Switchagories: no cross-player answer locking.
- Final Round: no cross-player answer locking.
- Grab Bag: each selected option is locked after selection; correct players can continue selecting while incorrect players are eliminated.
- Close Call: each player selects one unique option.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Deployment

This is a Node.js/Socket.IO server application. GitHub stores the source code; deploy the repository to a Node-compatible hosting service such as Render to make the game publicly accessible.
