# Changelog

## 0.1.8

- Removed the experimental UniFi Protect/ONVIF adapter and all related camera settings.
- Removed the extra per-camera go2rtc processes, dedicated-IP listeners, credentials, validation, and documentation.
- Added upgrade cleanup for legacy adapter processes, generated configuration files, and stored adapter credentials.
- Added distinct-port validation and TCP/UDP availability probes with listener-specific bind-conflict errors.

## 0.1.7

- Fixed authenticated Protect RTSP streams returning `404 Not Found` when audio was enabled.
- Split Protect media into direct H.264 video and an audio-only Opus-to-AAC pipe so isolated adapters no longer require an unavailable loopback RTSP listener.
- Preserved AAC audio without adding a second video transcode.

## 0.1.6

- Added an optional, independently supervised go2rtc ONVIF adapter for each Harbor camera.
- Added per-camera dedicated IPv4 address, ONVIF/RTSP port, username, generated password, authentication toggle, adoption target, and runtime status settings.
- Added H.264 passthrough with Opus-to-AAC audio conversion for UniFi Protect.
- Restricted each adapter HTTP surface to ONVIF, snapshots, and an authenticated health endpoint.
- Added duplicate-address, credential, port, and one-camera-per-adapter validation.
- Added UniFi Protect and Proxmox multi-address setup documentation.

## 0.1.5

- Correctly normalized go2rtc `v1.9.14` relative WHIP session locations such as `webrtc?id=...`.
- Allowed the exact absolute Scrypted FFmpeg executable in go2rtc instead of the unusable bare `ffmpeg` path.
- Added end-to-end WHIP publish/teardown smoke coverage.

## 0.1.4

- Replaced the unusable Scrypted HTTP endpoint path with a dedicated raw-SDP WHIP listener.
- Added per-camera token enforcement and safe WHIP session URL rewriting.

## 0.1.3

- Added stale go2rtc process detection and targeted cleanup by exact configuration path.
- Added stronger startup port-conflict detection and multi-camera configuration tests.
- This snapshot still contained WHIP routing and FFmpeg allow-path defects corrected in later releases.

## 0.1.2

- Fixed camera creation ordering so Scrypted discovers a device before its storage is accessed.
- Expanded the Scrypted `0.143` runtime smoke test.

## 0.1.1

- Pinned the tested Scrypted SDK and added the SDK loader compatibility fix.
- Added build-time runtime-injection verification.

## 0.1.0

- Initial experimental multi-camera Harbor WHIP bridge and Scrypted camera provider.
