export interface HarborStreamConfig {
  serial: string;
  height: number;
  audio: boolean;
}

export interface Go2rtcConfigOptions {
  cameras: HarborStreamConfig[];
  apiPort: number;
  rtspPort: number;
  webrtcPort: number;
  advertisedAddress?: string;
  ffmpegPath: string;
  exposeApi?: boolean;
  apiUsername?: string;
  apiPassword?: string;
}

export interface ProtectGo2rtcConfigOptions {
  serial: string;
  address: string;
  apiPort: number;
  rtspPort: number;
  sourceRtspPort: number;
  audio: boolean;
  requireAuth?: boolean;
  username?: string;
  password?: string;
  ffmpegPath: string;
}

export interface WhipRequestTarget {
  serial: string;
  token: string;
  session: string;
}

export interface WhipEndpointOptions {
  address: string;
  port: number;
  serial: string;
  token: string;
  session?: string;
}

export interface Go2rtcWhipEndpointOptions {
  address: string;
  port: number;
  serial: string;
  username: string;
  password: string;
}

export const WHIP_PATH: string;

export function validateSerial(value: unknown): string;
export function validateToken(value: unknown): string;
export function validateProtectAddress(value: unknown): string;
export function validateProtectUsername(value: unknown): string;
export function validateProtectPassword(value: unknown): string;
export function secureTokenEqual(actual: unknown, expected: unknown): boolean;
export function parsePort(value: unknown, fallback: number): number;
export function isGo2rtcProcessForConfig(cmdline: unknown, configPath: string): boolean;
export function buildGo2rtcConfig(options: Go2rtcConfigOptions): Record<string, any>;
export function buildProtectGo2rtcConfig(options: ProtectGo2rtcConfigOptions): Record<string, any>;
export function encodeSessionTarget(pathAndQuery: string): string;
export function decodeSessionTarget(encoded: string): string;
export function normalizeGo2rtcSessionLocation(location: unknown): string;
export function parseWhipUrl(rawUrl: unknown): WhipRequestTarget;
export function buildWhipEndpoint(options: WhipEndpointOptions): string;
export function buildGo2rtcWhipEndpoint(options: Go2rtcWhipEndpointOptions): string;
