/* The few shapes of the contract (contract/openapi.yaml) this client uses. */

export type Lang = 'zh' | 'en';
export type Bilingual = { zh: string; en: string };

export interface SecretPattern {
  name: string;
  regex: string;
  flags?: string;
  any_length?: boolean;
  description?: string;
}

export interface SecretRule {
  max_length_checked?: number;
  patterns: SecretPattern[];
}

export interface SharedRules {
  secret_like?: SecretRule;
  save_messages?: Record<string, Bilingual | string>;
  /** What follows the sentence when what was saved is not what the user gave (the pictures). */
  save_notes?: Record<string, Bilingual | string>;
}

export interface Meta {
  contract_version: string;
  limits: Record<string, unknown>;
  shared_rules: SharedRules;
}

/** SaveRequest. No tags and no triage information exist in this type on purpose (rule B7). */
export interface SaveRequest {
  kind: 'link' | 'text' | 'image';
  url?: string;
  title?: string;
  text?: string;
  asset_id?: string;
  entry?: string;
}

export interface SaveResult {
  status: 'saved' | 'duplicate';
  item_id?: string;
  message_key: string;
  message: string;
  image_stored?: boolean;
}

export interface Device {
  id: string;
  name: string;
  tier?: 'save' | 'read' | 'manage';
}

export interface DeviceGrant {
  credential: string;
  device: Device;
}

export interface DeviceCode {
  code: string;
  poll_secret: string;
  expires_at: string;
  approve_url: string;
}

/** An image already converted, waiting to be uploaded through the asset flow. */
export interface PreparedImage {
  base64: string;
  sha256: string;
  bytes: number;
  content_type: 'image/webp';
}

/** One save as the user triggered it. `key` is the Idempotency-Key and never changes on a retry. */
export interface PendingSave {
  key: string;
  request: SaveRequest;
  image?: PreparedImage;
  at: number;
}
