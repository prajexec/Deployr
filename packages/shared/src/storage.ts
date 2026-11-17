import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getConfig } from './config.js';

let s3ClientInstance: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!s3ClientInstance) {
    const config = getConfig();
    s3ClientInstance = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return s3ClientInstance;
}

export async function ensureBucket(bucketName?: string): Promise<void> {
  const config = getConfig();
  const bucket = bucketName || config.S3_BUCKET;
  const s3 = getS3Client();

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error: any) {
    if (
      error.name === 'NotFound' ||
      error.$metadata?.httpStatusCode === 404 ||
      error.Code === 'NoSuchBucket'
    ) {
      console.log(`[storage] Creating bucket '${bucket}'...`);
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`[storage] Bucket '${bucket}' created.`);
    } else {
      throw error;
    }
  }
}

export async function checkStorageHealth(): Promise<boolean> {
  const s3 = getS3Client();
  const config = getConfig();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    return true;
  } catch (err: any) {
    // If bucket doesn't exist yet, we can try to create or verify client connectivity
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      try {
        await ensureBucket();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
  bucketName?: string
): Promise<void> {
  const config = getConfig();
  const bucket = bucketName || config.S3_BUCKET;
  const s3 = getS3Client();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function getObject(key: string, bucketName?: string) {
  const config = getConfig();
  const bucket = bucketName || config.S3_BUCKET;
  const s3 = getS3Client();

  return await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

export async function deleteDeploymentAssets(
  deploymentId: string,
  bucketName?: string
): Promise<void> {
  const config = getConfig();
  const bucket = bucketName || config.S3_BUCKET;
  const s3 = getS3Client();

  const prefix = `deployments/${deploymentId}/`;
  let continuationToken: string | undefined = undefined;

  do {
    const listRes: any = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (listRes.Contents && listRes.Contents.length > 0) {
      const objectsToDelete = listRes.Contents.map((obj: any) => ({ Key: obj.Key }));
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objectsToDelete },
        })
      );
    }

    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);
}
