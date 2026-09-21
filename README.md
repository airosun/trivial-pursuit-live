# Trivial Pursuit Live — Custom Multiplayer

A host-controlled, multiplayer trivia game inspired by Trivial Pursuit Live. The host runs the TV/display view while players join from their own phones or computers.

## Rounds

1. Quickstarter — 5 simultaneous questions from different categories.
2. Grab Bag — 5 questions from different categories. Players take turns selecting answers; correct selections score immediately and let the player remain eligible, while an incorrect selection eliminates that player for the question. Each answer choice can only be claimed once. The workbook's Grab Bag answer list is an unordered set.
3. Switchagories — each player selects a category and answers one question twice, in player order.
4. Close Call — 5 questions from different categories. Each player selects exactly one choice; once everyone has selected (or timed out), the ranking is revealed and points are awarded.
5. Final Round — category sets of five questions with the same two choices in the same order. All active players answer simultaneously; players may choose the same answer.

## Answer display behavior

- Quickstarter: every player may choose the same answer. A player's selection is gray until reveal, then green if correct or red if incorrect.
- Grab Bag: choices are locked globally after being selected. Correct selections turn green and score immediately; incorrect selections turn red and eliminate the player for that question. Once the question is revealed, every correct workbook answer is green and every incorrect option is red.
- Close Call: a selected choice is gray and cannot be selected again. After every player has made one choice, the ranking and points are revealed.
- Final Round: all active players may choose the same answer. Selections are gray until reveal, then green/red.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Workbook

The host can upload the prepared Excel workbook from the host screen. The first sheet contains the six colored categories and the second sheet contains the questions.

## Deployment

The app is a Node.js/Socket.IO server. GitHub can store the repository, while a Node-compatible host such as Render can run `npm start` and provide the public multiplayer URL.
