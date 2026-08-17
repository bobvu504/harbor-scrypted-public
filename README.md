# Harbor for Scrypted

Community-maintained tools and documentation for connecting Harbor cameras to
[Scrypted](https://www.scrypted.app/).

> [!CAUTION]
> **Use this project at your own risk.** This is an independent, completely
> open-source project provided **as is**, without support commitments or any
> warranty of functionality, reliability, compatibility, or security. Project
> Monitor Inc. may perform security reviews of contributions and releases, but
> a review is not a certification, guarantee, endorsement, or representation
> that the software is secure. We do not vouch for this project in any way.

This repository is intended to give the community a transparent place to build
and maintain Scrypted support for Harbor devices. It is not part of the Harbor
product, is not an officially supported Harbor integration, and should not be
relied upon for safety-critical, security-critical, or availability-critical
uses.

## Project status

The integration is under community development. There is no stable release or
supported installation path yet. Until one is published, do not treat code,
configuration, issues, pull requests, or development builds in this repository
as production-ready.

## Security and privacy

Camera integrations handle sensitive video and network credentials. Before
using any release or contribution:

- review the source and configuration yourself;
- keep Scrypted and cameras on a trusted, segmented local network;
- do not expose camera, Scrypted, RTSP, WebRTC, or management ports directly to
  the internet;
- use unique credentials and the least privileges available; and
- keep Scrypted, its plugins, and the host operating system updated.

Security reviews are performed on a best-effort basis and may be incomplete.
They do not shift responsibility away from users, operators, contributors, or
downstream distributors. See [SECURITY.md](SECURITY.md) before installing or
contributing.

## Contributing

Contributions are welcome. By contributing, you agree that your contribution
is provided under the MIT License and understand that review or acceptance does
not constitute an endorsement or warranty. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Trademark and affiliation notice

Scrypted is a trademark of its respective owner. This project is not affiliated
with, endorsed by, or sponsored by Scrypted, Inc. References to Scrypted are
solely to describe interoperability.

## License and warranty disclaimer

Copyright © 2026 Project Monitor Inc. Released under the
[MIT License](LICENSE).

The MIT License permits use, copying, modification, distribution, and sale, but
the software is provided **AS IS**, **WITHOUT WARRANTY OF ANY KIND**. See the
license text for the complete terms and limitation of liability.
