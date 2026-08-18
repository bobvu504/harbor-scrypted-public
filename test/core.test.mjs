import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGo2rtcConfig,
  buildGo2rtcWhipEndpoint,
  buildWhipEndpoint,
  decodeSessionTarget,
  encodeSessionTarget,
  isGo2rtcProcessForConfig,
  normalizeGo2rtcSessionLocation,
  parseWhipUrl,
  secureTokenEqual,
  validateBridgePorts,
  validateSerial,
  validateToken,
} from '../src/core.mjs';

test('matches only the plugin-owned go2rtc configuration process', () => {
  const config = '/server/volume/plugins/@harbor-community/scrypted-harbor/files/go2rtc.json';
  assert.equal(isGo2rtcProcessForConfig(
    `/files/go2rtc-v1.9.14\0-config\0${config}\0`,
    config,
  ), true);
  assert.equal(isGo2rtcProcessForConfig(
    '/files/go2rtc-v1.9.14\0-config=/other/go2rtc.json\0',
    config,
  ), false);
  assert.equal(isGo2rtcProcessForConfig(
    `/usr/bin/node\0-config\0${config}\0`,
    config,
  ), false);
});

test('accepts a Harbor serial and rejects path/config injection', () => {
  assert.equal(validateSerial('2400000000'), '2400000000');
  assert.throws(() => validateSerial('../camera'));
  assert.throws(() => validateSerial('camera: [bad]'));
});

test('requires substantial ingest tokens and compares them safely', () => {
  const token = 'a'.repeat(64);
  assert.equal(validateToken(token), token);
  assert.equal(secureTokenEqual(token, token), true);
  assert.equal(secureTokenEqual(token, 'b'.repeat(64)), false);
  assert.equal(secureTokenEqual(token, 'short'), false);
  assert.throws(() => validateToken('too-short'));
});

test('rejects invalid or overlapping bridge listener ports', () => {
  assert.deepEqual(validateBridgePorts({
    whipPort: 11380,
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
  }), {
    whipPort: 11380,
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
  });
  assert.throws(() => validateBridgePorts({
    whipPort: 11380,
    apiPort: 11380,
    rtspPort: 18554,
    webrtcPort: 18555,
  }), /cannot both use TCP port 11380/);
  assert.throws(() => validateBridgePorts({
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 70000,
  }), /1 through 65535/);
});

test('builds isolated multi-camera bridge configuration', () => {
  const config = buildGo2rtcConfig({
    cameras: [
      { serial: '2400000000', height: 720, audio: true },
      { serial: '2400000001', height: 1080, audio: false },
    ],
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
    advertisedAddress: '192.168.1.20',
    ffmpegPath: '/usr/bin/ffmpeg',
  });

  assert.equal(config.api.listen, '127.0.0.1:11984');
  assert.equal(config.rtsp.listen, '127.0.0.1:18554');
  assert.deepEqual(config.webrtc.candidates, ['192.168.1.20:18555']);
  assert.match(config.streams['2400000000'][0], /#video=h264#audio=opus/);
  assert.match(config.streams['2400000000'][0], /scale=-2:720/);
  assert.match(config.streams['2400000001'][0], /scale=-2:1080/);
  assert.doesNotMatch(config.streams['2400000001'][0], /#audio=/);
});

// Regression: go2rtc's exec module compares argv[0] against exec.allow_paths with
// an exact string match, and argv[0] is whatever ffmpeg.bin holds. Allowing the
// bare name "ffmpeg" while pointing bin at Scrypted's absolute path made every
// transcode fail with "exec: bin not in allow_paths", which surfaced as an
// RTSP 404 that looked identical to "no publisher connected".
test('allows exactly the configured FFmpeg executable to run under go2rtc', () => {
  const ffmpegPath = '/server/volume/plugins/@scrypted/ffmpeg/files/ffmpeg';
  const config = buildGo2rtcConfig({
    cameras: [{ serial: '2400000000', height: 720, audio: true }],
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
    ffmpegPath,
  });

  assert.equal(config.ffmpeg.bin, ffmpegPath);
  assert.deepEqual(config.exec.allow_paths, [ffmpegPath]);

  assert.throws(() => buildGo2rtcConfig({
    cameras: [],
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
    ffmpegPath: '/opt/my ffmpeg/ffmpeg',
  }), /whitespace/);
});

test('keeps the go2rtc API on loopback unless the fallback is explicitly enabled', () => {
  const base = {
    cameras: [{ serial: '2400000000', height: 720, audio: true }],
    apiPort: 11984,
    rtspPort: 18554,
    webrtcPort: 18555,
    ffmpegPath: '/usr/bin/ffmpeg',
  };

  const isolated = buildGo2rtcConfig(base);
  assert.equal(isolated.api.listen, '127.0.0.1:11984');
  assert.equal(isolated.api.username, undefined);

  const exposed = buildGo2rtcConfig({
    ...base,
    exposeApi: true,
    apiUsername: 'harbor',
    apiPassword: 'c'.repeat(48),
  });
  assert.equal(exposed.api.listen, ':11984');
  assert.equal(exposed.api.username, 'harbor');
  assert.equal(exposed.api.local_auth, false);
  assert.deepEqual(exposed.api.allow_paths, ['/api/streams', '/api/webrtc']);

  assert.throws(() => buildGo2rtcConfig({ ...base, exposeApi: true }), /username and password/);
});

test('WHIP session locations are opaque and restricted to go2rtc webrtc', () => {
  const target = '/api/webrtc?src=2400000000&session=abc';
  assert.equal(decodeSessionTarget(encodeSessionTarget(target)), target);
  assert.throws(() => decodeSessionTarget(encodeSessionTarget('/api/config')));
  assert.throws(() => decodeSessionTarget(encodeSessionTarget('http://evil.example/api/webrtc')));

  // go2rtc v1.9.14 returns exactly this relative Location form.
  assert.equal(normalizeGo2rtcSessionLocation('webrtc?id=session-1234'), '/api/webrtc?id=session-1234');
  assert.equal(normalizeGo2rtcSessionLocation('/api/webrtc?id=session-1234'), '/api/webrtc?id=session-1234');
  assert.throws(() => normalizeGo2rtcSessionLocation('/webrtc?id=session-1234'));
  assert.throws(() => normalizeGo2rtcSessionLocation('http://evil.example/api/webrtc?id=session-1234'));
});

// Regression: the endpoint previously came from
// sdk.endpointManager.getLocalEndpoint(serial), which resolves to the camera
// device id. Scrypted rejects any device whose interfaces omit
// HttpRequestHandler, so Harbor's POST was answered 404 by Express and
// onRequest never ran. The endpoint now targets the plugin's own listener.
test('builds a Harbor-facing WHIP endpoint on the dedicated listener', () => {
  const token = 'd'.repeat(64);
  const endpoint = buildWhipEndpoint({
    address: '192.168.1.20',
    port: 11380,
    serial: '2400000000',
    token,
  });
  const url = new URL(endpoint);

  assert.equal(url.protocol, 'http:');
  assert.equal(url.host, '192.168.1.20:11380');
  assert.equal(url.pathname, '/whip');
  assert.equal(url.searchParams.get('dst'), '2400000000');
  assert.equal(url.searchParams.get('token'), token);
  assert.doesNotMatch(endpoint, /\/endpoint\//);

  assert.match(buildWhipEndpoint({
    address: 'fd00::1',
    port: 11380,
    serial: '2400000000',
    token,
  }), /^http:\/\/\[fd00::1\]:11380\/whip/);

  assert.throws(() => buildWhipEndpoint({ address: '', port: 11380, serial: '2400000000', token }));
});

test('routes and rejects listener requests before touching go2rtc', () => {
  const token = 'e'.repeat(64);
  const parsed = parseWhipUrl(`/whip?dst=2400000000&token=${token}`);
  assert.equal(parsed.serial, '2400000000');
  assert.equal(parsed.token, token);
  assert.equal(parsed.session, '');

  const withSession = parseWhipUrl('/whip?dst=2400000000&token=x&session=abc');
  assert.equal(withSession.session, 'abc');

  assert.throws(() => parseWhipUrl('/api/webrtc?dst=2400000000'), /Unknown WHIP path/);
  assert.throws(() => parseWhipUrl('/whip'), /Harbor serial/);
  assert.throws(() => parseWhipUrl('/whip?dst=../etc/passwd'), /Harbor serial/);
});

test('builds a credentialed direct go2rtc fallback endpoint', () => {
  const endpoint = buildGo2rtcWhipEndpoint({
    address: '192.168.1.20',
    port: 11984,
    serial: '2400000000',
    username: 'harbor',
    password: 'f'.repeat(48),
  });
  const url = new URL(endpoint);

  assert.equal(url.username, 'harbor');
  assert.equal(url.password, 'f'.repeat(48));
  assert.equal(url.pathname, '/api/webrtc');
  assert.equal(url.searchParams.get('dst'), '2400000000');
});
