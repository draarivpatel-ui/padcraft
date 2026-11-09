# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately through GitHub's
private vulnerability reporting, which is available under the repository's
Security tab. Alternatively, email the maintainer at the address listed in
`CITATION.cff`.

Please do not open a public issue for a security problem. We aim to
acknowledge every report within 5 business days and to provide an assessment
with a target fix date within 10 business days.

## What to include

- A description of the vulnerability and its impact
- The affected file, function, or component
- Steps to reproduce, including any ROM, assembly source, or input file
- The version or commit you tested against
- Any suggested remediation

## Scope

Chipper-8 is a client-side emulator and workbench. In scope are:

- Memory safety issues in the CPU core, such as out-of-bounds bus access
- Assembly parsing bugs that allow arbitrary code execution in Node contexts
- Cross-site scripting or injection through rendered workbench output
- Any path where untrusted ROM or assembly bytes influence the DOM

Out of scope are:

- Denial of service from an intentionally malformed ROM that only affects the
  local browser tab
- Issues in third-party dependencies (this project has none)
- Report of missing hardening features rather than an exploitable defect

## Supported versions

Only the latest release on `main` receives security fixes. This project is
maintained part time, so please allow the timelines above.

## Safe harbour

We support good-faith security research. If you follow this policy, we will
not pursue legal action against you and we will credit your report if you
would like.
