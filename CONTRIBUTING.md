# Contributing to PadCraft

Thanks for your interest in PadCraft. This project is a client-side EDA and
mechanical CAD generator for RP2040 diode-matrix macropads, producing KiCad
boards, Gerbers, STL plates, OpenSCAD, and KMK or QMK firmware from one clamped
configuration. Contributions are welcome from keyboard builders, EDA users, and
firmware developers.

## Ground rules

- Be respectful and constructive. This project follows the Contributor
  Covenant, found in `CODE_OF_CONDUCT.md`.
- Keep the project dependency free. No `node_modules`, build steps, or runtime
  libraries. Node builtins and the `node:test` runner are fine.
- Keep generation offline. No network requests, no CDN assets, no analytics.
- Generated output must be valid for its consumer. A board file has to parse as
  KiCad 8, Gerbers have to be RS-274X, KMK output has to be valid Python, and
  QMK output has to satisfy `qmk`'s info checks. Every exporter change needs a
  test that proves the artefact still validates.

## Development setup

Requirements:

- Node.js 22 or newer (the test runner is `node --test`)
- Optional: `python3`, used by the suite to syntax-check generated KMK files
- Optional: KiCad and OpenSCAD for manual visual verification

```sh
git clone https://github.com/draarivpatel-ui/padcraft.git
cd padcraft
node --test
```

To open the workstation locally:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The CLI works directly under Node:

```sh
node cad.js all --rows 4 --cols 6 --out build/
node cad.js validate --in build/board.kicad_pcb
```

## How the code is organised

| File | Role |
| --- | --- |
| `cad.js` | The generator core: matrix, KiBOM and Gerber, STL, OpenSCAD, firmware, plus the CLI |
| `app.js` | UI wiring: configuration form, presets, and live export |
| `index.html`, `style.css` | The workstation shell and its styling |
| `test.js` | The test suite |

`cad.js` is a UMD module, so `require('./cad.js')` works in Node and
`window.PadCraft` is available in the browser. It also acts as the CLI entry
point through its `process.argv` branch. Match that pattern in new modules.

## Coding standards

- Use 2-space indentation and single quotes, matching the surrounding file.
- Prefer `const`, and use `let` only when reassignment is required.
- Keep functions small and single purpose. Name them after what they do.
- No comments that restate the code. Comment the reason, the spec reference, or
  the non-obvious trade-off.
- Treat em-dashes and en-dashes as a defect in prose and identifiers. Use
  commas, parentheses, or a plain hyphen instead.
- Never swallow errors silently. Fail loudly with an actionable message.
- Clamp and validate every input at the boundary. A clamped configuration
  object is the single source of truth for exporters, so do not let an exporter
  re-derive limits.

## Adding an exporter or a preset

Exporters write files, so they are the highest-risk area in this repository.
For a new exporter, add a test that reads the generated artefact back and
asserts on its structure, not just on the presence of a function. For a preset,
add a test that generates it and checks at least one characteristic value and a
round trip through `validate`.

## Opening a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Every bug fix should include a regression test
  that fails before your fix.
3. Run the full suite locally: `node --test`.
4. Update documentation where behaviour or a file format changed.
5. Open the PR against `main` with:
   - a short summary of what changed and why,
   - the commands you ran and their result,
   - screenshots or rendered exports for UI and CAD changes,
   - the specification or consumer tool version you validated against.
6. Keep the PR small enough to review in one sitting, and respond to review
   promptly.

Commit messages: use a short imperative subject line under 72 characters. Put
the reasoning in the body, not the subject.

## Reporting bugs

Open an issue with the smallest reproduction you can manage: the configuration
object, the exporter and flags you ran, what you expected, and what happened
instead. Include the consumer tool and version when the artefact fails to open
elsewhere. Security issues follow `SECURITY.md` instead.
