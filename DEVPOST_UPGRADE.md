# PadCraft: One design. Every layer.

## Inspiration

A custom macropad should be a small hardware project, yet its decisions spread across a PCB editor, mechanical CAD, a pin spreadsheet and firmware. Changing the number of keys can leave those files out of sync. PadCraft brings the decisions into one inspectable model so builders can understand how a shortcut becomes a switch, a diode, a net and a physical opening.

## What it does

PadCraft turns a key matrix into 21 coherent design artifacts entirely in the browser. It produces a KiCad 8 board, seven Gerber layers, separate plated and non-plated Excellon operations, a closed STL switch plate, a parameterized OpenSCAD tray, KMK firmware and a complete QMK directory tree.

Four showcase buttons make the design tangible immediately: a studio controller, a sensor console, a pocket instrument and a 48-key stress test. Judges can hover a copper pad to inspect its net and dimensions, click it to isolate the signal, edit shortcuts and watch both firmware sources change. Keyboard inspection, light and dark themes, compact advanced controls and an export source viewer make the tool usable without an explanation from its author.

The interface also tells the truth about engineering progress. A connectivity graph draws the controller and peripheral airwires still to route. Export schema checks and a closed mesh badge are separate from the unfinished routing work.

## How we built it

The core is standalone JavaScript shared by the browser and a Node command-line interface. One normalized configuration feeds deterministic GPIO allocation, diode topology, component placement and every file writer. The Pico occupies a dedicated controller bay, and sensor layouts widen when their headers need more space.

The STL mesher uses vertical slabs cut at every polygon vertex. Shared slab edges are subdivided at tangencies and other boundary events, eliminating T junctions. Circular bores use 48 segments. A signed-volume calculation and opposite edge incidence check validate the emitted triangles after parsing the STL text back.

The export pipeline writes KiCad S-expressions, RS-274X aperture macros and Excellon drill/slot records, then reads their actual text back. Pad positions, pad dimensions, net names, drill diameters, plating and slot endpoints are compared with the design model. A small UTF-8 ZIP writer uses CRC32 and consistent local/central directory records to package the project without a library.

## Challenges

The deepest problems were hidden behind convincing previews. The original Gerber header was malformed, front copper omitted SMD diode pads and the board profile appeared on copper. Uniform flashes also lost actual pad shapes and dimensions. Those defects required a real layer model and export round trips.

Small matrices exposed physical placement errors: the controller could overlap switches or leave the board, while Choc footprints used MX hole positions. Correcting those layouts also exposed missing mounting drill operations and an encoder common/pin layout that needed attention.

Mechanical output required more than checking that triangle normals were unit length. Square replacements for circular bores, conforming shared boundaries, numerical normal calculations and an enclosure with a real support ledge all needed separate fixes and regression tests.

Firmware and UI had their own boundary failures. QMK numeric keycodes and trailing macro arguments were wrong; its encoder push field was unsupported. KMK needed its media extension and standard analog inputs. A failed regeneration could leave an old downloadable ZIP, and the interface presented an unconditional DRC pass. The upgraded workstation blocks stale exports and reports the remaining work directly.

## Accomplishments

- One live configuration produces a portable PCB, mechanical design and firmware project with no browser dependency or build step.
- Seven manufacturing layers preserve correct pad membership, shape, size and coordinate alignment.
- Encoder slots and every mounting hole appear in explicit plated or non-plated drill files.
- The maximum showcase generates 48 keys, 105 KiCad footprints, 396 KiCad pad instances, 300 drill/slot operations and 4,752 closed STL triangles.
- Every shipped scenario passes the export round trips and generated copper geometry checks while retaining an honest count of routes to finish.
- All controls, imports, downloads and interactive inspection features are exercised against the shipped scripts and HTML.

## Verification numbers

Verified on Node v24.16.0 with:

```sh
node --test test.js ui-test.js
```

**110 passed, 0 failed, 0 skipped.** The suite comprises 87 engine/export/CLI tests and 23 ZIP/HTML/DOM checks.

| Verification | Observed result |
| --- | --- |
| One-click scenarios | 4, all export checks pass |
| Source artifacts per scenario | 21 |
| Gerber layers per scenario | 7 |
| Drill files per scenario | 2, plating separated |
| Matrix geometry sweep | 48 configurations, closed meshes and valid generated copper geometry |
| KiCad matrix sweep | 20 boards, resolved net references |
| Maximum showcase mesh | 4,752 triangles, 0 bad edges, 0 invalid normals |
| Maximum showcase drill operations | 300, including 2 encoder slots |
| Maximum showcase volume error | Below 0.000001 mm3 |
| QMK compiler checks | 4 showcase keymaps, using local C compiler and firmware API stubs |
| KMK runtime checks | 4 showcase files, using board/encoder/media/analog API stubs |
| Captured DOM console errors | 0 |

The measurements establish generator and UI contracts. Physical hardware, full native KiCad DRC and a firmware build against an installed QMK checkout remain separate steps in a real fabrication workflow.

## What's next

The next engineering steps are obstacle-aware routing to the Pico, native CAD consumer validation, editable component placement, richer silkscreen labels and enclosure cable openings tied to the selected module. A physical build would verify switch fit, encoder feel and manufacturing tolerances using the same exported configuration.

## Judge demo

Open [PadCraft](https://aariv.me/padcraft/), choose **48-key stress test**, click a row or column pad and follow the highlighted copper. Switch to **Studio control**, change one shortcut and inspect `kb.py` or the QMK keymap. Download the ZIP and inspect `verification.json` for the topology and routing report.
