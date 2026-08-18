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
import { validateToken } from './core.mjs';
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
