export interface StorageAdapter {
  readonly name: string;
  upload(storagePath: string, content: Buffer, contentType: string): Promise<void>;
  uploadStream?(storagePath: string, stream: AsyncIterable<Buffer> | NodeJS.ReadableStream, contentType: string): Promise<{ size: number, sha256: string }>;
}

export type StorageErrorCategory =
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'quota'
  | 'transient'
  | 'object'
  | 'unknown';

export class StorageAdapterError extends Error {
  readonly adapter: string;
  readonly operation: string;
  readonly code: string;
  readonly category: StorageErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus?: number;

  constructor(args: {
    adapter: string;
    operation: string;
    code: string;
    category: StorageErrorCategory;
    retryable: boolean;
    message: string;
    httpStatus?: number;
  }) {
    super(args.message);
    this.name = 'StorageAdapterError';
    this.adapter = args.adapter;
    this.operation = args.operation;
    this.code = args.code;
    this.category = args.category;
    this.retryable = args.retryable;
    this.httpStatus = args.httpStatus;
  }
}

export type StoragePreflightResult = {
  adapter: string;
  writable: boolean;
  versioning?: boolean;
  objectLock?: boolean;
  message?: string;
  errorCode?: string;
  errorCategory?: StorageErrorCategory;
  retryable?: boolean;
};

export type StorageHeadResult = {
  exists: boolean;
  size?: number;
  etag?: string;
  versionId?: string;
};

export interface DurableStorageAdapter extends StorageAdapter {
  preflight(): Promise<StoragePreflightResult>;
  head(storagePath: string): Promise<StorageHeadResult>;
  download?(storagePath: string): Promise<{ content: Buffer, etag?: string }>;
  uploadOptimistic?(storagePath: string, content: Buffer, contentType: string, ifMatchEtag?: string): Promise<{ etag: string }>;
  verify(storagePath: string, sha256: string): Promise<void>;
  delete?(storagePath: string): Promise<void>;
}

export function isDurableStorageAdapter(adapter: StorageAdapter): adapter is DurableStorageAdapter {
  return (
    typeof (adapter as DurableStorageAdapter).preflight === 'function' &&
    typeof (adapter as DurableStorageAdapter).head === 'function' &&
    typeof (adapter as DurableStorageAdapter).verify === 'function'
  );
}

export function normalizeStorageError(error: unknown, adapter: string, operation: string): StorageAdapterError {
  if (error instanceof StorageAdapterError) return error;

  const err = error as {
    name?: string;
    Code?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    status?: number;
    response?: { status?: number; statusText?: string; data?: unknown };
  };

  const httpStatus = err.$metadata?.httpStatusCode ?? err.status ?? err.response?.status;
  const code = String(err.Code ?? err.code ?? err.name ?? (httpStatus ? `HTTP_${httpStatus}` : 'UnknownError'));
  const rawMessage = err.message ?? err.response?.statusText ?? String(error);
  const message = redactSecrets(rawMessage);

  if (
    [
      'NoSuchBucket',
      'NoSuchContainer',
      'ContainerNotFound',
      'BucketAlreadyOwnedByYou',
      'NotFound',
      'NoSuchKey',
    ].includes(code) ||
    httpStatus === 404
  ) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'configuration',
      retryable: false,
      httpStatus,
      message,
    });
  }

  if (
    [
      'InvalidAccessKeyId',
      'SignatureDoesNotMatch',
      'AuthenticationFailed',
      'AuthFailure',
      'Unauthorized',
    ].includes(code) ||
    httpStatus === 401
  ) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'authentication',
      retryable: false,
      httpStatus,
      message,
    });
  }

  if (['AccessDenied', 'Forbidden', 'AuthorizationFailure'].includes(code) || httpStatus === 403) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'authorization',
      retryable: false,
      httpStatus,
      message,
    });
  }

  if (['SlowDown', 'TooManyRequests', 'RateLimitExceeded'].includes(code) || httpStatus === 429) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'rate_limit',
      retryable: true,
      httpStatus,
      message,
    });
  }

  if (['QuotaExceeded', 'InsufficientStorage', 'LimitExceededException'].includes(code) || httpStatus === 507) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'quota',
      retryable: false,
      httpStatus,
      message,
    });
  }

  if (httpStatus && httpStatus >= 500) {
    return new StorageAdapterError({
      adapter,
      operation,
      code,
      category: 'transient',
      retryable: true,
      httpStatus,
      message,
    });
  }

  return new StorageAdapterError({
    adapter,
    operation,
    code,
    category: 'unknown',
    retryable: true,
    httpStatus,
    message,
  });
}

export function preflightFailure(adapter: string, error: unknown, operation = 'preflight'): StoragePreflightResult {
  const normalized = normalizeStorageError(error, adapter, operation);
  return {
    adapter,
    writable: false,
    message: normalized.message,
    errorCode: normalized.code,
    errorCategory: normalized.category,
    retryable: normalized.retryable,
  };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/(?<=AccountKey=)[^;]+/gi, '[REDACTED_ACCOUNT_KEY]')
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}
