# PadCraft

An interactive, dependency-free browser CAD studio for custom macropads. Give it a
matrix size and a few dimensions and PadCraft generates a KiCad PCB, an ASCII STL
switch plate, a parametric OpenSCAD plate and case, an RS-274X front copper Gerber,
KMK firmware, a QMK keyboard bundle and the full board model, all client side.

It is built around the Hack Club [Hackpad](https://hackclub.com/), OnBoard, Sprig
and Blot hardware programs, but the geometry and pin mapping are general enough for
any RP2040 based diode matrix keyboard.

## Try it

Open `index.html` in any modern browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/
```

There is no build step, no package install and no network access. The same static
files are published with GitHub Pages. Everything runs locally in the page.

## Browser features

- Program presets (Hackpad, OnBoard, Sprig, Blot) that set matrix size, switch
  type, encoder and sensor defaults.
- Live controls for rows, columns, switch type, key pitch, cutout size, plate and
  PCB thickness, edge margin, encoder position and diameter, mount hole diameter,
  sensor count and RP2040 GPIO pin offset.
- An editable layer 0 keymap grid that feeds the KMK and QMK firmware in real time.
- A live top-down canvas preview of the board outline, switch cutouts, the encoder
  and mounting holes, copper pads and the COL2ROW row and column rails, with
  toggles for each layer and a 10 mm scale bar.
- Board statistics, a full RP2040 pin map and a live validation panel that checks
  the generated KiCad S-expressions, net references, STL normals and firmware.
- A generated file browser with a code preview and per-file downloads, plus a
  single-click ZIP bundle of every artifact (built with a small in-page ZIP
  writer, no libraries).
- Import a saved `padcraft_config.json` to restore a design.

## Generated artifacts

| File | Contents |
| --- | --- |
| `<name>.kicad_pcb` | KiCad board: footprints, pads, nets, copper rails, Edge.Cuts outline and mounting holes |
| `<name>_plate.stl` | ASCII STL switch plate mesh with square cutouts (see the note below) |
| `<name>_plate.scad` | Parametric OpenSCAD plate and case with true cylindrical bores |
| `<name>_F_Cu.gbr` | RS-274X front copper Gerber (pad flashes, traces, outline) |
| `kb.py` | KMK firmware for the CIRCUITPY drive (copy as `code.py`) |
| `qmk_bundle.json` | QMK `keyboard.json`, `keymap.c`, `config.h` and `rules.mk` as a JSON object |
| `padcraft_config.json` | The clamped config used to generate everything |
| `preview.json` | Full board model (browser only) for custom renderers |

### A note on the STL and OpenSCAD plate

The ASCII STL mesher uses axis-aligned cell decomposition. Square switch openings
are exact, but round bores (the encoder hole and the four mounting holes) are
emitted as square openings. The OpenSCAD source uses true cylinders for those
holes. For a manufacturable plate, use the `.scad` file and render in OpenSCAD,
or treat the STL as a fast preview. This is documented in `cad.js` as well.

## Hardware model

The board is a COL2ROW diode matrix driven by a Raspberry Pi Pico (RP2040). Column
GPIOs are driven, row GPIOs are read, and one series diode per key sits between the
switch and the row bus with its cathode facing the row. This matches
`DiodeOrientation.COL2ROW` in KMK and `DIODE_DIRECTION COL2ROW` in QMK.

- Matrix GPIOs come from a pool of safe RP2040 pins (`GP0` through `GP22`), with
  an optional `pinOffset` to skip the first N pins.
- Rotary encoders use three extra GPIOs (A, B and the push switch).
- Analog sensor headers use the dedicated ADC pins `GP26`, `GP27` and `GP28`.
- The generator refuses to over-subscribe the GPIO pool.

Units are millimetres everywhere. The board origin is the top-left corner of the
plate outline, X grows right and Y grows down.

## CLI

`cad.js` also runs as a Node library and CLI. It has no dependencies.

```sh
node cad.js presets                         # list program presets
node cad.js kicad --rows 3 --cols 4 --out board.kicad_pcb
node cad.js stl --program Sprig --out plate.stl
node cad.js scad --rows 2 --cols 3 --out plate.scad
node cad.js gerber --rows 2 --cols 2 --out front.gbr
node cad.js kmk --rows 3 --cols 4 --out kb.py
node cad.js qmk --rows 3 --cols 4 --out qmk_bundle.json
node cad.js preview --rows 3 --cols 4 --out preview.json
node cad.js all --config padcraft_config.json --out ./build
node cad.js check --rows 4 --cols 5          # validate every artifact
node cad.js validate --in board.kicad_pcb    # validate an existing KiCad file
```

Run `node cad.js help` for the full option list. As a library:

```js
const pc = require('./cad.js');
const board = pc.buildBoard({ rows: 3, cols: 4, encoder: true });
const pcb = pc.generateKiCadPcb({ rows: 3, cols: 4 });
console.log(pc.validateKiCadPcb(pcb).valid); // true
```

In a browser, `cad.js` installs `globalThis.PadCraft`.

## Tests

```sh
node --test test.js
```

The suite covers STL triangle normal generation, KiCad S-expression validity and
netlist consistency across a matrix sweep, diode matrix COL2ROW topology and GPIO
assignment, KMK firmware generation (including Python syntax via `ast.parse` when
`python3` is available), OpenSCAD, Gerber, QMK, presets, config clamping and CLI
integration.

## Project layout

| File | Purpose |
| --- | --- |
| `cad.js` | Standalone generator library, CLI and browser global (no dependencies) |
| `app.js` | Browser application: preview, controls, downloads and ZIP writer |
| `index.html` | Single-page app markup |
| `style.css` | Dark workbench theme |
| `test.js` | Node test suite |
| `README.md` | This file |
| `LICENSE` | MIT license |

## Scope

PadCraft is a design and education tool. The generated KiCad files, Gerber and
firmware are starting points, not a guaranteed fabrication-ready or production
output. Review the board, the routing and the pinout before ordering PCBs or
flashing hardware.

## License

MIT. See `LICENSE`.
