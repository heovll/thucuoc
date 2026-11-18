// Tải file Excel từ GitHub (repo công khai hoặc riêng tư có token).

/**
 * Nhận các dạng link:
 *  https://github.com/<owner>/<repo>/blob/<branch>/<path>.xlsx
 *  https://github.com/<owner>/<repo>/raw/<branch>/<path>.xlsx
 *  https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>.xlsx
 *  https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/<path>.xlsx
 */
function parseGithubUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error('Link GitHub không hợp lệ.');
  }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.hostname === 'github.com' && parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
    return { owner: parts[0], repo: parts[1], ref: parts[3], path: parts.slice(4).join('/') };
  }
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    if (parts[2] === 'refs' && parts[3] === 'heads' && parts.length >= 6)
      return { owner: parts[0], repo: parts[1], ref: parts[4], path: parts.slice(5).join('/') };
    return { owner: parts[0], repo: parts[1], ref: parts[2], path: parts.slice(3).join('/') };
  }
  throw new Error('Link phải là link file trên github.com (dạng .../blob/<nhánh>/<đường dẫn file>.xlsx).');
}

async function downloadFromGithub(url, token) {
  const { owner, repo, ref, path } = parseGithubUrl(url);
  const encPath = path.split('/').map(encodeURIComponent).join('/');
  let res;
  if (token) {
    // Repo riêng tư: dùng GitHub API với token chỉ có quyền đọc nội dung repo.
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encPath}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github.raw',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'nhac-thu-cuoc',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(60_000),
      }
    );
  } else {
    res = await fetch(
      `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encPath}`,
      { headers: { 'User-Agent': 'nhac-thu-cuoc' }, signal: AbortSignal.timeout(60_000) }
    );
  }
  if (res.status === 404)
    throw new Error('Không tìm thấy file trên GitHub (sai link, sai nhánh, hoặc repo riêng tư mà chưa nhập token).');
  if (res.status === 401 || res.status === 403) throw new Error('GitHub từ chối truy cập – kiểm tra lại token.');
  if (!res.ok) throw new Error(`GitHub trả lỗi ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw new Error('File quá lớn (>30MB).');
  return { buffer: buf, name: path.split('/').pop(), source: `github:${owner}/${repo}@${ref}/${path}` };
}

module.exports = { parseGithubUrl, downloadFromGithub };
