import SftpClient from "ssh2-sftp-client";

export interface SftpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  fileName: string;
}

/**
 * Push the feed to CJ's SFTP.
 *
 * CJ requirements this honours:
 *   - files must land in the ROOT directory; a subdirectory is never processed
 *   - the file name must match the one registered in CJ exactly (case sensitive)
 *   - upload under a temp name and rename, so CJ never collects a half-written file
 */
export async function pushToSftp(target: SftpTarget, body: Buffer): Promise<string> {
  const client = new SftpClient();
  const dir = target.remoteDir?.trim() || "/";
  const finalPath = `${dir.replace(/\/+$/, "")}/${target.fileName}`;
  const tempPath = `${finalPath}.uploading`;

  try {
    await client.connect({
      host: target.host,
      port: target.port || 22,
      username: target.username,
      password: target.password,
      readyTimeout: 30_000,
    });

    await client.put(body, tempPath);
    // Some SFTP servers refuse a rename onto an existing path.
    if (await client.exists(finalPath)) {
      await client.delete(finalPath).catch(() => undefined);
    }
    await client.rename(tempPath, finalPath);
    return finalPath;
  } finally {
    await client.end().catch(() => undefined);
  }
}
