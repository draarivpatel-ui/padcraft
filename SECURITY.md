# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/padcraft/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static PadCraft browser workstation and its command-line generators, including the PCB, plate, enclosure and firmware output produced from a clamped configuration, the ZIP export path, configuration import and generated reports.

In scope:

- A cross-site scripting or HTML injection path through imported configuration, key labels, net names or generated report output.
- Configuration or keycode injection into generated firmware, KiCad, Gerber, drill or OpenSCAD source that makes a downstream tool execute attacker-controlled content.
- A ZIP export flaw that writes ambiguous or conflicting entries, such as duplicate relative paths or archive traversal.
- A malformed file or oversized import that bypasses the documented size limit or validation and corrupts the session.
- A report export or spreadsheet escaping flaw that makes generated output execute a formula or script when opened.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Manufacturing tolerances, fabrication outcomes or firmware behavior on physical hardware.
- The command-line generator writing files to paths selected by its caller, which is documented behavior.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
