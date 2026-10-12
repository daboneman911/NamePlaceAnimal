# Name · Place · Animal

The classic letter game in the browser: **Name, Place, Animal, Food, Thing**.
Play solo or online with friends on their own phones.

**Play:** https://daboneman911.github.io/NamePlaceAnimal/

## How to play

1. A letter is drawn at random, or chosen by a player (players take turns).
2. Fill in a Name, Place, Animal, Food and Thing starting with that letter.
3. The round ends when the timer runs out, or when a player with all five columns
   filled hits **STOP**.
4. Everyone reviews the answers. Wrong-letter or blank answers score nothing
   automatically; any other answer counts unless most of the *other* players reject it.
   (In solo you mark your own.)
5. Each accepted answer scores **10**. Highest total after the last round wins.

Host settings: seconds per round, number of rounds, random vs. chosen letters, and
excluded letters (Q, X, Z by default).

## Online play

One player hosts and gets a 5-character room code / invite link; others join with it.
The host's browser runs the game — it holds the state and enforces the rules — and
everyone connects to it directly over WebRTC via [PeerJS](https://peerjs.com/).
PeerJS's free public broker is only used to introduce the browsers to each other, so
there is no server or account to set up.

Things to know:

- **The host's tab must stay open.** If the host leaves, the game ends.
- Players who drop out can rejoin with the **same name** and keep their score.
- Some strict networks (corporate firewalls, symmetric NAT, some mobile carriers) block
  direct peer-to-peer connections. If joining hangs, try another network or have
  someone else host. Fixing this properly would mean adding a TURN relay server.

## Development

Plain HTML/CSS/ES modules, no build step. Serve the folder with any static server
(ES modules don't load from `file://`):

```sh
npx serve .        # or: python -m http.server
npm test           # game-rule unit tests (Node 20+)
```

- `js/engine.js` – pure game rules (reducer), unit-tested in `tests/`
- `js/net.js` – host/client sessions over PeerJS
- `js/app.js` – UI
