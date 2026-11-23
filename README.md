# Rogue

Python implementation of Rogue 5.4 for the terminal, in English or Japanese.

## 3D Version (browser)

**Play: https://kensashitsu.github.io/rogue/web3d/**

The same game seen in first person — drawn only with ASCII characters. Walls, floors, torchlight
and monsters are all built from the glyphs of an 80x24 terminal, and the question behind it is
how real a space can feel when it is made of nothing but text. Light falls off with distance,
lit rooms glow through their doorways, and places you only remember sink into darkness.
Sound follows the same idea: footsteps, torches and doors are placed in space, muffled through
walls and echo according to the size of the room (sound is optional; the game plays the same muted).

- Works on phones (touch buttons) and desktop browsers (keyboard). Tested mainly on iPhone SE (3rd gen).
- The first load takes a while (tens of seconds): it downloads Python (Pyodide) to run the game.
- English, Japanese, or English with Japanese subtitles.
- Saves stay in the browser, separate from the 2D browser version.

## How This Was Made

This project was built with an AI coding assistant (Claude Code). The author decided what to make,
played it on a real phone and judged every change; most of the code was written by the AI.
The rules follow the Rogue 5.4 C source, with the deliberate changes listed below.

## Requirements

- Python 3.12+
- Windows 10 or later (Windows Terminal recommended). No extra packages needed.
- Terminal: **80 x 24 characters minimum**

## Starting the Game

```
python main.py
```

If a save file (`rogue.sav`) exists from a previous session it is loaded automatically and the title screen is skipped.

## Playing on a Phone

The same game runs in the browser: https://kensashitsu.github.io/rogue/web/

Python runs in the page through Pyodide, so the rules are exactly those of the terminal version.
On a phone, the map follows the player, and the on-screen buttons send the original keys
(hold a direction to keep walking). Saves, scores and the language setting stay in the browser.
On iPhone, adding the page to the Home Screen keeps Safari from clearing them.

## Language

Press `Tab` on the name entry screen, or `o` during play, to switch between English and Japanese.
The choice is saved in `rogue.cfg`. For Japanese, a font with Japanese glyphs (e.g. BIZ UDGothic)
in Windows Terminal gives the cleanest spacing.

## Objective

Descend to floor 26, retrieve the **Amulet of Yendor** (`,`), then ascend back to the surface alive.

## Commands

| Key | Action |
|-----|--------|
| `h` `j` `k` `l` | Move west / south / north / east |
| `y` `u` `b` `n` | Move diagonally |
| `H` `J` `K` `L` `Y` `U` `B` `N` | Run in direction until stopped |
| `>` | Descend stairs |
| `<` | Ascend stairs (escape with Amulet from floor 1 to win) |
| `i` | Show inventory |
| `d` | Drop item |
| `e` | Eat food |
| `r` | Read scroll |
| `q` | Quaff (drink) potion |
| `w` | Wield weapon |
| `W` | Wear armor |
| `T` | Take off armor / put away weapon |
| `P` | Put on ring |
| `R` | Remove ring |
| `t` | Throw item |
| `z` | Zap wand or staff |
| `f` | Fight in direction |
| `s` | Search for traps |
| `.` | Rest one turn |
| `@` | Show character status |
| `?` | Command help |
| `^` | Check for traps at current position |
| `/` | Identify a map symbol |
| `S` | Save game and quit |
| `Q` | Quit without saving |
| `Ctrl-P` | Repeat last message |
| `Ctrl-R` | Redraw screen |
| `o` | Switch language (English / Japanese) |

## Map Symbols

| Symbol | Meaning |
|--------|---------|
| `@` | You |
| `A`-`Z` | Monsters |
| `%` | Staircase |
| `*` | Gold |
| `!` | Potion |
| `?` | Scroll |
| `)` | Weapon |
| `]` | Armor |
| `=` | Ring |
| `/` | Wand or staff |
| `:` | Food |
| `,` | Amulet of Yendor |
| `#` | Passage |
| `.` | Floor |
| `+` | Door |

## Save / Load

- Press `S` to save and quit. The game is also saved automatically when the
  window is closed.
- On next launch the save file is loaded automatically.
- **Death deletes the save file** (permadeath, Rogue original behaviour).
- Save file: `rogue.sav` (pickle, project directory)

## High Scores

- Top 10 scores are stored in `rogue.scr` (JSON, project directory).
- Score = gold + experience points (+ level x 100 for winning).
- The high score table is shown after death or a successful escape.

## File Structure

```
main.py          Entry point
game.py          Game loop, save/load, high scores
ui.py            Screens, messages and input
term.py          VT-sequence drawing layer (curses-compatible, full-width aware)
i18n.py          Language switching (tr / name)
i18n_ja.py       Japanese translations
dungeon.py       Dungeon generation
player.py        Player stats and inventory
monsters.py      Monster definitions and AI
items.py         Item definitions and effects
combat.py        Combat calculations
constants.py     Constants loaded from JSON
data/
  items.json     Item parameters
  monsters.json  Monster parameters
rogue.sav        Save file (created at runtime)
rogue.scr        High score file (created at runtime)
web/
  index.html     Browser version: page and styles
  app.js         Browser version: drawing, buttons, local storage
  worker.js      Browser version: runs the game in Pyodide
  coi-serviceworker.js  Enables cross-origin isolation on GitHub Pages
web3d/           3D browser version (copy of web/ plus the following)
  r3d.js         First-person view drawn with ASCII glyphs (Three.js)
  sound.js       Positional sound, synthesized in the page
```

## Changes from Rogue 5.4

Everything else aims to match 5.4. These differences are intentional: small adjustments for
modern players, making the game a little more forgiving and showing more of what is going on,
without changing how it plays:

- Combat and healing messages show damage and HP numbers. Resting (`.`) says "You rest.".
- Gold and items taken by a thief come back when you kill it. A nymph can steal any one item and moves elsewhere on the floor.
- The five identify scrolls are merged into one that identifies any item.
- Wandering monsters appear asleep. Unseen attackers are "something", not "it".
- Gentler numbers: +2 max HP on level up; blindness and hallucination last about 50 turns, confusion 5.
- Monster detection lasts until you leave the floor.
- Thrown potions shatter and affect the monster they hit.
- Two-handed swords (and long swords, less so) are clumsy in corridors and doorways; a two-handed sword also worsens AC by 1.
- Entering a treasure room shows a one-time message.
- `Z` rests until you are healed.
- 3D version only: undiscovered traps and secret doors give faint hints up close, sleeping monsters close their eyes,
  badly hurt monsters look damaged, corridors you have walked are lit by torches, and lit rooms can be seen into
  from their doorways. The map memory itself is unchanged.

## License

This is a Python reimplementation of Rogue 5.4 by Michael Toy, Ken Arnold and Glenn Wichman.
The original copyright notice and license are in [LICENSE.txt](LICENSE.txt).
