/**
 * «Скачать копию» of a cloud café (apps/cloud-hub exporter.ts): the café is copied in small steps — this screen
 * repeats the call until the copy is ready, then saves the file. It is the same file the browser trial's
 * «Восстановить из копии» opens, so the café's data can always be taken out of the cloud. Director only.
 */
import { getAuthToken, hubUrl } from '../api.ts';
import { cloudHeaders } from './cloud-cafe.ts';

interface Progress {
  status: 'preparing' | 'ready';
  done: number;
}

function headers(): Record<string, string> {
  const token = getAuthToken();
  return { 'content-type': 'application/json', ...cloudHeaders(), ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function failure(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return new Error(body.error?.message ?? `Ошибка ${res.status}`);
  } catch {
    return new Error(`Ошибка ${res.status}`);
  }
}

/** Makes a fresh copy and saves it on this device; `onProgress` gets 0…1 while the cloud prepares it. */
export async function downloadCloudBackup(onProgress: (done: number) => void): Promise<string> {
  let progress: Progress = { status: 'preparing', done: 0 };
  for (let i = 0; progress.status !== 'ready'; i++) {
    if (i > 2000) throw new Error('Копия готовится слишком долго. Попробуйте ещё раз.');
    let res: Response;
    try {
      res = await fetch(hubUrl('/api/cloud/backup'), { method: 'POST', headers: headers(), body: JSON.stringify({ fresh: i === 0 }) });
    } catch {
      throw new Error('Нет связи с облаком TS. Проверьте интернет и попробуйте ещё раз.');
    }
    if (!res.ok) throw await failure(res);
    progress = (await res.json()) as Progress;
    onProgress(progress.done);
  }
  const res = await fetch(hubUrl('/api/cloud/backup/file'), { headers: headers() });
  if (!res.ok) throw await failure(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'TS-kofeynya.ts-backup.json';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
