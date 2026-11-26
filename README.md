# PadCraft

**One design. Every layer.**

PadCraft is a browser engineering workstation for RP2040 macropads. A single normalized configuration drives the PCB, switch plate, enclosure source, manufacturing layers and firmware. Inspect a copper pad, isolate its net, follow the remaining airwires and download an entire hardware project without installing a package.

[Open the live workstation](https://aariv.me/padcraft/) | [Read the project story](DEVPOST_UPGRADE.md)

## A five-second demo

1. Click **48-key stress test** to generate the largest supported matrix with an encoder and three analog headers.
2. Hover any gold pad to see its reference, net, coordinates and hole size. Click it to isolate that net.
3. Read the export checks and electrical continuity meter. Dashed airwires identify the connections still to route.
4. Download the ZIP: **25 artifacts**, including seven Gerber layers, two drill files, BOM, DRC and layout proof reports, and a complete QMK folder tree.

### Showcase designs

| Design | Keys | Hardware | Plate triangles | Drill operations | Routes to finish |
| --- | ---: | --- | ---: | ---: | ---: |
| Studio control | 12 | MX matrix and volume encoder | 3,288 | 111 | 19 |
| Sensor console | 6 | MX matrix and three ADC headers | 2,000 | 83 | 21 |
| Pocket instrument | 8 | Choc matrix and encoder | 3,072 | 91 | 18 |
| 48-key stress test | 48 | MX matrix, encoder and three ADC headers | 4,752 | 300 | 35 |

These figures come from the shipped presets and the generator checks. Each plate has zero open or misoriented mesh edges and zero invalid normals.

## Start locally

Open `index.html` directly in a modern browser. There is no build step, external font, CDN, runtime dependency or network request. The same static files work at `https://aariv.me/padcraft/` on GitHub Pages.

For an optional local HTTP server:

```sh
python3 -m http.server 8000
```

## What makes the workstation useful

- **A coherent model:** rows, columns, pitch, peripherals, GPIO allocation and shortcuts flow into every exporter. Numeric bounds and keycode normalization handle empty, oversized, mixed and malformed input.
- **Mechanical separation:** a dedicated 32 mm controller bay prevents the Pico footprint from overlapping switches. A minimum 18 mm pitch leaves room for diode placement; narrow sensor designs widen enough to fit their headers.
- **Electrical inspection:** pad hover and click reveal physical identity, isolate nets and highlight copper. A connectivity graph counts disconnected pad groups instead of presenting a fabricated manufacturing pass.
- **Editable shortcuts:** changes regenerate both firmware formats and preserve overlapping cells when the matrix changes size. Bare key names such as `ESC` normalize to `KC.ESC`.
- **Readable controls:** primary parameters are visible, detailed mechanical settings are expandable, source inspection is optional, and the interface supports both light and dark themes.
- **Keyboard access:** Tab reaches all controls; arrow keys, Home and End inspect switches on the canvas; Escape clears the selection. Alt plus arrow keys navigate keymap cells. Ctrl or Command plus S downloads the bundle; Ctrl or Command plus Enter rechecks it.
- **Resilient execution:** canvas dimensions respect device pixel ratio and observed element resizes. Missing Canvas or restricted storage leaves source generation available. Failed generation clears stale files and disables bundle export.

## DFM and matrix scaling lab

The workstation ships an optional deterministic lab panel (`pad-lab.js`) that audits designs against the real generator, verifier and geometry screen. If the module fails to load, the workstation is unaffected.

- **Benchmark comparator:** the four shipped presets plus four stress matrices (2x2 Choc compact, 3x4 MX with encoder, 4x4 MX with three ADC channels, 6x7 MX full peripheral) report board dimensions, GPIO use against the GP0 to GP22 and GP26 to GP28 pools, STL triangle count and signed volume, PTH and NPTH drill counts, copper and geometry findings, remaining routes and the 25-artifact count. Clicking a row loads that exact design into the workstation.
- **Two interactive SVG charts:** a matrix scaling frontier plotting board area against RP2040 GPIO utilization for MX and Choc across fifteen matrices (1x2 through 6x8), and a manufacturing breakdown comparing drill operations, plate volume and remaining routes per benchmarked design. Markers and columns are clickable and keyboard focusable with transparent hit targets.
- **Audited DFM proof brief:** cycle-safe, depth-bounded canonical JSON sealed by one cached pure-JS FIPS 180-4 SHA-256 digest. The on-page fingerprint, JSON download, formula-injection-safe CSV and Markdown report stamp the identical digest, with verify-digest and one-unit tamper-demo controls.
- **Reloadable state:** a strict fail-closed `#pclab=` URL hash restores a selected benchmark or matrix across reloads.
- **In-page self-tests:** 24 deterministic checks covering SHA-256 known answers, STL watertightness, Gerber and drill headers, GPIO pool non-overlap, ZIP CRC32, digest parity across all four export surfaces, tamper rejection and hash round-trip.

## The 25 exported artifacts

| Artifact | Purpose |
| --- | --- |
| `<name>.kicad_pcb` | KiCad 8 board with embedded footprints, unique object identifiers, resolved pad nets, matrix copper, board profile and mounting holes |
| `<name>_plate.stl` | Closed ASCII STL with exact square switch openings and 48-segment circular encoder and mounting bores |
| `<name>_plate.scad` | OpenSCAD plate and tray with a real plate support ledge, clearance and dimensions derived from editable parameters |
| `<name>_F_Cu.gbr`, `<name>_B_Cu.gbr` | Front and back copper, including every applicable pad at its actual size and position |
| `<name>_F_Mask.gbr`, `<name>_B_Mask.gbr` | Solder mask openings expanded by 0.10 mm per side |
| `<name>_F_Paste.gbr` | Front SMD paste apertures |
| `<name>_F_SilkS.gbr` | Component outlines and diode polarity strokes |
| `<name>_Edge_Cuts.gbr` | Closed board profile, separate from copper |
| `<name>_PTH.drl`, `<name>_NPTH.drl` | Plated and non-plated Excellon operations with explicit decimal coordinates; EC11 mounting slots use `G85` |
| `kb.py` | KMK matrix, media keys, encoder controls and optional standard `analogio` input readers |
| `qmk/<name>/keyboard.json` | QMK matrix, layout, RP2040 and rotary encoder definitions |
| `qmk/<name>/keymaps/default/keymap.c` | QMK shortcuts, rotary mapping and a debounced direct encoder push switch |
| `qmk/<name>/config.h`, `qmk/<name>/rules.mk` | QMK configuration and enabled features |
| `qmk_bundle.json` | The same four QMK sources as a JSON object |
| `padcraft_config.json`, `preview.json` | Normalized configuration and complete placement/netlist snapshots |
| `<name>_bom.json`, `<name>_bom.csv` | Bill of materials with per-line categories, references, quantities and a design fingerprint |
| `<name>_drc.json` | Design rule audit: pitch, enclosure, plate webs, controller bay, drills, pins, keymap, firmware and copper checks |
| `<name>_layout_proof.json` | Manifest binding the design identity to a digest of every other artifact |
| `verification.json` | Export round trips, mesh topology, volume checks, geometry findings and remaining connection groups |

Gerber files use RS-274X `FSLAX36Y36` coordinates in millimetres. Roundrect apertures use additive rectangle and circle primitives. All Gerber and drill files share a bottom-left Cartesian origin; KiCad and the interactive canvas use the corresponding top-left board coordinates. The ZIP stores UTF-8 filenames, CRC32 checksums and matching local/central directory records.

Circular STL bores are polygonal, as all triangle meshes must be. With 48 segments their maximum chord deviation is below 0.013 mm at the largest supported 12 mm encoder bore. The OpenSCAD cylindrical bores use the same segment count.

Copper screening also checks foreign-net pad crossings, pad envelope separation, track intersections, non-plated drills and copper-to-edge clearance. Rounded-pad envelope checks are conservative; native KiCad DRC remains the consumer check.

## Electrical architecture

The switch matrix is `COL2ROW`:

```text
Column GPIO -> COL bus -> switch -> isolated key node -> diode anode
Diode cathode -> ROW bus -> row GPIO
```

Rows drive low; columns are sensed with pull-ups. Each switch has its own diode. Back copper carries column buses; front copper carries row buses, switch-to-diode connections and diode-to-row taps. Digital matrix and encoder pins come from `GP0` through `GP22`; sensor headers use the separate ADC pool `GP26`, `GP27` and `GP28`.

The model distinguishes MX and Choc electrical and support holes. The Pico uses 2.54 mm header pitch and 17.78 mm spacing between rows. EC11 common is grounded, its electrical pins use 2.5 mm spacing, and its two 2.1 x 2.8 mm mounting slots appear in both KiCad and Excellon.

## Verification

Run the entire suite with Node 22 or newer:

```sh
npm test
```

which runs `node --test --test-reporter=spec test.js ui-test.js drc-test.js pad-lab.test.js`.

Verified on Node **v26.8.1**: **491 tests passed, 0 failed, 0 skipped**.

The suite includes:

- 91 engine, export, geometry, firmware and CLI tests.
- 88 design rule and audit regression tests across the full legal configuration space.
- 30 ZIP, shipped HTML syntax and DOM behavior tests, including every configuration field, four presets, imports, downloads, keyboard inspection, net isolation, themes, resize and failure recovery.
- 282 lab tests: SHA-256 known answers and a 0 to 160 byte boundary sweep against Node `crypto`, canonical-JSON ordering, cycle and depth bounds, hostile `#pclab=` and `__proto__` fuzz, CSV formula escaping, digest parity and tamper rejection, preset and matrix sweep invariants against the real engine, ZIP CRC32 verification and fixture-DOM wiring of every lab control.
- A 48-configuration geometry sweep covering every supported matrix size at minimum pitch and margin, with mixed MX/Choc switches and all peripherals.
- A 20-board KiCad matrix sweep, required sections, pad/net correspondence, duplicate references, numeric geometry and unique identifiers.
- Actual emitted STL parsing, opposite edge incidence, positive signed volume and independent polygon-area volume comparison.
- Gerber pad dimensions and positions, layer membership, paste/mask separation, corruption handling and profiles wider than 100 mm.
- Excellon diameters, coordinates, plating, slot endpoints and deliberately damaged tool/coordinate records.
- Four QMK keymaps syntax checked by the local C compiler with firmware API stubs, and four KMK files executed with standard board, encoder, media and analog API stubs. Local C and Python compilers are optional and add these checks when available.

DOM verification executes the actual `cad.js` and `app.js` against IDs parsed from the shipped HTML, captures console errors and rejects nonfinite canvas geometry. These checks do not substitute for a manual browser inspection or running consumer CAD software.

## Command-line workflow

The generator also runs directly under Node:

```sh
node cad.js presets
node cad.js kicad --rows 3 --cols 4 --out board.kicad_pcb
node cad.js stl --program Sprig --out plate.stl
node cad.js scad --rows 2 --cols 3 --thickness 4 --out plate.scad
node cad.js gerber --rows 2 --cols 2 --out front.gbr
node cad.js drill --rows 2 --cols 2 --out plated.drl
node cad.js kmk --rows 3 --cols 4 --out kb.py
node cad.js qmk --rows 3 --cols 4 --out qmk_bundle.json
node cad.js all --config padcraft_config.json --out ./build
node cad.js check --rows 4 --cols 5
node cad.js validate --in board.kicad_pcb
```

`check` reports export validity, mesh topology, remaining routes and geometry findings. `all` writes the same 25 artifacts and creates the nested QMK directories.

## From the workstation to hardware

PadCraft is an inspectable starting point. Finish the visible controller and peripheral airwires in KiCad, run native KiCad DRC, compare the embedded footprints against your chosen component datasheets and regenerate manufacturing files after routing. The included Gerbers describe the generated matrix layout and are not a completed production board.

KMK firmware uses CircuitPython and the KMK library on the target Pico; place `kb.py` on the `CIRCUITPY` drive as `code.py`. Analog readers expose normalized input values for application-specific behavior. The QMK tree supplies matrix and encoder behavior; its sample USB identifiers are for development. The enclosure is a parameterized tray with a plate ledge; adapt cable access and component clearances for your build.

## Source map

| File | Responsibility |
| --- | --- |
| `cad.js` | Geometry, netlist, placement, topology and connectivity checks, exporters, parsers and CLI |
| `app.js` | Dependency-free ZIP writer, canvas inspection, configuration and export UI |
| `pad-lab.js` | Deterministic DFM and matrix scaling lab: canonical JSON, SHA-256 briefs, benchmarks and interactive SVG charts |
| `index.html`, `style.css` | Accessible responsive workstation and theme system |
| `test.js`, `drc-test.js` | Engine/export and design-rule regressions |
| `ui-test.js`, `pad-lab.test.js` | Deterministic DOM interaction tests and the lab verification suite |

## License

MIT. See [LICENSE](LICENSE).
