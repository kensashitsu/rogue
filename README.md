# Rogue

Python implementation of Rogue 5.4 using curses.

## Requirements

- Python 3.12+
- Windows 10 or later (Windows Terminal recommended). No extra packages needed.
- Terminal: **80 x 24 characters minimum**

## Starting the Game

```
python main.py
```

If a save file (`rogue.sav`) exists from a previous session it is loaded automatically and the title screen is skipped.

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
ui.py            curses display and input
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
```
