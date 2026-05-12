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
  cls: string;
  label: string;
}

export function fileIcon(name: string): FileIcon {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return { cls: 'icon-img', label: '🖼' };
  }
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json', 'xml', 'log'].includes(ext)) {
    return { cls: 'icon-doc', label: ext.slice(0, 3).toUpperCase() };
  }
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return { cls: 'icon-doc', label: '♪' };
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return { cls: 'icon-img', label: '▶' };
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return { cls: '', label: '📦' };
  return { cls: '', label: ext.slice(0, 3).toUpperCase() || '·' };
}
