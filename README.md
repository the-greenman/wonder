# wonder — pop-up book mechanics

Open `house.html` in a browser, served over HTTP (for example `python3 -m http.server`). It shows a closed book that opens, and a house pops up out of the gutter. Drag to look around, scroll to zoom, and use the button or slider to open and close it.

## Layout

| File | What it is |
|---|---|
| `lib/popup.js` | The mechanics library: book page frames, the `Design` you author, and the `Simulation` that folds it. No dependencies; runs in the browser and Node. |
| `lib/popup-three.js` | Draws a `Simulation` with three.js: pages, boards, spine, and textured card panels. |
| `designs/house.js` | The pop-up house, built from two V-folds, two roof caps and a chimney V-fold on the roof. |
| `house.html` | The demo page: artwork, lighting, camera and controls. |
| `test/popup.test.js` | `node test/popup.test.js`: folds designs shut and open again and checks the physics. |
| `tree1.html` | The earlier tree attempt, kept for reference. It uses none of the above. |

## Conventions (the things that used to come out backwards)

- **Spine = Z axis, Y up, +Z toward the reader.** The right page lies flat on the table (`y = 0, x > 0`).
- **Opening angle `phi`** is the angle *between the pages*: `0` is closed, with the left page lying face-down on the right page. `PI` is the flat open spread. The left page's direction is `(cos phi, sin phi, 0)` and its printed side faces `(sin phi, -cos phi, 0)`. Pages never pass through the table.
- **Design in the open state.** Give each panel's corners in world coordinates as they are when the book lies flat open. List the outline counter-clockwise as seen from the printed side; the first edge is the texture's +u.
- **Shared point ids are hinges.** Two shared points make a fold line. A point on the page surface (`y = 0`) is glued to the page under it: `x < 0` left, `x > 0` right, `x = 0` the spine.

## How the physics works

Every panel is rigid card. Each step, the solver moves the pages by at most 1° and then solves for the paper's position. It uses Levenberg–Marquardt over distance and coplanarity constraints, starting from the previous pose, so each mechanism follows the one way real card can fold. Paper is also kept inside the wedge between the two pages. Because a design is authored open and only ever moved continuously, it cannot snap inside-out.

`sim.strain()` measures how far any panel had to stretch or bend to follow the pages. For a buildable design it stays at about 0 (around 1e-15 for the house). If a design shows strain, it could not be made from rigid card: it would tear or crumple. A test shows this using the classic "box straddling the gutter".

Rules of thumb for designs that fold:
- A **V-fold** (two panels glued along lines meeting at one spine point, joined by a central crease) is rigid and folds flat. Most 180° pop-ups are built from V-folds.
- A V-fold can stand on any two hinged panels, not only on the pages. The chimney stands on the two faces of the roof.
- Pieces that only meet when the book is open must be **separate pieces**, using distinct point ids at the same position. Hinging them together over-constrains the mechanism and shows up as strain. The house's front and back halves work this way.
