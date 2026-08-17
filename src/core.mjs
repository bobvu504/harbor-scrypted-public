import { timingSafeEqual } from 'node:crypto';

const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/;
const PROTECT_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Path served by the plugin's dedicated WHIP listener.
 *
 * The Scrypted HTTP endpoint layer cannot be used for WHIP. PluginHttp installs
 * `bodyParser.text()` with no options, so its type is `text/plain`; an
 * `application/sdp` body is never parsed, body-parser still assigns
 * `req.body = {}`, and the server forwards `JSON.stringify(req.body)`. The SDP
 * offer would arrive at go2rtc as the literal string `{}`.
 */
export const WHIP_PATH = '/whip';

export function validateSerial(value) {
  const serial = String(value ?? '').trim();
  if (!SERIAL_PATTERN.test(serial))
    throw new Error('Harbor serial must be 6-32 letters, numbers, underscores, or dashes.');
  return serial;
}

export function validateToken(value) {
  const token = String(value ?? '').trim();
  if (token.length < 32 || token.length > 256)
    throw new Error('Ingest token must contain 32-256 characters.');
  return token;
}

export function validateProtectAddress(value) {
  const address = String(value ?? '').trim();
  const octets = address.split('.');
  if (octets.length !== 4
      || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
    throw new Error('UniFi Protect address must be a dedicated IPv4 address assigned to this host.');
  }

  const first = Number(octets[0]);
  const last = Number(octets[3]);
  if (first === 0 || first === 127 || first >= 224 || (first === 255 && last === 255))
    throw new Error('UniFi Protect address must be a usable unicast IPv4 address.');
  return octets.map(Number).join('.');
}

export function validateProtectUsername(value) {
  const username = String(value ?? '').trim();
  if (!PROTECT_USERNAME_PATTERN.test(username))
    throw new Error('ONVIF username must contain 1-64 letters, numbers, dots, underscores, or dashes.');
  return username;
}

export function validateProtectPassword(value) {
  const password = String(value ?? '');
  if (password.length < 12 || password.length > 128 || /[\u0000-\u001f\u007f]/.test(password))
    throw new Error('ONVIF password must contain 12-128 characters and no control characters.');
  return password;
}

export function secureTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  if (actualBuffer.length !== expectedBuffer.length)
    return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parsePort(value, fallback) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return fallback;
  return port;
}

export function isGo2rtcProcessForConfig(cmdline, configPath) {
  const args = String(cmdline ?? '').split('\0').filter(Boolean);
  const executable = (args[0] || '').split('/').pop()?.toLowerCase() || '';
  if (!executable.includes('go2rtc'))
    return false;
  return args.some((arg, index) => {
    if (arg === '-config' || arg === '--config')
      return args[index + 1] === configPath;
    return arg === `-config=${configPath}` || arg === `--config=${configPath}`;
  });
}

export function buildGo2rtcConfig(options) {
  const {
    cameras,
    apiPort,
    rtspPort,
    webrtcPort,
    advertisedAddress,
    ffmpegPath,
    exposeApi = false,
    apiUsername = '',
    apiPassword = '',
  } = options;

  // go2rtc's exec module compares the resolved binary against `exec.allow_paths`
  // using an exact string match on argv[0]:
  //   if allowPaths != nil && !slices.Contains(allowPaths, cmd.Args[0])
  // argv[0] is whatever `ffmpeg.bin` is set to. Scrypted hands us an absolute
  // path, so allow_paths must contain that same absolute path, not "ffmpeg".
  const bin = String(ffmpegPath ?? '').trim();
  if (!bin)
    throw new Error('An FFmpeg executable path is required.');
  if (/\s/.test(bin))
    throw new Error(`go2rtc cannot execute an FFmpeg path containing whitespace: ${bin}`);

  const streams = {};
  for (const camera of cameras) {
    const serial = validateSerial(camera.serial);
    const height = [360, 720, 1080].includes(Number(camera.height))
      ? Number(camera.height)
      : 720;
    const audio = camera.audio === false ? '' : '#audio=opus';
    streams[serial] = [
      `ffmpeg:${serial}#video=h264${audio}#raw=-vf scale=-2:${height},setpts=(RTCTIME-RTCSTART)/(TB*1000000) -bsf:v dump_extra=freq=keyframe -x264-params sliced-threads=0${camera.audio === false ? '' : ' -ar 16000 -ac 1 -b:a 24k'}`,
    ];
  }

  const webrtc = {
    listen: `:${webrtcPort}`,
  };
  if (advertisedAddress)
    webrtc.candidates = [`${advertisedAddress}:${webrtcPort}`];

  const api = {
    listen: exposeApi ? `:${apiPort}` : `127.0.0.1:${apiPort}`,
    allow_paths: ['/api/streams', '/api/webrtc'],
  };
  if (exposeApi) {
    if (!apiUsername || !apiPassword)
      throw new Error('Exposing the go2rtc WHIP fallback requires a username and password.');
    api.username = apiUsername;
    api.password = apiPassword;
    // Loopback keeps bypassing auth, so the plugin's own proxy is unaffected.
    api.local_auth = false;
  }

  return {
    app: {
      modules: ['api', 'rtsp', 'webrtc', 'exec', 'ffmpeg'],
    },
    api,
    rtsp: {
      listen: `127.0.0.1:${rtspPort}`,
    },
    webrtc,
    exec: {
      allow_paths: [bin],
    },
    ffmpeg: {
      bin,
      h264: '-c:v libx264 -g 50 -profile:v main -level:v 4.0 -preset:v superfast -tune:v zerolatency -pix_fmt:v yuv420p',
    },
    streams,
  };
}

/**
 * Build one isolated ONVIF server for one Harbor camera. UniFi Protect treats
 * each ONVIF server as a camera and needs a distinct IP (and preferably MAC)
 * for every instance, so this must never contain multiple stream names.
 */
export function buildProtectGo2rtcConfig(options) {
  const {
    serial: rawSerial,
    address: rawAddress,
    apiPort: rawApiPort,
    rtspPort: rawRtspPort,
    sourceRtspPort: rawSourceRtspPort,
    audio = true,
    requireAuth = true,
    username: rawUsername = '',
    password: rawPassword = '',
    ffmpegPath,
  } = options;

  const serial = validateSerial(rawSerial);
  const address = validateProtectAddress(rawAddress);
  const apiPort = parsePort(rawApiPort, -1);
  const rtspPort = parsePort(rawRtspPort, -1);
  const sourceRtspPort = parsePort(rawSourceRtspPort, -1);
  if ([apiPort, rtspPort, sourceRtspPort].includes(-1))
    throw new Error('ONVIF, RTSP, and source RTSP ports must be valid TCP ports.');
  if (apiPort === rtspPort)
    throw new Error('ONVIF and RTSP listeners cannot use the same port on one address.');

  const bin = String(ffmpegPath ?? '').trim();
  if (!bin)
    throw new Error('An FFmpeg executable path is required.');
  if (/\s/.test(bin))
    throw new Error(`go2rtc cannot execute an FFmpeg path containing whitespace: ${bin}`);

  const username = requireAuth ? validateProtectUsername(rawUsername) : '';
  const password = requireAuth ? validateProtectPassword(rawPassword) : '';
  const source = `rtsp://127.0.0.1:${sourceRtspPort}/${encodeURIComponent(serial)}`;

  const api = {
    listen: `${address}:${apiPort}`,
    // Keep mutation, restart, logs, WebRTC, and the WebUI unreachable. Protect
    // needs only device services, the generated snapshot URI, and a small
    // authenticated health endpoint used by the plugin.
    allow_paths: ['/api', '/api/frame.jpeg', '/onvif/'],
  };
  const rtsp = {
    listen: `${address}:${rtspPort}`,
    default_query: audio ? 'mp4' : 'video=h264',
  };
  if (requireAuth) {
    api.username = username;
    api.password = password;
    api.local_auth = false;
    rtsp.username = username;
    rtsp.password = password;
  }

  return {
    app: {
      modules: ['api', 'rtsp', 'onvif', 'mjpeg', 'exec', 'ffmpeg'],
    },
    api,
    rtsp,
    exec: {
      allow_paths: [bin],
    },
    ffmpeg: {
      bin,
    },
    streams: {
      // Keep video and audio as separate producers. A combined FFmpeg RTSP
      // producer sends its output to 127.0.0.1:<rtspPort>, but this isolated
      // adapter listens only on its dedicated Protect address. The direct
      // source copies H.264 without another encode, while audio-only AAC uses
      // go2rtc's ADTS pipe output and therefore does not need a loopback RTSP
      // listener.
      [serial]: audio
        ? [
          `${source}#media=video`,
          `ffmpeg:${source}#audio=aac`,
        ]
        : [`${source}#media=video`],
    },
  };
}

export function encodeSessionTarget(pathAndQuery) {
  return Buffer.from(pathAndQuery).toString('base64url');
}

export function decodeSessionTarget(encoded) {
  if (!encoded)
    throw new Error('Missing WHIP session.');
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const parsed = new URL(decoded, 'http://127.0.0.1');
  if (parsed.origin !== 'http://127.0.0.1' || parsed.pathname !== '/api/webrtc')
    throw new Error('Invalid WHIP session.');
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Normalize the WHIP session Location returned by go2rtc.
 *
 * go2rtc v1.9.14 returns a relative value such as `webrtc?id=...` from a
 * request to `/api/webrtc`. Resolve against that request path, not the origin
 * root, or the result incorrectly becomes `/webrtc` and is rejected.
 */
export function normalizeGo2rtcSessionLocation(location) {
  const parsed = new URL(String(location ?? ''), 'http://127.0.0.1/api/webrtc');
  if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/api/webrtc')
    throw new Error('Invalid go2rtc WHIP session location.');
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Parse a request against the plugin's dedicated WHIP listener. Throws on any
 * unexpected path or malformed serial so the caller can answer 404/400 without
 * leaking which part of the request was wrong.
 */
export function parseWhipUrl(rawUrl) {
  const parsed = new URL(String(rawUrl ?? '/'), 'http://harbor.invalid');
  if (parsed.pathname !== WHIP_PATH)
    throw new Error('Unknown WHIP path.');
  return {
    serial: validateSerial(parsed.searchParams.get('dst')),
    token: parsed.searchParams.get('token') || '',
    session: parsed.searchParams.get('session') || '',
  };
}

export function buildWhipEndpoint(options) {
  const { address, port, serial, token, session } = options;
  const url = new URL(`http://${formatHost(address)}:${port}${WHIP_PATH}`);
  url.searchParams.set('dst', validateSerial(serial));
  url.searchParams.set('token', String(token ?? ''));
  if (session)
    url.searchParams.set('session', session);
  return url.toString();
}

/**
 * Fallback endpoint that bypasses the plugin proxy entirely and points Harbor at
 * go2rtc's own WHIP handler. Useful for isolating proxy bugs, but the credential
 * is shared across every camera on this bridge.
 */
export function buildGo2rtcWhipEndpoint(options) {
  const { address, port, serial, username, password } = options;
  const url = new URL(`http://${formatHost(address)}:${port}/api/webrtc`);
  url.username = String(username ?? '');
  url.password = String(password ?? '');
  url.searchParams.set('dst', validateSerial(serial));
  return url.toString();
}

function formatHost(address) {
  const host = String(address ?? '').trim();
  if (!host)
    throw new Error('A Scrypted LAN address is required to build a WHIP endpoint.');
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
