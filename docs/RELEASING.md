# Release checklist

1. Update the version in `package.json` and `package-lock.json`.
2. Add the release notes to `CHANGELOG.md`.
3. Run `npm ci` and `npm run verify` on a clean checkout.
4. Confirm the repository contains no real serials, LAN addresses, credentials, certificates, private keys, packet captures, or local handoff files.
5. Create a Git tag named `v<version>`.
6. Create a GitHub release from that tag and copy the matching changelog section into the release notes.
7. Attach `out/plugin.zip` from the verified build if a ready-to-deploy artifact is desired.

Do not commit `out/`, `node_modules/`, or historical source ZIP files. Preserve older versions as Git tags and GitHub releases so their changes remain visible without duplicating generated artifacts in the repository.
