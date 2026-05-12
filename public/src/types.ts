// Shared frontend types. The state shape, the S3 row shape that the API
// returns, and the encrypted-vault envelope all live here so each module
// imports a single source of truth.

export interface Connection {
  id: string;             // crypto.randomUUID()
  name: string;
  endpoint: string;       // '' for AWS official; full URL for MinIO/Vultr/R2
  region: string;
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  pathStyle: boolean;
  buckets: string[];      // optional manual bucket list (for restricted IAM)
}

export interface S3Object {
  Key: string;
  Size: number;
  LastModified?: string;
  ETag?: string;
  VersionId?: string;
  StorageClass?: string;
  IsDeleteMarker?: boolean;
}

export interface VaultEnvelope {
  v: 1;
  salt: string;           // base64
  iv: string;             // base64
  ct: string;             // base64
}

export interface CurrentUser {
  authenticated: boolean;
  username: string;
  role: 'admin' | 'user';
  totpEnrolled: boolean;
  mustChangePassword: boolean;
}

export type SortField = 'name' | 'size' | 'modified';
export type SortDir = 'asc' | 'desc';

export interface SearchMeta {
  scanned: number;
  hits: number;
  query: string;
  status: 'scanning' | 'done' | 'cancelled' | 'error';
  reason?: string;
  error?: string;
}

export interface SearchFolderInfo {
  fileCount: number;
  totalSize: number;
  latestModified: string | null;
}
