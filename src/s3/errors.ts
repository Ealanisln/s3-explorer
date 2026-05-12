// CD-SEC-005: don't leak full AWS SDK messages (ARNs, bucket names, internal paths) to clients.
// Map known error names to generic user-facing Spanish messages; full detail stays in server logs only.
export const SAFE_AWS_ERRORS: Readonly<Record<string, string>> = {
  EndpointBlocked: 'Ese endpoint está bloqueado por política del servidor.',
  MissingCredentials: 'Faltan credenciales de S3.',
  AccessDenied: 'Acceso denegado. Verifica los permisos del IAM para este bucket/objeto.',
  NoSuchBucket: 'El bucket no existe.',
  NoSuchKey: 'El archivo no existe.',
  NoSuchUpload: 'La subida fue cancelada o expiró.',
  BucketAlreadyExists: 'Ya existe un bucket con ese nombre.',
  BucketAlreadyOwnedByYou: 'Ya tienes un bucket con ese nombre.',
  BucketNotEmpty: 'El bucket no está vacío.',
  InvalidAccessKeyId: 'Credenciales inválidas. Verifica access key y secret key.',
  SignatureDoesNotMatch: 'Credenciales inválidas. Verifica access key y secret key.',
  InvalidBucketName: 'Nombre de bucket inválido.',
  InvalidArgument: 'Parámetro inválido.',
  EntityTooLarge: 'Archivo demasiado grande.',
  RequestTimeout: 'Tiempo de espera agotado.',
  ServiceUnavailable: 'El proveedor S3 no está disponible. Reintenta en unos segundos.',
  SlowDown: 'El proveedor S3 está limitando la velocidad. Reintenta en unos segundos.',
  Forbidden: 'Acceso denegado.',
  NotFound: 'Recurso no encontrado.',
};

export interface SanitizedError {
  status: number;
  body: { error: string; message: string; errorId?: string };
}

// Minimal shape we care about — covers stdlib Error, AWS SDK errors, and our own
// status-bearing exceptions like EndpointBlockedError.
export interface ErrorLike {
  status?: number;
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

// When `errorId` is provided, it's included in the response body so the SPA
// can show it to the user and the admin can grep the same ID in server logs.
// The ID itself doesn't leak any actionable info — it's a random 4-byte hex
// generated per-error in wrap().
export function sanitizeError(e: ErrorLike, errorId?: string): SanitizedError {
  const status = e.status || e.$metadata?.httpStatusCode || 500;
  const code = e.name || 'Error';
  const safe = SAFE_AWS_ERRORS[code];
  if (safe) {
    return { status, body: errorId ? { error: code, message: safe, errorId } : { error: code, message: safe } };
  }
  // For unknown errors: status code only, no message detail
  if (status >= 500) {
    return {
      status,
      body: errorId
        ? { error: 'InternalError', message: 'Error interno del servidor.', errorId }
        : { error: 'InternalError', message: 'Error interno del servidor.' },
    };
  }
  return {
    status,
    body: errorId
      ? { error: code, message: 'Operación rechazada.', errorId }
      : { error: code, message: 'Operación rechazada.' },
  };
}
