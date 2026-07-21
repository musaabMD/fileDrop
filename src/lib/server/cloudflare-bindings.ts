import { getCloudflareContext } from "@opennextjs/cloudflare";

type D1PreparedStatement<T = unknown> = {
  bind: (...values: unknown[]) => D1PreparedStatement<T>;
  first: <R = T>(columnName?: string) => Promise<R | null>;
  all: <R = T>() => Promise<{ results?: R[]; success: boolean; error?: string; meta?: unknown }>;
  run: () => Promise<{ success: boolean; error?: string; meta?: unknown }>;
};

export type FileDropD1Database = {
  prepare: <T = unknown>(query: string) => D1PreparedStatement<T>;
};

type R2PutOptions = {
  httpMetadata?: {
    contentType?: string;
  };
};

export type FileDropR2Object = {
  body: ReadableStream;
  httpMetadata?: {
    contentType?: string;
  };
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type FileDropR2Bucket = {
  get: (key: string) => Promise<FileDropR2Object | null>;
  put: (
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream | Blob,
    options?: R2PutOptions,
  ) => Promise<unknown>;
};

export type FileDropBindings = {
  DB: FileDropD1Database;
  FILES: FileDropR2Bucket;
};

export async function getBindings() {
  const { env } = await getCloudflareContext({ async: true });
  const bindings = env as unknown as Partial<FileDropBindings>;

  if (!bindings.DB) {
    throw new Error("D1 binding DB is not configured.");
  }

  if (!bindings.FILES) {
    throw new Error("R2 binding FILES is not configured.");
  }

  return bindings as FileDropBindings;
}
