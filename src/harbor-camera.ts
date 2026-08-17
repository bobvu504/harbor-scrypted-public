import {
  MediaObject,
  MediaStreamUrl,
  RequestMediaStreamOptions,
  ResponseMediaStreamOptions,
  ScryptedDeviceBase,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  SettingValue,
  Settings,
  VideoCamera,
} from '@scrypted/sdk';
import {
  parsePort,
  validateProtectPassword,
  validateProtectUsername,
  validateToken,
} from './core.mjs';
import type HarborCameraProvider from './main';

export class HarborCamera extends ScryptedDeviceBase implements VideoCamera, Settings {
  constructor(nativeId: string, private readonly provider: HarborCameraProvider) {
    super(nativeId);
    this.online = provider.isBridgeReady();
  }

  get serial(): string {
    return this.nativeId!;
  }

  get audioEnabled(): boolean {
    return this.storage.getItem('audio') !== 'false';
  }

  get height(): number {
    const value = Number(this.storage.getItem('height'));
    return [360, 720, 1080].includes(value) ? value : 720;
  }

  get ingestToken(): string {
    return this.storage.getItem('token') || '';
  }

  get protectEnabled(): boolean {
    return this.storage.getItem('protectEnabled') === 'true';
  }

  get protectRequireAuth(): boolean {
    return this.storage.getItem('protectRequireAuth') !== 'false';
  }

  get protectApiPort(): number {
    return parsePort(this.storage.getItem('protectApiPort'), 1984);
  }

  get protectRtspPort(): number {
    return parsePort(this.storage.getItem('protectRtspPort'), 8554);
  }

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [{
      id: 'harbor-h264',
      name: 'Harbor H.264',
      container: 'rtsp',
      source: 'local',
      video: {
        codec: 'h264',
        height: this.height,
      },
      audio: this.audioEnabled ? {
        codec: 'opus',
        sampleRate: 16000,
      } : undefined,
    }];
  }

  async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
    await this.provider.ensureBridgeReady();
    const mediaStreamOptions = (await this.getVideoStreamOptions())[0];
    const stream: MediaStreamUrl = {
      url: this.provider.getRtspUrl(this.serial),
      container: 'rtsp',
      mediaStreamOptions,
    };
    return this.createMediaObject(stream, ScryptedMimeTypes.MediaStreamUrl);
  }

  async getSettings(): Promise<Setting[]> {
    const endpoint = await this.provider.getWhipEndpoint(this.serial);
    const fallback = await this.provider.getGo2rtcWhipEndpoint(this.serial);
    return [
      {
        key: 'serial',
        title: 'Harbor Serial',
        description: 'The dst stream name expected by the Harbor camera.',
        value: this.serial,
        readonly: true,
      },
      {
        key: 'whipEndpoint',
        title: 'Harbor WHIP Endpoint',
        description: 'Paste this complete private URL into the Harbor app. Reserve the Scrypted host IP in your router.',
        value: endpoint,
        readonly: true,
      },
      {
        key: 'whipEndpointFallback',
        title: 'go2rtc WHIP Fallback Endpoint',
        description: 'Diagnostic only. Publishes straight to go2rtc, bypassing this plugin\'s proxy. Enable the fallback on the Harbor Bridge settings page first.',
        subgroup: 'Advanced',
        value: fallback,
        readonly: true,
      },
      {
        key: 'token',
        title: 'Ingest Token',
        description: 'Private credential required to publish to this camera stream.',
        type: 'password',
        value: this.ingestToken,
      },
      {
        key: 'regenerateToken',
        title: 'Regenerate Ingest Token',
        description: 'Invalidates the old WHIP URL. Update the Harbor app after using this button.',
        type: 'button',
      },
      {
        key: 'height',
        title: 'Transcode Height',
        description: '720p is the tested Harbor/HomeKit profile. Higher values require more CPU.',
        value: String(this.height),
        choices: ['360', '720', '1080'],
      },
      {
        key: 'audio',
        title: 'Expose Audio',
        description: 'Transcode Harbor Opus audio to 16 kHz mono Opus.',
        type: 'boolean',
        value: this.audioEnabled,
      },
      {
        key: 'protectEnabled',
        title: 'Enable UniFi Protect Adapter',
        description: 'Starts a dedicated go2rtc ONVIF server for this camera. Configure a unique IPv4 address below before enabling.',
        subgroup: 'UniFi Protect',
        type: 'boolean',
        value: this.protectEnabled,
      },
      {
        key: 'protectStatus',
        title: 'UniFi Protect Status',
        subgroup: 'UniFi Protect',
        value: this.provider.getProtectStatus(this.serial),
        readonly: true,
      },
      {
        key: 'protectAddress',
        title: 'Dedicated ONVIF IPv4 Address',
        description: 'Must already be assigned to this Scrypted host and must be unique for this camera. A distinct MAC address is recommended.',
        subgroup: 'UniFi Protect',
        placeholder: '192.168.1.21',
        value: this.storage.getItem('protectAddress') || '',
      },
      {
        key: 'protectAdoptionTarget',
        title: 'Protect Advanced Adoption Address',
        description: 'Enter this host:port in UniFi Protect Advanced Adoption.',
        subgroup: 'UniFi Protect',
        value: this.provider.getProtectAdoptionTarget(this.serial),
        readonly: true,
      },
      {
        key: 'protectRequireAuth',
        title: 'Require ONVIF/RTSP Password',
        description: 'Uses HTTP Basic and RTSP authentication. Disable temporarily only if your Protect version cannot adopt an authenticated go2rtc ONVIF server.',
        subgroup: 'UniFi Protect',
        type: 'boolean',
        value: this.protectRequireAuth,
      },
      {
        key: 'protectUsername',
        title: 'ONVIF Username',
        subgroup: 'UniFi Protect',
        value: this.storage.getItem('protectUsername') || 'harbor',
      },
      {
        key: 'protectPassword',
        title: 'ONVIF Password',
        description: 'Enter this same credential during Protect adoption. Stored in the plugin-owned configuration file with owner-only permissions.',
        subgroup: 'UniFi Protect',
        type: 'password',
        value: this.provider.getProtectPassword(this.serial),
      },
      {
        key: 'regenerateProtectPassword',
        title: 'Regenerate ONVIF Password',
        description: 'After adoption, update or re-adopt the camera in Protect with the new password.',
        subgroup: 'UniFi Protect',
        type: 'button',
      },
      {
        key: 'protectApiPort',
        title: 'ONVIF Port',
        description: 'go2rtc exposes ONVIF through its API listener. The default is 1984.',
        subgroup: 'UniFi Protect Advanced',
        type: 'integer',
        value: this.protectApiPort,
      },
      {
        key: 'protectRtspPort',
        title: 'Protect RTSP Port',
        description: 'Protect receives H.264 video and optional AAC audio on this port. The default is 8554.',
        subgroup: 'UniFi Protect Advanced',
        type: 'integer',
        value: this.protectRtspPort,
      },
      {
        key: 'bridgeStatus',
        title: 'Bridge Status',
        value: this.provider.bridgeStatus,
        readonly: true,
      },
      {
        key: 'restartBridge',
        title: 'Restart Bridge',
        type: 'button',
      },
    ];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    let restart = false;
    if (key === 'token') {
      this.storage.setItem('token', validateToken(value));
    }
    else if (key === 'regenerateToken') {
      this.storage.setItem('token', this.provider.generateToken());
    }
    else if (key === 'height') {
      const height = Number(value);
      if (![360, 720, 1080].includes(height))
        throw new Error('Transcode height must be 360, 720, or 1080.');
      this.storage.setItem('height', String(height));
      restart = true;
    }
    else if (key === 'audio') {
      this.storage.setItem('audio', String(value !== false && value !== 'false'));
      restart = true;
    }
    else if (key === 'protectEnabled') {
      const enabled = value !== false && value !== 'false';
      if (enabled) {
        this.provider.assertProtectAddressAvailable(this.serial, this.storage.getItem('protectAddress'));
        if (this.protectRequireAuth) {
          validateProtectUsername(this.storage.getItem('protectUsername') || 'harbor');
          validateProtectPassword(this.provider.getProtectPassword(this.serial));
        }
      }
      this.storage.setItem('protectEnabled', String(enabled));
      restart = true;
    }
    else if (key === 'protectAddress') {
      const raw = String(value || '').trim();
      if (!raw && this.protectEnabled)
        throw new Error('Disable the UniFi Protect adapter before clearing its address.');
      this.storage.setItem('protectAddress', raw ? this.provider.assertProtectAddressAvailable(this.serial, raw) : '');
      restart = this.protectEnabled;
    }
    else if (key === 'protectRequireAuth') {
      const enabled = value !== false && value !== 'false';
      if (enabled) {
        validateProtectUsername(this.storage.getItem('protectUsername') || 'harbor');
        validateProtectPassword(this.provider.getProtectPassword(this.serial));
      }
      this.storage.setItem('protectRequireAuth', String(enabled));
      restart = this.protectEnabled;
    }
    else if (key === 'protectUsername') {
      this.storage.setItem('protectUsername', validateProtectUsername(value));
      restart = this.protectEnabled;
    }
    else if (key === 'protectPassword') {
      this.storage.setItem('protectPassword', validateProtectPassword(value));
      restart = this.protectEnabled;
    }
    else if (key === 'regenerateProtectPassword') {
      this.storage.setItem('protectPassword', this.provider.generateProtectPassword());
      restart = this.protectEnabled;
    }
    else if (key === 'protectApiPort' || key === 'protectRtspPort') {
      const port = parsePort(value, -1);
      if (port === -1)
        throw new Error('Port must be an integer from 1 through 65535.');
      const other = key === 'protectApiPort' ? this.protectRtspPort : this.protectApiPort;
      if (port === other)
        throw new Error('ONVIF and RTSP listeners cannot use the same port.');
      this.storage.setItem(key, String(port));
      restart = this.protectEnabled;
    }
    else if (key === 'restartBridge') {
      restart = true;
    }
    else {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (restart)
      await this.provider.restartBridge();
    await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
  }
}
