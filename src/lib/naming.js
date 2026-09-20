/**
 * How downloaded files are named and foldered.
 *
 * Shared by the downloader and the Excel export so the "File name" column in
 * the spreadsheet always matches what actually lands on disk.
 */

export const ROOT_FOLDER = 'Instagram Library';

/** Strips anything Windows, macOS or Chrome's downloader would reject. */
export function safeName(part, max = 60) {
  return (
    String(part ?? '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/^\.+|\.+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || 'untitled'
  );
}

export function extensionFor(media) {
  try {
    const match = new URL(media.url).pathname.match(/\.([a-z0-9]{2,4})$/i);
    if (match) return match[1].toLowerCase();
  } catch {}
  return media.kind === 'video' ? 'mp4' : 'jpg';
}

/** YYYY-MM-DD of when the post was published (falls back to when we saw it). */
export function dateStamp(post) {
  const ms = post.takenAt ? post.takenAt * 1000 : post.firstSeen || Date.now();
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'undated';
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export function folderFor(post) {
  return `${ROOT_FOLDER}/${safeName(post.collection || 'Unsorted', 50)}`;
}

export function baseNameFor(post) {
  return `${dateStamp(post)}_${safeName(post.username || 'unknown', 30)}_${safeName(post.shortcode, 20)}`;
}

/** Every file a post will produce, with its full download path. */
export function filesFor(post) {
  const folder = folderFor(post);
  const base = baseNameFor(post);
  const media = Array.isArray(post.media) ? post.media : [];
  return media.map((item, index) => ({
    shortcode: post.shortcode,
    url: item.url,
    filename: `${folder}/${base}${media.length > 1 ? `_${index + 1}` : ''}.${extensionFor(item)}`,
  }));
}
