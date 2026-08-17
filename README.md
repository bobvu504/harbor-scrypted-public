# Harbor for Scrypted

Community-maintained tools and documentation for connecting Harbor cameras to [Scrypted](https://www.scrypted.app/).

> [!CAUTION]
> **Use this project at your own risk.** This is an independent, completely open-source project provided **as is**, without support commitments or any warranty of functionality, reliability, compatibility, or security. Project Monitor Inc. may perform security reviews of contributions and releases, but a review is not a certification, guarantee, endorsement, or representation that the software is secure. We do not vouch for this project in any way.

This repository is intended to give the community a transparent place to build and maintain Scrypted support for Harbor devices. It is not part of the Harbor product, is not an officially supported Harbor integration, and should not be relied upon for safety-critical, security-critical, or availability-critical uses.

## Project status

The integration is under community development. There is no stable release or supported installation path yet. Until one is published, do not treat code, configuration, issues, pull requests, or development builds in this repository as production-ready.

## Harbor Camera Bridge plugin

An experimental multi-camera Scrypted provider for [Harbor cameras](https://harbor.co/). The plugin is both the Harbor bridge and the Scrypted camera provider:

```text
Harbor camera(s)
  -> authenticated WHIP/WebRTC
  -> dedicated WHIP listener run by this plugin (default port 11380)
  -> private go2rtc runtime managed by this plugin
  -> private H.264/Opus RTSP
  -> native Scrypted camera device(s)
  -> Scrypted HomeKit plugin
  -> optional per-camera ONVIF adapter(s)
  -> UniFi Protect
```

No separate macOS Harbor bridge, `socat` relay, or manually created RTSP Camera device is required.

## What it does

- Adds any number of Harbor cameras under one provider.
- Generates an independent 256-bit ingest token and WHIP URL for every camera.
- Accepts only authenticated `POST`, `PATCH`, and `DELETE` requests for configured serials.
- Keeps the shared go2rtc API and RTSP listener on loopback only.
- Uses the Harbor-published FFmpeg profile to convert the camera's H.265 video to HomeKit-friendly H.264.
- Exposes H.264 video and optional 16 kHz mono Opus audio through Scrypted's `VideoCamera` API.
- Downloads and supervises a pinned go2rtc runtime on Linux x64/arm64, or accepts a local go2rtc executable path.
- Optionally runs one isolated, credentialed ONVIF/RTSP adapter per camera for native UniFi Protect adoption.
- Copies the existing H.264 track and converts Harbor Opus audio to AAC for Protect without running a second video transcode.

Source, issues, and pull requests: [Harbor-Systems/harbor-scrypted-public](https://github.com/Harbor-Systems/harbor-scrypted-public)

### Implementation status

Harbor WHIP ingest and Scrypted live video have been tested with physical Harbor hardware. HomeKit uses Scrypted's standard camera integration. The UniFi Protect adapter is experimental and has not yet been verified end to end for adoption, live view, and recording on every Protect release.

## Requirements

- Scrypted running on Linux x64 or arm64. Proxmox LXC and Linux host-network Docker are the intended targets.
- The Scrypted host and Harbor cameras on a trusted LAN with no client isolation between them.
- Scrypted host networking, or explicit forwarding for the WHIP listener port (default `11380`, TCP) and the WebRTC media port (default `18555`, TCP **and** UDP).
- Internet access for the plugin's one-time download of pinned go2rtc `v1.9.14`, or a preinstalled go2rtc executable.
- FFmpeg with `libx264`; the plugin uses Scrypted's FFmpeg path.
- A reserved DHCP address for the Scrypted host.
- For UniFi Protect: one additional IPv4 address per camera assigned to the Scrypted host. Distinct MAC addresses are strongly recommended.

Do not forward Scrypted, go2rtc, port `11380`, or port `18555` from the internet. The bridge is intended only for a trusted home LAN.

## Install the project

This repository is a Scrypted TypeScript plugin project, based on Scrypted's current plugin toolchain.

1. Install Node.js 20 or newer on the computer where you will build the plugin.
2. Extract this project and open a terminal in its directory.
3. Install and build:

   ```bash
   npm ci
   npm run verify
   ```

   A successful build includes `Scrypted 0.143 SDK injection, provider startup, and camera creation passed.` This smoke check protects against both the SDK-loader failure that appears as an unavailable `Unknown Device` and the device-storage failure seen while adding a camera. Restricted build sandboxes may skip the optional local-socket WHIP round trip.

4. Deploy it to Scrypted, replacing the address with your Scrypted server:

   ```bash
   npm run scrypted-deploy -- 192.168.1.20
   ```

   The first deployment may ask you to sign in with `npx scrypted login`.

5. Open the **Harbor Camera Bridge** plugin in Scrypted. Confirm **Bridge Status** becomes `Running`. On first start, it downloads go2rtc from the fixed upstream `v1.9.14` release URL and records the downloaded SHA-256 digest in the plugin console.

If the Scrypted host cannot download GitHub release assets, install go2rtc yourself and set **go2rtc Executable** to its absolute path in the provider settings.

## Add the first Harbor camera

1. In Scrypted, open **Harbor Camera Bridge** and select **Add New** / **Create Device**.
2. Enter:
   - Name: for example `Nursery Harbor`
   - Harbor Serial: `2400000000`
   - Token: leave blank to generate a secure random token
   - Transcode Height: `720` (recommended)
   - Expose Audio: enabled
3. Open the newly created camera's settings.
4. Copy the entire **Harbor WHIP Endpoint**. It points at the plugin's own listener, not a Scrypted `/endpoint/...` URL, and looks like `http://192.168.1.20:11380/whip?dst=2400000000&token=<secret>`.
5. Paste that endpoint into the Harbor app's WHIP publisher setting. The `dst` value must exactly match the serial.
6. Start the Harbor camera stream and open the camera in Scrypted.

The old paths from the macOS bridge are no longer used:

```text
rtsp://127.0.0.1:8554/2400000000
rtsp://192.168.1.10:8556/2400000000
```

The provider now hands Scrypted a private loopback stream such as:

```text
rtsp://127.0.0.1:18554/2400000000
```

You do not need to enter that RTSP URL anywhere.

## Add more cameras

Repeat **Add New** for each camera. Every camera must have a unique Harbor serial. The provider creates a separate stream and ingest token for each serial while continuing to use the same supervised bridge process and WebRTC media port.

Changing a camera's resolution or audio setting rebuilds the shared bridge configuration and briefly restarts all Harbor streams. Changing or regenerating a token does not restart the bridge, but the corresponding Harbor app publisher URL must be updated.

## HomeKit

1. Install Scrypted's **HomeKit** plugin.
2. Install/enable the **Snapshot** and **Rebroadcast/Prebuffer** mixins when Scrypted recommends them. They are declared as plugin dependencies.
3. Open each Harbor camera in Scrypted and enable the HomeKit extension/mixin.
4. Pair each camera using the QR code shown on that camera's Scrypted page. Scrypted normally exposes cameras as standalone HomeKit accessories.

The plugin provides live video and audio. Harbor does not currently provide a motion-event API to this plugin. For HomeKit Secure Video recordings and motion notifications, add a Scrypted motion/object-detection mixin (for example the motion detection option recommended by your Scrypted installation).

## UniFi Protect

Version `0.1.7` can present each Harbor camera as a separate ONVIF camera to UniFi Protect. It uses go2rtc `v1.9.14`, which contains specific UniFi Protect ONVIF fixes. Version `0.1.7` also separates direct H.264 video from the audio-only AAC conversion, avoiding the loopback RTSP conflict that caused authenticated `DESCRIBE` requests to return `404` in version `0.1.6`.

Protect treats one ONVIF server as one camera. Consequently, every Harbor camera needs a dedicated IPv4 address. The plugin binds the same standard ports (`1984` for ONVIF and `8554` for RTSP) on each camera-specific address and launches a separate go2rtc child containing only that camera.

### Assign dedicated addresses first

Reserve unused addresses on the same network as Protect. Example only:

```text
Scrypted/Harbor bridge: 192.168.1.20
Harbor 2400000000:      192.168.1.21
Second Harbor camera:   192.168.1.22
```

Do not use these example addresses until you have confirmed they are unused.

For a Proxmox LXC, the most reliable arrangement is one additional virtual network interface per camera, on the same Proxmox bridge and VLAN as the existing Scrypted interface. Give each interface its own static IP and locally administered MAC. Add no additional default gateways. This can be done from **LXC → Resources/Network → Add** in Proxmox. When several interfaces occupy the same IPv4 subnet, configure Linux ARP behavior so each address answers on its assigned interface:

```text
net.ipv4.conf.all.arp_ignore=1
net.ipv4.conf.all.arp_announce=2
```

Apply those values using the Linux network/sysctl configuration appropriate for the Scrypted container, then verify the addresses inside the container with `ip -br address`. Do not proceed until each address is visible on the Scrypted host.

### Enable one adapter per camera

1. Open a Harbor camera in Scrypted and expand **UniFi Protect**.
2. Enter that camera's **Dedicated ONVIF IPv4 Address**.
3. Leave **ONVIF Port** at `1984` and **Protect RTSP Port** at `8554`.
4. Leave **Require ONVIF/RTSP Password** enabled.
5. Choose an **ONVIF Username** and a password of at least 12 characters, or keep the generated 192-bit password.
6. Enable **UniFi Protect Adapter**.
7. Confirm **UniFi Protect Status** becomes `Ready at <address>:1984`.
8. Repeat with a different address for every additional Harbor camera.

The password field is masked in Scrypted. Reveal/copy it from the camera settings and enter the same username and password during Protect adoption. The generated adapter configuration is written with owner-only file permissions. Disabling the adapter stops its process and removes that generated runtime file.

### Adopt in Protect

1. In UniFi Protect, open **Settings → System** and enable **Discover Third-Party Cameras**.
2. If a camera is not discovered automatically, open **Help → Advanced Adoption**.
3. Enter the camera's **Protect Advanced Adoption Address**, for example `192.168.1.21:1984`.
4. Enter the matching ONVIF username and password from Scrypted.
5. Adopt the second camera using its own address.

Allow the Protect console/UNVR to reach each dedicated address on TCP `1984` and TCP `8554`. Do not expose either port to the internet. If Protect cannot adopt while authentication is enabled, temporarily disable **Require ONVIF/RTSP Password**, adopt with placeholder credentials, and restrict both ports at the firewall to the Protect console. A password entered only in Protect does not secure an adapter whose authentication toggle is off.

Live view, playback, and continuous recording are the initial target. The adapter does not currently forward Scrypted/OpenCV motion events as ONVIF events, so Protect motion and smart detections require additional event support or compatible UniFi AI hardware.

## Provider settings

- **Scrypted LAN Address**: Set this explicitly if Scrypted has multiple interfaces or advertises the wrong address. Use the reserved LAN address of the Scrypted host, not an address belonging to an older bridge computer.
- **WHIP Listener Port**: `11380` by default. The plugin binds this port itself and serves `/whip`. It must be reachable from the camera VLAN over TCP.
- **WebRTC Media Port**: `18555` by default, listening on TCP and UDP for encrypted WebRTC media from Harbor.
- **go2rtc API Port**: `11984`, loopback only unless the WHIP fallback below is enabled.
- **Expose go2rtc WHIP Fallback** (Advanced): Diagnostic only. Binds the go2rtc API to the LAN behind a shared username/password so Harbor can publish straight to go2rtc, bypassing this plugin's proxy. Each camera page then shows a **go2rtc WHIP Fallback Endpoint**. The credential is shared by every camera on the bridge and `/api/streams` also becomes LAN-reachable, so leave this off in normal operation.
- **Private RTSP Port**: `18554`, loopback only.
- **go2rtc Executable**: Optional absolute path. Blank means managed automatic installation on Linux x64/arm64.

## Troubleshooting

### Scrypted reports `Unknown Device` or `failed to load sdk module`

Use plugin version `0.1.2` or newer. From the project directory, run `npm ci`, `npm run verify`, and then deploy again. Version `0.1.1` pins the tested Scrypted SDK and verifies the Scrypted `0.143.0` runtime injection during every build. Version `0.1.2` also verifies that each camera is discovered before its Scrypted storage is accessed.

### Scrypted reports `Cannot read properties of undefined (reading 'storage')`

Deploy version `0.1.2` or newer. Earlier versions asked Scrypted for a new camera's storage before the camera was registered. Version `0.1.2` discovers the camera first and has a build-time regression check for that exact ordering.

### Harbor gets a 404 and the camera page stays black on version `0.1.3`

Deploy version `0.1.5` or newer. Version `0.1.3` had two independent defects that both produced this symptom.

The WHIP URL resolved to the camera device's Scrypted endpoint, and Scrypted rejects any device whose interfaces omit `HttpRequestHandler`, so Harbor's request was answered `404` by Scrypted before the plugin saw it. Separately, Scrypted parses endpoint bodies as `text/plain`, so an `application/sdp` offer would have reached go2rtc as the literal string `{}`. Version `0.1.4` moved WHIP to a dedicated listener. Version `0.1.5` additionally handles go2rtc `v1.9.14`'s real relative session `Location` value (`webrtc?id=...`) so publisher teardown works and a successful publish is not rejected as a bad upstream response.

Version `0.1.3` also set go2rtc's `exec.allow_paths` to the bare string `ffmpeg` while pointing `ffmpeg.bin` at Scrypted's absolute FFmpeg path. go2rtc compares those with an exact string match, so every transcode failed with `exec: bin not in allow_paths`, which surfaced as the same RTSP `404`.

### go2rtc reports `bind: address already in use`

Deploy version `0.1.3` or newer. A go2rtc child from an earlier plugin worker could survive a plugin reload and retain ports `11984` and `18554`. Version `0.1.3` identifies and stops only a go2rtc process using this plugin's exact configuration path before starting the replacement. It also refuses to mark the bridge as running when the newly started process reports a port bind failure.

### Bridge Status shows a download error

Set **go2rtc Executable** to a local go2rtc `v1.9.14` binary. The service user that runs Scrypted must have execute permission.

### The Harbor camera cannot publish

- Confirm the WHIP URL uses the current token and exact serial.
- Reserve the Scrypted host's LAN address in the router.
- Set **Scrypted LAN Address** explicitly.
- Confirm **WHIP Listener Status** on the provider page reads `Listening on 0.0.0.0:11380`.
- Ensure TCP `11380` and TCP/UDP `18555` can travel from the camera VLAN to Scrypted.
- Watch the Harbor Camera Bridge console for `WHIP POST <serial> -> go2rtc <status>`. If that line never appears, Harbor is not reaching the listener at all, which is a network or Harbor-configuration problem.
- If Scrypted runs in Docker, use host networking or map `11380:11380/tcp`, `18555:18555/tcp`, and `18555:18555/udp`, and make sure the advertised address is the Docker host.
- Do not point Harbor at the private go2rtc API port unless you deliberately enabled the WHIP fallback; otherwise use the URL generated on the Scrypted camera page.

### Scrypted shows no video

- Check the Harbor Camera Bridge console for a successful WHIP request and go2rtc/FFmpeg messages.
- Confirm the Harbor camera is actively publishing before opening the stream.
- Verify Scrypted's FFmpeg includes `libx264`.
- Start at 720p. Each active camera can require a substantial CPU core while transcoding H.265 to H.264.

### HomeKit live view works but recording does not

Add a motion or object-detection mixin. This plugin has no Harbor-native motion event feed, and HomeKit Secure Video normally needs motion events to trigger recordings.

### UniFi Protect adapter reports `Unable to bind`

- Confirm the dedicated IP is assigned to the Scrypted host with `ip -br address`.
- Confirm no other service is using TCP `1984` or `8554` on that address.
- Do not reuse one address for two cameras; the plugin rejects duplicates.
- If multiple interfaces share a subnet, verify the ARP settings in the UniFi Protect section above.

### Protect finds one camera but not the second

Each camera needs its own ONVIF process and dedicated IP. Different ports on a single address are not the supported multi-camera layout. Confirm Protect can resolve each IP to the intended distinct MAC address, then use Advanced Adoption with `<camera-ip>:1984`.

### Protect authentication fails

go2rtc enforces HTTP Basic authentication on ONVIF and standard RTSP authentication when **Require ONVIF/RTSP Password** is enabled. Some Protect releases or adoption paths may expect a different ONVIF authentication mode. As a compatibility test, turn the toggle off, restart the bridge, and adopt using placeholder values. If that works, leave access limited by firewall to the Protect console rather than assuming the placeholder password is enforced.

## Security design

- Each camera receives its own random 32-byte token.
- Tokens are compared with a timing-safe comparison.
- Serials are restricted before they are used as stream/config keys.
- The WHIP listener accepts only `POST`, `PATCH`, `DELETE`, and `OPTIONS` on the single `/whip` path; everything else is rejected before any token or upstream work.
- Follow-up WHIP session URLs are opaque and constrained to go2rtc's `/api/webrtc` path.
- Request bodies are capped at 256 KiB and the connection is destroyed once the cap is exceeded.
- go2rtc's API and RTSP ports bind to `127.0.0.1` unless the diagnostic WHIP fallback is explicitly enabled, in which case the API requires a generated username and password for non-loopback callers.
- The go2rtc configuration loads only the API, RTSP, WebRTC, exec, and FFmpeg modules, restricts API paths, and restricts `exec.allow_paths` to the exact FFmpeg executable Scrypted provides.
- Each Protect adapter exposes only `/api`, `/api/frame.jpeg`, and `/onvif/` on its HTTP listener; configuration mutation, restart, logs, WebRTC, and the WebUI are not registered.
- Protect credentials are stored in Scrypted device storage and in a generated owner-only (`0600`) runtime configuration. They are never included in build artifacts.
- Every Protect adapter contains exactly one camera stream. Password authentication can be disabled only as an explicit compatibility setting.
- The managed runtime download is pinned to a fixed upstream release. Its SHA-256 is logged after download; production maintainers should additionally publish and enforce an architecture-specific checksum allowlist.

Treat every complete WHIP endpoint as a password. Regenerate its token if it is exposed.

## Current limitations

- Harbor ingest and Scrypted live video are hardware-tested; UniFi Protect compatibility remains experimental.
- Automatic go2rtc installation supports Linux x64 and arm64 only.
- Updating any stream-transcode setting briefly restarts every Harbor camera because they share one bridge runtime.
- No Harbor-native motion, privacy-mode, talkback, night-light, or status controls.
- Protect adapters do not yet emit ONVIF motion/smart-detection events or provide PTZ/talkback.
- UniFi Protect output requires one host-owned IPv4 address per camera; the plugin does not create network interfaces or choose addresses automatically.
- No bundled go2rtc checksum allowlist yet; see the security note above.
- One H.265→H.264 FFmpeg transcode runs per actively consumed camera stream.

## Development

Run the pure configuration and security tests with:

```bash
npm test
```

Build and deploy with the same `scrypted-webpack` / `scrypted-deploy` workflow used by Scrypted's official TypeScript plugin template.

## Repository security and privacy

Camera integrations handle sensitive video and network credentials. Before using any release or contribution:

- review the source and configuration yourself;
- keep Scrypted and cameras on a trusted, segmented local network;
- do not expose camera, Scrypted, RTSP, WebRTC, or management ports directly to the internet;
- use unique credentials and the least privileges available; and
- keep Scrypted, its plugins, and the host operating system updated.

Security reviews are performed on a best-effort basis and may be incomplete. They do not shift responsibility away from users, operators, contributors, or downstream distributors. See [SECURITY.md](SECURITY.md) before installing or contributing.

## Contributing

Contributions are welcome. By contributing, you agree that your contribution is provided under the MIT License and understand that review or acceptance does not constitute an endorsement or warranty. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Trademark and affiliation notice

Scrypted is a trademark of its respective owner. This project is not affiliated with, endorsed by, or sponsored by Scrypted, Inc. References to Scrypted are solely to describe interoperability.

## License and warranty disclaimer

Copyright © 2026 Project Monitor Inc. Released under the [MIT License](LICENSE).

The MIT License permits use, copying, modification, distribution, and sale, but the software is provided **AS IS**, **WITHOUT WARRANTY OF ANY KIND**. See the license text for the complete terms and limitation of liability.

## Source references

- [Harbor HomeKit public bridge](https://github.com/Harbor-Systems/harbor-homekit-public)
- [Harbor's published go2rtc configuration](https://github.com/Harbor-Systems/harbor-homekit-public/blob/main/go2rtc.yaml)
- [Scrypted TypeScript plugin template](https://github.com/koush/scrypted-vscode-typescript)
- [Scrypted RTSP plugin implementation](https://github.com/koush/scrypted/tree/main/plugins/rtsp)
- [go2rtc WHIP ingest documentation](https://go2rtc.org/internal/webrtc/)
- [UniFi Protect third-party camera guide](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect)
- [go2rtc ONVIF server](https://github.com/AlexxIT/go2rtc/tree/v1.9.14/internal/onvif)
