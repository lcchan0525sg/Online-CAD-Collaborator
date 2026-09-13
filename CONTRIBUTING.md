# Contributing to Online CAD Collaborator

## Before you start

- Discuss substantial features or interaction changes in an issue before implementation.
- Keep STEP/IGES assembly names and hierarchy intact; do not flatten assemblies.
- Do not add CAD fixtures, converted GLB files, language packs, portable ZIPs, or local development files to commits unless a maintainer explicitly requests them.
- Do not commit credentials, tokens, or machine-specific paths.

## Development setup

```bash
npm ci
CAD_PYTHON=/path/to/python npm start
```

The CAD server requires a Python interpreter that can import `OCP`. GLB/GLTF viewing can be developed without running the conversion path.

## Before opening a pull request

1. Keep the change focused and update documentation when behaviour changes.
2. Run `npm run check:syntax`.
3. Run `npm run validate-language -- <language-pack-directory>` if UI strings or translations change.
4. Exercise affected viewer behaviour in a browser. For collaboration changes, verify at least one host and one guest.
5. Include the validation performed and any environment requirements in the pull request.

Use conventional commit subjects where practical, for example `fix: preserve section state after move`.

## Releases

Releases are versioned and published as portable ZIP archives. Do not overwrite or delete earlier archives. A release updates the visible version, changelog, tag, and portable artifact together.
