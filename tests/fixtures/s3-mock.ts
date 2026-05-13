import { mockClient } from 'aws-sdk-client-mock';
import { S3Client } from '@aws-sdk/client-s3';

export type S3MockClient = ReturnType<typeof mockClient<typeof S3Client>>;

// Mock every S3Client instance globally for the test run. Call once per test
// file (typically in beforeEach so each test starts with a clean mock).
//
// Usage:
//   const s3 = setupS3Mock();
//   s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'foo' }] });
export function setupS3Mock(): S3MockClient {
  const s3 = mockClient(S3Client);
  s3.reset();
  return s3;
}

// Headers that buildClient() reads off the request. The server validates that
// accessKeyId and secretAccessKey are present before instantiating the SDK
// client, so all four must be set for any /api/* request — even when the SDK
// itself is mocked.
export const TEST_S3_HEADERS = {
  'x-s3-endpoint': 'https://test-minio.local',
  'x-s3-region': 'us-east-1',
  'x-s3-access-key': 'AKIATEST',
  'x-s3-secret-key': 'secretTESTvalue',
  'x-s3-path-style': 'true',
} as const;
