# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub's private vulnerability reporting under the repository's Security tab. Include the affected version, a minimal configuration or exported file, reproduction steps, expected behavior and the observed impact.

## Scope

PadCraft is a local browser CAD and firmware generator. In scope are configuration or keycode injection into generated source, unsafe DOM rendering, malformed file handling and ambiguous ZIP paths. The command-line generator writes files to paths selected by its caller; it is not a sandbox for executing untrusted programs.

The browser has no runtime dependencies, network requests or remote processing. Source files shown in the UI are rendered as text. Configuration imports are limited to 1 MB and normalized before generation. ZIP entries must have unique relative paths.

## Supported versions

The current version on `main` receives fixes. Good-faith reports are welcome and can be credited on request.
