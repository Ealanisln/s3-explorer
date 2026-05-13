export function formatSize(b: number | null | undefined): string {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

export interface FileIcon {
  /** FT-badge variant: 'pdf' | 'doc' | 'img' | 'zip' | 'def' */
  cls: string;
  /** Short uppercase mnemonic shown inside the badge (3 chars max). */
  label: string;
}

export function fileIcon(name: string): FileIcon {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'].includes(ext)) {
    return { cls: 'img', label: 'IMG' };
  }
  if (['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'].includes(ext)) {
    return { cls: 'img', label: 'VID' };
  }
  if (ext === 'pdf') return { cls: 'pdf', label: 'PDF' };
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return { cls: 'doc', label: 'DOC' };
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return { cls: 'doc', label: 'XLS' };
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return { cls: 'doc', label: 'PPT' };
  if (['txt', 'md', 'log'].includes(ext)) return { cls: 'doc', label: 'TXT' };
  if (['json', 'xml', 'yml', 'yaml', 'toml'].includes(ext)) return { cls: 'doc', label: 'JSN' };
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)) return { cls: 'def', label: 'WAV' };
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return { cls: 'zip', label: 'ZIP' };
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'php'].includes(ext)) {
    return { cls: 'doc', label: ext.slice(0, 3).toUpperCase() };
  }
  return { cls: 'def', label: ext.slice(0, 3).toUpperCase() || 'FILE' };
}
