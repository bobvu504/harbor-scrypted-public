import sdk, {
  Device,
  DeviceCreator,
  DeviceCreatorSettings,
  DeviceProvider,
  HttpRequest,
  HttpRequestHandler,
  HttpResponse,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedSystemDevice,
  ScryptedSystemDeviceInfo,
  Setting,
  SettingValue,
  Settings,
} from '@scrypted/sdk';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  buildGo2rtcConfig,
  buildGo2rtcWhipEndpoint,
  buildWhipEndpoint,
  decodeSessionTarget,
  encodeSessionTarget,
  isGo2rtcProcessForConfig,
  normalizeGo2rtcSessionLocation,
  parsePort,
  parseWhipUrl,
  secureTokenEqual,
  validateBridgePorts,
  validateSerial,
  validateToken,
} from './core.mjs';
import { HarborCamera } from './harbor-camera';

const GO2RTC_VERSION = 'v1.9.14';
const MAX_RUNTIME_BYTES = 100 * 1024 * 1024;
const MAX_WHIP_BODY_BYTES = 256 * 1024;
const GO2RTC_API_USERNAME = 'harbor';
const LEGACY_CAMERA_SETTINGS = [
  'protectAddress',
  'protectApiPort',
  'protectEnabled',
  'protectPassword',
  'protectRequireAuth',
  'protectRtspPort',
  'protectUsername',
] as const;

interface CameraConfig {
  serial: string;
  height: number;
  audio: boolean;
}

export default class HarborCameraProvider extends ScryptedDeviceBase
  implements DeviceProvider, DeviceCreator, Settings, HttpRequestHandler, ScryptedSystemDevice {
  readonly systemDevice: ScryptedSystemDeviceInfo = {
    deviceCreator: 'Harbor Camera',
    settings: 'Harbor Bridge',
  };

  private readonly devices = new Map<string, HarborCamera>();
  private readonly nativeIds = new Set<string>();
  private go2rtc?: ChildProcess;
  private whipServer?: Server;
  private whipServerPort?: number;
  private restartChain: Promise<void> = Promise.resolve();
  private respawnTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  bridgeStatus = 'Starting';
  whipStatus = 'Stopped';

  constructor(nativeId?: string) {
    super(nativeId);
    process.once('exit', () => {
      this.go2rtc?.kill('SIGTERM');
      this.whipServer?.close();
    });
    for (const id of sdk.deviceManager.getNativeIds()) {
      if (id) {
        this.nativeIds.add(id);
        const storage = sdk.deviceManager.getDeviceStorage(id);
        for (const key of LEGACY_CAMERA_SETTINGS)
          storage.removeItem(key);
      }
    }
    this.restartBridge().catch(error => this.setBridgeStatus(`Error: ${error.message}`));
  }

  generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  isBridgeReady(): boolean {
    return this.bridgeStatus === 'Running';
  }

  private setBridgeStatus(status: string): void {
    this.bridgeStatus = status;
    for (const camera of this.devices.values()) {
      camera.online = status === 'Running';
      camera.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => undefined);
    }
    this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => undefined);
  }

  private get apiPort(): number {
    return parsePort(this.storage.getItem('apiPort'), 11984);
  }

  private get rtspPort(): number {
    return parsePort(this.storage.getItem('rtspPort'), 18554);
  }

  private get webrtcPort(): number {
    return parsePort(this.storage.getItem('webrtcPort'), 18555);
  }

  private get whipPort(): number {
    return parsePort(this.storage.getItem('whipPort'), 11380);
  }

  get exposeGo2rtcWhip(): boolean {
    return this.storage.getItem('exposeGo2rtcWhip') === 'true';
  }

  private get go2rtcApiPassword(): string {
    let password = this.storage.getItem('go2rtcApiPassword');
    if (!password) {
      password = randomBytes(24).toString('hex');
      this.storage.setItem('go2rtcApiPassword', password);
    }
    return password;
  }

  private get cameraConfigs(): CameraConfig[] {
    return [...this.nativeIds].sort().map(serial => {
      const storage = sdk.deviceManager.getDeviceStorage(serial);
      const height = Number(storage.getItem('height'));
      return {
        serial,
        height: [360, 720, 1080].includes(height) ? height : 720,
        audio: storage.getItem('audio') !== 'false',
      };
    });
  }

  getRtspUrl(serial: string): string {
    return `rtsp://127.0.0.1:${this.rtspPort}/${encodeURIComponent(serial)}`;
  }

  /**
   * The Harbor-facing WHIP URL.
   *
   * This deliberately does NOT use `sdk.endpointManager.getLocalEndpoint`. Two
   * properties of the Scrypted HTTP endpoint layer make it unusable for WHIP:
   *
   * 1. `getLocalEndpoint(nativeId)` resolves to the *device* id, and
   *    `ScryptedRuntime.getEndpointPluginData` rejects any device whose
   *    interface list omits `HttpRequestHandler`. Harbor cameras are
   *    `VideoCamera`/`Settings`/`Online` devices, so every request answered 404
   *    before `onRequest` was ever called.
   * 2. `PluginHttp.addMiddleware` installs `bodyParser.text()` (type
   *    `text/plain`). An `application/sdp` body is skipped, body-parser still
   *    sets `req.body = {}`, and the server forwards `JSON.stringify(req.body)`.
   *    The SDP offer would reach go2rtc as the literal string `{}`.
   */
  async getWhipEndpoint(serial: string): Promise<string> {
    const storage = sdk.deviceManager.getDeviceStorage(serial);
    const address = await this.resolveAdvertisedAddress();
    if (!address)
      return 'Set the Scrypted LAN Address setting on the Harbor Bridge to generate this URL.';
    return buildWhipEndpoint({
      address,
      port: this.whipPort,
      serial,
      token: storage.getItem('token') || '',
    });
  }

  async getGo2rtcWhipEndpoint(serial: string): Promise<string> {
    if (!this.exposeGo2rtcWhip)
      return 'Disabled. Enable "Expose go2rtc WHIP Fallback" on the Harbor Bridge.';
    const address = await this.resolveAdvertisedAddress();
    if (!address)
      return 'Set the Scrypted LAN Address setting on the Harbor Bridge to generate this URL.';
    return buildGo2rtcWhipEndpoint({
      address,
      port: this.apiPort,
      serial,
      username: GO2RTC_API_USERNAME,
      password: this.go2rtcApiPassword,
    });
  }

  async getCreateDeviceSettings(): Promise<Setting[]> {
    return [
      {
        key: 'name',
        title: 'Camera Name',
        placeholder: 'Harbor Camera',
      },
      {
        key: 'serial',
        title: 'Harbor Serial',
        description: 'Example: 2400000000',
        placeholder: '2400000000',
      },
      {
        key: 'token',
        title: 'Ingest Token (optional)',
        description: 'Leave blank to generate a random 256-bit token.',
        type: 'password',
      },
      {
        key: 'height',
        title: 'Transcode Height',
        choices: ['360', '720', '1080'],
        value: '720',
      },
      {
        key: 'audio',
        title: 'Expose Audio',
        type: 'boolean',
        value: true,
      },
    ];
  }

  async createDevice(settings: DeviceCreatorSettings): Promise<string> {
    const serial = validateSerial(settings.serial);
    if (this.nativeIds.has(serial))
      throw new Error(`Harbor camera ${serial} already exists.`);

    const name = String(settings.name || `Harbor ${serial}`).trim();
    const token = settings.token ? validateToken(settings.token) : this.generateToken();
    const height = [360, 720, 1080].includes(Number(settings.height))
      ? Number(settings.height)
      : 720;
    const audio = settings.audio !== false && settings.audio !== 'false';

    // Scrypted does not create per-device state or storage until the device is
    // discovered. Announce it first, then persist the Harbor configuration.
    const device = this.getDeviceManifest(serial, name);
    await sdk.deviceManager.onDeviceDiscovered(device);

    const storage = sdk.deviceManager.getDeviceStorage(serial);
    storage.setItem('token', token);
    storage.setItem('height', String(height));
    storage.setItem('audio', String(audio));
    storage.setItem('name', name);
    this.nativeIds.add(serial);
    await this.restartBridge();
    return serial;
  }

  private getDeviceManifest(serial: string, name: string): Device {
    return {
      nativeId: serial,
      name,
      type: ScryptedDeviceType.Camera,
      interfaces: [
        ScryptedInterface.VideoCamera,
        ScryptedInterface.Settings,
        ScryptedInterface.Online,
      ],
      info: {
        manufacturer: 'Harbor',
        model: 'Harbor Camera',
        serialNumber: serial,
      },
    };
  }

  async getDevice(nativeId: string | undefined): Promise<HarborCamera> {
    const serial = validateSerial(nativeId);
    this.nativeIds.add(serial);
    let camera = this.devices.get(serial);
    if (!camera) {
      camera = new HarborCamera(serial, this);
      this.devices.set(serial, camera);
    }
    return camera;
  }

  async releaseDevice(_id: string, nativeId: string | undefined): Promise<void> {
    if (!nativeId)
      return;
    this.devices.delete(nativeId);
    this.nativeIds.delete(nativeId);
    await this.restartBridge();
  }

  async getSettings(): Promise<Setting[]> {
    return [
      {
        key: 'bridgeStatus',
        title: 'Bridge Status',
        value: this.bridgeStatus,
        readonly: true,
      },
      {
        key: 'whipStatus',
        title: 'WHIP Listener Status',
        description: 'Harbor cameras publish to this listener. It must be reachable from the camera VLAN.',
        value: this.whipStatus,
        readonly: true,
      },
      {
        key: 'cameraCount',
        title: 'Configured Cameras',
        value: this.nativeIds.size,
        readonly: true,
      },
      {
        key: 'go2rtcPath',
        title: 'go2rtc Executable',
        description: `Optional. Leave blank to download the pinned ${GO2RTC_VERSION} Linux binary into plugin storage.`,
        placeholder: '/usr/local/bin/go2rtc',
        value: this.storage.getItem('go2rtcPath'),
      },
      {
        key: 'advertisedAddress',
        title: 'Scrypted LAN Address',
        description: 'Recommended when Scrypted has multiple network interfaces. This address is advertised to Harbor as the WebRTC media destination and used to build WHIP URLs.',
        placeholder: '192.168.1.20',
        value: this.storage.getItem('advertisedAddress'),
      },
      {
        key: 'whipPort',
        title: 'WHIP Listener Port',
        description: 'Dedicated HTTP port for Harbor WHIP publishing. Must be reachable from the camera VLAN. Do not forward it from the internet.',
        type: 'integer',
        value: this.whipPort,
      },
      {
        key: 'exposeGo2rtcWhip',
        title: 'Expose go2rtc WHIP Fallback',
        description: 'Diagnostic only. Binds the go2rtc API to the LAN behind a shared username/password so Harbor can publish to go2rtc directly, bypassing this plugin\'s proxy. The credential is shared by every camera on this bridge.',
        subgroup: 'Advanced',
        type: 'boolean',
        value: this.exposeGo2rtcWhip,
      },
      {
        key: 'webrtcPort',
        title: 'WebRTC Media Port',
        description: 'Must be reachable from Harbor over both TCP and UDP. Do not forward it from the internet.',
        subgroup: 'Advanced',
        type: 'integer',
        value: this.webrtcPort,
      },
      {
        key: 'apiPort',
        title: 'go2rtc API Port',
        description: 'Loopback only unless the WHIP fallback above is enabled.',
        subgroup: 'Advanced',
        type: 'integer',
        value: this.apiPort,
      },
      {
        key: 'rtspPort',
        title: 'Private RTSP Port',
        subgroup: 'Advanced',
        type: 'integer',
        value: this.rtspPort,
      },
      {
        key: 'restartBridge',
        title: 'Restart Bridge',
        type: 'button',
      },
    ];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    if (key === 'restartBridge') {
      await this.restartBridge();
      return;
    }
    const known = [
      'go2rtcPath',
      'advertisedAddress',
      'webrtcPort',
      'apiPort',
      'rtspPort',
      'whipPort',
      'exposeGo2rtcWhip',
    ];
    if (!known.includes(key))
      throw new Error(`Unknown setting: ${key}`);
    if (key.endsWith('Port')) {
      const parsed = parsePort(value, -1);
      if (parsed === -1)
        throw new Error('Port must be an integer from 1 through 65535.');
      validateBridgePorts({
        whipPort: key === 'whipPort' ? parsed : this.whipPort,
        apiPort: key === 'apiPort' ? parsed : this.apiPort,
        rtspPort: key === 'rtspPort' ? parsed : this.rtspPort,
        webrtcPort: key === 'webrtcPort' ? parsed : this.webrtcPort,
      });
      this.storage.setItem(key, String(parsed));
    }
    else if (key === 'exposeGo2rtcWhip') {
      const enabled = value !== false && value !== 'false';
      if (enabled)
        void this.go2rtcApiPassword;
      this.storage.setItem(key, String(enabled));
    }
    else {
      this.storage.setItem(key, String(value || '').trim());
    }
    await this.restartBridge();
  }

  async ensureBridgeReady(): Promise<void> {
    if (this.isBridgeReady())
      return;
    if (this.starting)
      await this.starting;
    else
      await this.restartBridge();
    if (!this.isBridgeReady())
      throw new Error(`Harbor bridge is unavailable: ${this.bridgeStatus}`);
  }

  async restartBridge(): Promise<void> {
    this.restartChain = this.restartChain
      .catch(() => undefined)
      .then(() => this.restartBridgeNow());
    return this.restartChain;
  }

  private async restartBridgeNow(): Promise<void> {
    clearTimeout(this.respawnTimer);
    const oldProcess = this.go2rtc;
    this.go2rtc = undefined;
    if (oldProcess && !oldProcess.killed) {
      oldProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!oldProcess.killed)
        oldProcess.kill('SIGKILL');
    }
    this.starting = this.startBridge();
    try {
      await this.starting;
    }
    finally {
      this.starting = undefined;
    }
    // A WHIP port conflict must not mark the whole bridge as failed; go2rtc may
    // be perfectly healthy and the user needs a working settings page to fix it.
    await this.ensureWhipServer().catch(error => {
      this.console.error('Harbor WHIP listener failed to start', error);
      this.setWhipStatus(`Error: ${error?.message || error}`);
    });
  }

  private async startBridge(): Promise<void> {
    this.setBridgeStatus('Starting');
    const filesPath = await sdk.mediaManager.getFilesPath();
    await fs.mkdir(filesPath, { recursive: true });
    await this.removeLegacyAdapterState(filesPath);
    const configPath = path.join(filesPath, 'go2rtc.json');
    await this.stopStaleGo2rtc(configPath);
    await this.assertGo2rtcPortsAvailable();
    const executable = await this.resolveGo2rtcExecutable(filesPath);
    const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
    const advertisedAddress = await this.resolveAdvertisedAddress();
    const exposeApi = this.exposeGo2rtcWhip;
    const config = buildGo2rtcConfig({
      cameras: this.cameraConfigs,
      apiPort: this.apiPort,
      rtspPort: this.rtspPort,
      webrtcPort: this.webrtcPort,
      advertisedAddress,
      ffmpegPath,
      exposeApi,
      apiUsername: exposeApi ? GO2RTC_API_USERNAME : '',
      apiPassword: exposeApi ? this.go2rtcApiPassword : '',
    });
    const temporaryPath = `${configPath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, configPath);

    const child = spawn(executable, ['-config', configPath], {
      cwd: filesPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.go2rtc = child;
    let startupError: Error | undefined;
    child.stdout?.on('data', data => this.console.log(`[go2rtc] ${String(data).trimEnd()}`));
    child.stderr?.on('data', data => {
      const message = String(data).trimEnd();
      this.console.error(`[go2rtc] ${message}`);
      if (message.includes('listen error='))
        startupError = new Error(`go2rtc could not bind its configured ports: ${message}`);
    });
    child.once('error', error => {
      if (this.go2rtc === child)
        this.setBridgeStatus(`Error: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.go2rtc !== child)
        return;
      this.go2rtc = undefined;
      this.setBridgeStatus(`Stopped (${signal || code})`);
      this.respawnTimer = setTimeout(() => {
        this.restartBridge().catch(error => this.setBridgeStatus(`Error: ${error.message}`));
      }, 5000);
    });

    try {
      const deadline = Date.now() + 10000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        if (startupError)
          throw startupError;
        if (child.exitCode !== null)
          throw new Error(`go2rtc exited with code ${child.exitCode}.`);
        try {
          const response = await fetch(`http://127.0.0.1:${this.apiPort}/api/streams`);
          if (response.ok) {
            // Do not mistake a stale process on the API port for this child.
            await new Promise(resolve => setTimeout(resolve, 200));
            if (startupError)
              throw startupError;
            if (child.exitCode !== null)
              throw new Error(`go2rtc exited with code ${child.exitCode}.`);
            this.setBridgeStatus('Running');
            return;
          }
        }
        catch (error) {
          lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error(`go2rtc did not become ready${lastError instanceof Error ? `: ${lastError.message}` : '.'}`);
    }
    catch (error) {
      if (this.go2rtc === child)
        this.go2rtc = undefined;
      if (!child.killed)
        child.kill('SIGTERM');
      throw error;
    }
  }

  private setWhipStatus(status: string): void {
    this.whipStatus = status;
    this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => undefined);
  }

  private async ensureWhipServer(): Promise<void> {
    const port = this.whipPort;
    if (this.whipServer && this.whipServerPort === port)
      return;

    if (this.whipServer) {
      const closing = this.whipServer;
      this.whipServer = undefined;
      this.whipServerPort = undefined;
      await new Promise<void>(resolve => closing.close(() => resolve()));
    }

    const server = createServer((request, response) => {
      this.handleWhip(request, response).catch(error => {
        this.console.error('WHIP listener failure', error);
        if (!response.headersSent)
          this.endWhip(response, 500, 'Internal Server Error');
      });
    });
    server.on('error', error => {
      if (this.whipServer !== server)
        return;
      this.whipServer = undefined;
      this.whipServerPort = undefined;
      this.setWhipStatus(`Error: ${(error as Error).message}`);
    });
    // Long-lived signaling; do not let Node time the socket out mid-negotiation.
    server.headersTimeout = 30000;
    server.requestTimeout = 30000;

    await new Promise<void>((resolve, reject) => {
      const onStartupError = (error: NodeJS.ErrnoException) => {
        reject(this.createPortConflictError(error, 'WHIP listener', '0.0.0.0', port, 'TCP'));
      };
      server.once('error', onStartupError);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', onStartupError);
        resolve();
      });
    });

    this.whipServer = server;
    this.whipServerPort = port;
    this.setWhipStatus(`Listening on 0.0.0.0:${port}`);
    this.console.log(`Harbor WHIP listener bound to 0.0.0.0:${port}`);
  }

  private endWhip(response: ServerResponse, code: number, body: string, headers: Record<string, string> = {}): void {
    response.writeHead(code, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    });
    response.end(body);
  }

  private readWhipBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      request.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_WHIP_BODY_BYTES) {
          reject(new Error('WHIP request body too large.'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.once('error', reject);
    });
  }

  /**
   * Dedicated WHIP listener. Receives the raw `application/sdp` offer, checks the
   * per-camera ingest token, and proxies to go2rtc's loopback WebRTC API.
   */
  private async handleWhip(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      this.endWhip(response, 204, '', {
        'Access-Control-Allow-Methods': 'POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, If-Match',
      });
      return;
    }

    let target: { serial: string; token: string; session: string };
    try {
      target = parseWhipUrl(request.url);
    }
    catch {
      this.endWhip(response, 404, 'Not Found');
      return;
    }

    if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
      this.endWhip(response, 405, 'Method Not Allowed', { Allow: 'POST, PATCH, DELETE, OPTIONS' });
      return;
    }

    const { serial, token, session } = target;
    if (!this.nativeIds.has(serial)) {
      this.console.warn(`WHIP request rejected: unknown serial ${serial} from ${request.socket.remoteAddress}`);
      this.endWhip(response, 401, 'Unauthorized');
      return;
    }
    const storage = sdk.deviceManager.getDeviceStorage(serial);
    if (!secureTokenEqual(token, storage.getItem('token'))) {
      this.console.warn(`WHIP request rejected: bad token for ${serial} from ${request.socket.remoteAddress}`);
      this.endWhip(response, 401, 'Unauthorized');
      return;
    }

    let body: string;
    try {
      body = await this.readWhipBody(request);
    }
    catch {
      this.endWhip(response, 413, 'Payload Too Large');
      return;
    }

    try {
      await this.ensureBridgeReady();
    }
    catch (error) {
      this.console.error('WHIP request failed: bridge unavailable', error);
      this.endWhip(response, 503, 'Service Unavailable');
      return;
    }

    let upstreamPath: string;
    try {
      if (method === 'POST') {
        if (session)
          throw new Error('A new WHIP publish request cannot include a session.');
        upstreamPath = `/api/webrtc?dst=${encodeURIComponent(serial)}`;
      }
      else {
        upstreamPath = decodeSessionTarget(session);
      }
    }
    catch (error) {
      this.console.error(`WHIP ${method} for ${serial} had an invalid session target`, error);
      this.endWhip(response, 400, 'Bad Request');
      return;
    }

    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'if-match', 'accept']) {
      const value = request.headers[name];
      if (typeof value === 'string' && value)
        headers[name] = value;
    }
    if (method === 'POST' && !headers['content-type'])
      headers['content-type'] = 'application/sdp';

    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${this.apiPort}${upstreamPath}`, {
        method,
        headers,
        body: method === 'DELETE' ? undefined : body,
        redirect: 'manual',
      });
    }
    catch (error) {
      this.console.error(`WHIP ${method} for ${serial} could not reach go2rtc`, error);
      this.endWhip(response, 502, 'Bad Gateway');
      return;
    }

    const responseHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Location, ETag, Accept-Patch',
    };
    for (const name of ['content-type', 'accept-patch', 'etag']) {
      const value = upstream.headers.get(name);
      if (value)
        responseHeaders[name] = value;
    }

    const location = upstream.headers.get('location');
    if (location) {
      try {
        const sessionTarget = normalizeGo2rtcSessionLocation(location);
        const address = await this.resolveAdvertisedAddress();
        if (!address)
          throw new Error('No LAN address is available to rewrite the WHIP session location.');
        responseHeaders.location = buildWhipEndpoint({
          address,
          port: this.whipPort,
          serial,
          token: storage.getItem('token') || '',
          session: encodeSessionTarget(sessionTarget),
        });
      }
      catch (error) {
        this.console.error(`WHIP ${method} for ${serial} returned an unusable Location`, error);
        this.endWhip(response, 502, 'Bad Gateway');
        return;
      }
    }

    const upstreamBody = await upstream.text();
    if (!responseHeaders['content-type'] && upstreamBody.startsWith('v=0'))
      responseHeaders['content-type'] = 'application/sdp';

    this.console.log(`WHIP ${method} ${serial} -> go2rtc ${upstream.status}${location ? ' (session)' : ''}`);
    response.writeHead(upstream.status, responseHeaders);
    response.end(upstreamBody);
  }

  private async removeLegacyAdapterState(filesPath: string): Promise<void> {
    const directory = path.join(filesPath, 'protect');
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    }
    catch (error: any) {
      if (error?.code === 'ENOENT')
        return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json'))
        await this.stopStaleGo2rtc(path.join(directory, entry.name));
    }
    await fs.rm(directory, { recursive: true, force: true });
    this.console.log('Removed legacy per-camera adapter runtime state.');
  }

  private async assertGo2rtcPortsAvailable(): Promise<void> {
    validateBridgePorts({
      whipPort: this.whipPort,
      apiPort: this.apiPort,
      rtspPort: this.rtspPort,
      webrtcPort: this.webrtcPort,
    });
    const apiHost = this.exposeGo2rtcWhip ? '0.0.0.0' : '127.0.0.1';
    await this.assertTcpPortAvailable(apiHost, this.apiPort, 'go2rtc API');
    await this.assertTcpPortAvailable('127.0.0.1', this.rtspPort, 'private RTSP');
    await this.assertTcpPortAvailable('0.0.0.0', this.webrtcPort, 'WebRTC media');
    await this.assertUdpPortAvailable('0.0.0.0', this.webrtcPort, 'WebRTC media');
  }

  private assertTcpPortAvailable(host: string, port: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      const onError = (error: NodeJS.ErrnoException) => {
        reject(this.createPortConflictError(error, label, host, port, 'TCP'));
      };
      probe.once('error', onError);
      probe.listen(port, host, () => {
        probe.off('error', onError);
        probe.close(error => error ? reject(error) : resolve());
      });
    });
  }

  private assertUdpPortAvailable(host: string, port: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const probe = createSocket('udp4');
      const onError = (error: NodeJS.ErrnoException) => {
        try {
          probe.close();
        }
        catch {
          // The failed bind may leave the socket unopened.
        }
        reject(this.createPortConflictError(error, label, host, port, 'UDP'));
      };
      probe.once('error', onError);
      probe.bind({ address: host, port, exclusive: true }, () => {
        probe.off('error', onError);
        probe.close(() => resolve());
      });
    });
  }

  private createPortConflictError(
    error: NodeJS.ErrnoException,
    label: string,
    host: string,
    port: number,
    protocol: 'TCP' | 'UDP',
  ): Error {
    if (error.code === 'EADDRINUSE') {
      return new Error(
        `${label} cannot bind ${protocol} ${host}:${port}: address already in use. `
        + `Run "ss -lntup | grep ':${port}\\b'" inside the Scrypted host to identify the owner, `
        + 'or select an unused port in Harbor Bridge settings.',
      );
    }
    return new Error(`${label} cannot bind ${protocol} ${host}:${port}: ${error.message}`);
  }

  private async stopStaleGo2rtc(configPath: string): Promise<void> {
    if (process.platform !== 'linux')
      return;

    let entries: string[];
    try {
      entries = await fs.readdir('/proc');
    }
    catch {
      return;
    }

    for (const entry of entries) {
      if (!/^\d+$/.test(entry))
        continue;
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
        continue;
      const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (!isGo2rtcProcessForConfig(cmdline, configPath))
        continue;

      try {
        process.kill(pid, 'SIGTERM');
      }
      catch (error: any) {
        if (error?.code === 'ESRCH')
          continue;
        throw new Error(`Unable to stop stale Harbor go2rtc process ${pid}: ${error?.message || error}`);
      }

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && this.isProcessAlive(pid))
        await new Promise(resolve => setTimeout(resolve, 100));
      if (this.isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        }
        catch (error: any) {
          if (error?.code !== 'ESRCH')
            throw new Error(`Unable to terminate stale Harbor go2rtc process ${pid}: ${error?.message || error}`);
        }
      }
      this.console.warn(`Stopped stale Harbor go2rtc process ${pid}.`);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    }
    catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  private async resolveAdvertisedAddress(): Promise<string | undefined> {
    const configured = this.storage.getItem('advertisedAddress')?.trim();
    if (configured)
      return configured;
    const addresses = await sdk.endpointManager.getLocalAddresses();
    return addresses.find(address => !address.startsWith('127.') && address !== '::1');
  }

  private async resolveGo2rtcExecutable(filesPath: string): Promise<string> {
    const configured = this.storage.getItem('go2rtcPath')?.trim();
    if (configured) {
      await fs.access(configured, fsConstants.X_OK);
      return configured;
    }
    const runtimeDirectory = path.join(filesPath, 'runtime');
    const executable = path.join(runtimeDirectory, `go2rtc-${GO2RTC_VERSION}`);
    try {
      await fs.access(executable, fsConstants.X_OK);
      return executable;
    }
    catch {
      // Download below.
    }

    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
      throw new Error('Automatic go2rtc installation supports Linux x64/arm64. Set the go2rtc Executable setting on this platform.');
    }
    await fs.mkdir(runtimeDirectory, { recursive: true });
    const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
    const url = `https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_${architecture}`;
    this.setBridgeStatus(`Downloading go2rtc ${GO2RTC_VERSION}`);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Unable to download go2rtc (${response.status}). Set a local executable path instead.`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_RUNTIME_BYTES)
      throw new Error('Refusing an unexpectedly large go2rtc download.');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_RUNTIME_BYTES)
      throw new Error('Downloaded go2rtc file has an invalid size.');
    const temporary = `${executable}.download`;
    await fs.writeFile(temporary, data, { mode: 0o755 });
    await fs.rename(temporary, executable);
    await fs.chmod(executable, 0o755);
    const digest = createHash('sha256').update(data).digest('hex');
    this.console.log(`Installed go2rtc ${GO2RTC_VERSION}; sha256=${digest}`);
    return executable;
  }

  /**
   * The plugin device still declares HttpRequestHandler so Scrypted routes this
   * endpoint, but WHIP cannot be served here. See getWhipEndpoint for why.
   */
  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    const method = (request.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      response.send('', {
        code: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
      return;
    }
    response.send(
      'Harbor WHIP is not served over the Scrypted endpoint. Scrypted parses request bodies as text/plain, '
      + 'so an application/sdp offer never survives. Use the WHIP endpoint shown on the camera settings page.',
      { code: 501, headers: { 'Content-Type': 'text/plain' } },
    );
  }
}
